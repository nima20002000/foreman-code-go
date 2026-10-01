import type pg from 'pg'
import { DurableInteractionSchema, type HarnessExecution } from '@graphql/contracts'
import { sameWorkflowValue, canonicalGraphJson } from '@graphql/contracts/wave25'
import { RemoteOwnerControlSchema } from '@graphql/contracts/remote-execution'
import type { DeviceConnectionIdentity } from '@graphql/contracts/device-identity'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { AgentPlacementProducer } from './agentProducer.js'
import type { NativeManagerResolutionContext } from '../interactions/runtimePorts.js'
import type { RunOwnership } from '../runs/ownership.js'
import { readAcceptedPlacement, readDispatchIntent, readNativePlacement } from './persistence.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { readNativeExecutionBinding } from './executionBinding.js'
import type { AcceptedExecutionBinding } from './nativeComposition.js'
import { interactionConnection } from '../interactions/connection.js'
import { assertRemoteExecutionAuthority } from './executionAuthority.js'
import { VerifiedRemoteEvidence } from '../runs/remote/resultBridge.js'
import { remoteNativeManager, type MainWorkerCarrier } from './workerCarrier.js'
import { OwnedRemoteReceiptCommit, reserveRemoteDispatchOrigin } from './remoteReceiptCommit.js'
import { createRemoteNativeSourceChannel, assertRemoteNativeSourceLocked, type RemoteNativeSourceEvidence, type VerifiedRemoteOriginalSource } from './remoteNativeSource.js'
import { createRemoteWorkflowPhysicalVerification, type PreparedRemoteWorkflowPhysical } from '../runs/remote/workflowPhysicalVerification.js'
import { remoteWorkflowSourceDigest } from '../runs/remote/workflowPhysicalReadout.js'
import type { WorkflowOriginalNativeSource, WorkflowNativeCapture, WorkflowNativeCaptureInput } from '../interactions/workflowNativeCapture.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'

/** One Main owner and its actual authenticated worker sources. Allocation is
 * IO-free; preparation/prefetch runs before the existing canonical transaction. */
export function createProductionRemoteWorkflow(input: {
  pool: pg.Pool
  locations: WorkspaceLocationService
  endpoint(): DeviceEndpoint
  producer(): AgentPlacementProducer | undefined
  execution(id: string): Promise<HarnessExecution | undefined>
}) {
  const bindings = new Map<string, AcceptedExecutionBinding | null>()
  const channel = createRemoteNativeSourceChannel()
  const physical = createRemoteWorkflowPhysicalVerification({ endpoint: input.endpoint })
  const acknowledgments = new Set<VerifiedRemoteOriginalSource>()
  const companions = new WeakMap<WorkflowNativeCapture, RemoteNativeSourceEvidence>()
  const latest = new Map<string, string>()
  const retained = new Map<string, Map<string, { source: WorkflowOriginalNativeSource; prepared: PreparedRemoteWorkflowPhysical; evidence?: RemoteNativeSourceEvidence; acknowledged?: boolean }>>()
  const requireProducer = () => {
    const producer = input.producer()
    if (!producer) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual placement producer is unavailable.', 503)
    return producer
  }
  const authority = (sql: GraphTransactionSql, binding: AcceptedExecutionBinding, connection: DeviceConnectionIdentity, action: 'start' | 'read' | 'control') =>
    assertRemoteExecutionAuthority(sql, input.locations, { version: 1, intent: binding.intent, placement: binding.placement, action }, connection, requireProducer())
  const carrier: MainWorkerCarrier = { capture(deviceId) {
    const endpoint = input.endpoint(), captured = endpoint.captureRequest(deviceId, 'execution-v1')
    if (!captured) throw new DomainError('REMOTE_DISPATCH_UNAVAILABLE', 'The actual authenticated execution carrier is unavailable.', 503)
    const { mainId, workerInstallationId, bootId, keyRevision, authorizationRevision, connectionGeneration } = captured.binding
    return { identity: { mainId, deviceId, workerInstallationId, bootId, keyRevision, authorizationRevision, connectionGeneration },
      request(namespace, payload, options) {
        if (namespace !== 'execution-v1') throw new DomainError('REMOTE_BINDING_CONFLICT', 'The captured native carrier cannot change namespace.', 409)
        return captured.request(payload, options)
      } }
  } }
  const prepare = async (executionId: string): Promise<AcceptedExecutionBinding | null> => {
    const execution = await input.execution(executionId)
    if (!execution) throw new DomainError('WORKER_EXECUTION_NOT_FOUND', 'The actual execution is unavailable.', 409)
    const sql = interactionConnection.getStore() ?? input.pool
    const original = await readDispatchIntent(sql, executionId)
    const placement = await readAcceptedPlacement(sql, execution.runId, execution.workflowNodeId)
    if (!!original !== !!placement) throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The actual placed execution has no exact dispatch.', 409)
    let binding: AcceptedExecutionBinding | null = null
    if (original && placement) {
      const intent = await readReconciledDispatchIntent(sql, original.operationId)
      const rawNative = await readNativePlacement(sql, executionId)
      if (!intent || !rawNative) throw new DomainError('PLACEMENT_PREPARATION_REQUIRED', 'The original materialized execution binding is required.', 409)
      const executionPlacement = readNativeExecutionBinding(placement, intent, rawNative)
      if (execution.workingDirectory !== executionPlacement.workingTree.canonicalCwd || intent.runId !== execution.runId
        || intent.nodeId !== execution.workflowNodeId || intent.technicalAttempt !== execution.attempt) throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The original native execution directory or attempt changed.', 409)
      binding = { intent, placement, executionPlacement }
    }
    if (bindings.has(executionId) && !sameWorkflowValue(bindings.get(executionId), binding)) throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The original native placement cannot change after preparation.', 409)
    bindings.set(executionId, binding)
    return binding
  }
  const sourceKey = (source: WorkflowOriginalNativeSource) => remoteWorkflowSourceDigest(source)
  return {
    prepare,
    binding(executionId: string) { return bindings.get(executionId) },
    async prepareContext(context: NativeManagerResolutionContext): Promise<NativeManagerResolutionContext> {
      const binding = await prepare(context.executionId)
      return binding ? { ...context, acceptedPlacement: binding.placement } : context
    },
    isRemote(executionId: string) { return bindings.get(executionId)?.placement.hostRef.kind === 'device' },
    manager(context: NativeManagerResolutionContext, getOwner: () => RunOwnership | undefined) {
      const binding = bindings.get(context.executionId)
      if (!binding || binding.placement.hostRef.kind !== 'device') return undefined
      const requireOwner = () => {
        const owner = getOwner()
        if (!owner || owner.runId !== binding.intent.runId) throw new DomainError('REMOTE_RUN_OWNER_CONFLICT', 'The original native Run owner is required.', 409)
        owner.assertOwned(); return owner
      }
      const verifiedReceipts = new Map<string, { verified: VerifiedRemoteEvidence; assertCurrent(): void }>()
      return remoteNativeManager(context, binding, { carrier,
        beforePrepare: (intent, _placement, connection) => {
          const owner = requireOwner()
          return owner.oneShotConnection().transaction(sql => reserveRemoteDispatchOrigin(sql, owner, intent, connection,
            { assertCurrent: (sql, current, pin, authenticated) => authority(sql, { intent: current, placement: pin }, authenticated, 'start') }))
        },
        commit: (receipt, authenticated) => {
          const owner = requireOwner()
          const assertCurrent = () => { requireOwner(); const current = input.endpoint().currentBinding(authenticated.deviceId)
            if (!current || current.mainId !== authenticated.mainId || current.workerInstallationId !== authenticated.workerInstallationId
              || current.bootId !== authenticated.bootId || current.connectionGeneration !== authenticated.connectionGeneration
              || current.keyRevision !== authenticated.keyRevision || current.authorizationRevision !== authenticated.authorizationRevision)
              throw new DomainError('REMOTE_CONNECTION_CONFLICT', 'The original authenticated native response connection changed.', 409) }
          return new OwnedRemoteReceiptCommit(owner, receipt, authenticated, {
            assertCurrent: (sql, intent, placement, connection) => authority(sql, { intent, placement }, connection, 'read'),
            async publishNative(_sql, _owner, verified) {
              // Receipt handling cannot mint the coordinator's not-yet-created
              // Main session/lane. Only retain the authenticated original source.
              const key = canonicalGraphJson(receipt)
              if (!verifiedReceipts.has(key) && verifiedReceipts.size >= 32) verifiedReceipts.delete(verifiedReceipts.keys().next().value!)
              verifiedReceipts.set(key, { verified, assertCurrent })
            },
          })
        },
        observeOriginalSource: async (receipt, source) => {
          const verified = verifiedReceipts.get(canonicalGraphJson(receipt))
          if (!verified) throw new DomainError('REMOTE_OBSERVATION_NOT_AUTHENTICATED', 'Original native source requires its authenticated committed receipt.', 403)
          verified.assertCurrent()
          const prepared = await physical.prefetch(receipt, binding.placement, source)
          verified.assertCurrent()
          channel.observe(verified.verified, source, verified.assertCurrent)
          const entries = retained.get(receipt.intent.executionId) ?? new Map()
          const key = sourceKey(source)
          if (!entries.has(key) && entries.size >= 1024) throw new DomainError('REMOTE_NATIVE_SOURCE_BACKPRESSURE', 'The original remote source window is full.', 503)
          for (const [oldKey, old] of entries) if (oldKey !== key && (old.acknowledged || source.type === 'history' && old.source.type === 'history' && !old.evidence)) entries.delete(oldKey)
          entries.set(key, { source, prepared })
          retained.set(receipt.intent.executionId, entries)
          latest.set(receipt.intent.executionId, key)
        },
        controlFor: async command => {
          if (interactionConnection.getStore()) throw new DomainError('REMOTE_CONTROL_TRANSACTION_UNAVAILABLE', 'Remote native response delivery requires an admitted effect outside the Main delivery transaction.', 409)
          const owner = requireOwner()
          return owner.oneShotConnection().transaction(async sql => {
            await owner.readOneShotFence(sql)
            let commandId: string, action: { kind: 'stop' } | { kind: 'respond'; interactionId: string; interactionRevision: string; nativeInteractionId: string; response: unknown }
            if (command.kind === 'stop') {
              const cleanup = (await sql.query<{ requested_at: Date }>('select requested_at from run_cleanup_intents where run_id=$1 and pending for share', [owner.runId])).rows[0]
              if (!cleanup) throw new DomainError('REMOTE_CONTROL_UNAVAILABLE', 'The original accepted Run cleanup intent is required for remote Stop.', 409)
              commandId = `stop:${binding.intent.operationId}:${cleanup.requested_at.toISOString()}`; action = { kind: 'stop' }
            } else {
              const rows = await sql.query<{ record: unknown }>('select record from durable_interactions where execution_id=$1 and native_session_id=$2 and native_request_id=$3 for share', [binding.intent.executionId, command.native.sessionId, command.nativeRequestId])
              const interaction = rows.rows.length === 1 ? DurableInteractionSchema.parse(rows.rows[0]!.record) : undefined
              const selected = interaction?.responseOptions.find(option => option.optionId === interaction.selectedOptionId)
              if (!interaction || !selected || interaction.status === 'pending' || !sameWorkflowValue(selected, command.option)
                || interaction.revision < 1 || interaction.runId !== owner.runId) throw new DomainError('REMOTE_CONTROL_UNAVAILABLE', 'The actual committed exact native response decision is required.', 409)
              commandId = `respond:${interaction.id}:${interaction.revision}`
              action = { kind: 'respond', interactionId: interaction.id, interactionRevision: String(interaction.revision), nativeInteractionId: interaction.nativeRequestId, response: selected }
            }
            return RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1, commandId,
              operationId: binding.intent.operationId, attemptId: binding.intent.attemptId, executionId: binding.intent.executionId,
              bindingHash: binding.intent.bindingHash, owner: binding.intent.owner, native: command.native, action })
          })
        },
      })
    },
    capture(inputCapture: WorkflowNativeCaptureInput, capture: WorkflowNativeCapture) {
      const binding = bindings.get(capture.execution.id)
      if (binding?.placement.hostRef.kind !== 'device') return
      const entries = retained.get(capture.execution.id)
      const entry = capture.source.type === 'boundary' ? entries?.get(latest.get(capture.execution.id) ?? '') : entries?.get(sourceKey(capture.source))
      if (!entry || !capture.closureGeneration) throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The authenticated original remote source is unavailable at the actual native lifetime boundary.', 409)
      if (!entry.evidence) {
        entry.evidence = channel.capture(capture.execution.id, entry.source)
        const original = channel.verify.read(entry.evidence)
        physical.bind(original, entry.prepared, inputCapture.owner, { execution: capture.execution, session: capture.session,
          lifetimeGeneration: capture.lifetimeGeneration, closureGeneration: capture.closureGeneration, lane: capture.lane,
          assertCurrent: capture.assertCurrent })
      }
      companions.set(capture, entry.evidence)
    },
    async afterCommit(capture: WorkflowNativeCapture) {
      const evidence = companions.get(capture)
      if (!evidence) return
      acknowledgments.add(channel.verify.read(evidence))
      // This method is called only after the original repository transaction
      // returns COMMIT. ACK failure retains metadata; it cannot undo a result.
      for (const original of [...acknowledgments].slice(0, 32)) {
        try {
          await physical.acknowledge(original)
          try { await physical.acknowledgeReply(original) }
          catch (error) { if (!(error instanceof DomainError) || error.code !== 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE') throw error }
          acknowledgments.delete(original)
          const entries = retained.get(original.verified.receipt.intent.executionId)
          const entry = entries?.get(original.sourceDigest)
          if (entry) entry.acknowledged = true
          if (latest.get(original.verified.receipt.intent.executionId) !== original.sourceDigest) entries?.delete(original.sourceDigest)
        } catch { /* Same original selector remains available for a later metadata retry. */ }
      }
    },
    async assertPhysical(sql: GraphTransactionSql, owner: RunOwnership, capture: WorkflowNativeCapture) {
      const placement = await readAcceptedPlacement(sql, capture.execution.runId, capture.execution.workflowNodeId)
      if (placement?.hostRef.kind !== 'device') return
      const evidence = companions.get(capture)
      if (!evidence) throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'A local native capture cannot authorize a remote placement.', 409)
      const original = channel.verify.read(evidence)
      await assertRemoteNativeSourceLocked(sql, owner, capture.execution, original.source, evidence, channel.verify, physical)
    },
  }
}
