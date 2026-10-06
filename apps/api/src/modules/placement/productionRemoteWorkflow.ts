import { NativeSessionReferenceSchema } from '@foreman-code/contracts'
import { RemoteOperationStatusSchema } from '@foreman-code/contracts/remote-execution'
import { readRemoteReceiptResponse } from '../runs/remote/installedWorkflowResponsePages.js'
import type { CapturedRemoteTelemetryNativeOwner } from '../resource-telemetry/productionAuthority.js'
import type pg from 'pg'
import type { HarnessExecution } from '@foreman-code/contracts'
import { sameWorkflowValue, canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { DeviceConnectionIdentitySchema, type DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
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
import { didGraphTransactionCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import type { WorkflowNativeProofRecord } from '../runs/workflowNativeProof.js'
import type { WorkflowPhysicalArtifactsPort } from '../runs/remote/workflowPhysicalArtifacts.js'
import { DomainError } from '../errors.js'
import { admitRemoteOwnerControl, authorizeReservedRemoteResponse,
  readAdmittedRemoteOwnerControl } from '../runs/remote/ownerControlAdmission.js'
import { readOriginalInteractionDeliveryClaim } from '../interactions/originalDeliveryClaim.js'
import type { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { transferContextForBinding } from '../byte-transfer/carrier.js'
import { assertRemoteReviewerReceipt } from './remoteReviewerAuthority.js'
import type { CapturedReviewNativeSource } from '../interactions/reviewNativeCapture.js'

/** One Main owner and its actual authenticated worker sources. Allocation is
 * IO-free; preparation/prefetch runs before the existing canonical transaction. */
export function createProductionRemoteWorkflow(input: {
  pool: pg.Pool
  locations: WorkspaceLocationService
  endpoint(): DeviceEndpoint
  producer(): AgentPlacementProducer | undefined
  execution(id: string): Promise<HarnessExecution | undefined>
  artifacts?: WorkflowPhysicalArtifactsPort
  workerExecution?: WorkerExecutionPolicy
  preparationTimeoutMs?: number
}) {
  const bindings = new Map<string, AcceptedExecutionBinding | null>()
  const channel = createRemoteNativeSourceChannel()
  const physical = createRemoteWorkflowPhysicalVerification({ endpoint: input.endpoint,
    ...(input.artifacts ? { artifacts: input.artifacts } : {}) })
  const acknowledgments = new Set<VerifiedRemoteOriginalSource>()
  const companions = new WeakMap<WorkflowNativeCapture, RemoteNativeSourceEvidence>()
  const reviewCompanions = new WeakMap<CapturedReviewNativeSource, RemoteNativeSourceEvidence>()
  const reviewAcknowledgments = new Map<string, Map<VerifiedRemoteOriginalSource, GraphTransactionSql>>()
  const artifactTerminals = new WeakMap<WorkflowNativeCapture, VerifiedRemoteOriginalSource>()
  const latest = new Map<string, string>()
  const retained = new Map<string, Map<string, { source: WorkflowOriginalNativeSource; prepared: PreparedRemoteWorkflowPhysical; evidence?: RemoteNativeSourceEvidence; acknowledgment?: 'sent' | 'obsolete'; capture?: WorkflowNativeCapture }>>()
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
    async confirmClosedExecution(executionId: string, signal: AbortSignal, owner: RunOwnership): Promise<boolean> {
      const binding = await prepare(executionId)
      if (!binding || binding.placement.hostRef.kind !== 'device') return false
      const captured = input.endpoint().captureRequest(binding.placement.hostRef.deviceId, 'execution-v1')
      if (!captured) return false
      const reply = await captured.request({ method: 'status', intent: binding.intent,
        placement: binding.placement }, { signal })
      if (reply.bytes !== undefined) throw new DomainError('REMOTE_CLOSURE_INVALID', 'Closure readback cannot contain binary data.', 409)
      const raw = await readRemoteReceiptResponse(reply.payload, binding.intent, async continuation => {
        const next = await captured.request({ method: 'receipt-continuation', intent: binding.intent,
          placement: binding.placement, ...continuation }, { signal })
        return next.payload
      }, signal)
      const status = RemoteOperationStatusSchema.parse(raw)
      if (status.status !== 'known' || !sameWorkflowValue(status.receipt.intent, binding.intent)
        || !status.receipt.native || !status.receipt.terminal) return false
      const row = (await input.pool.query<{ reference: unknown }>(
        'select reference from execution_native_sessions where execution_id=$1', [executionId])).rows[0]
      if (!row) return false
      const session = NativeSessionReferenceSchema.parse(row.reference)
      const original = await physical.prefetch(status.receipt, binding.placement, { type: 'boundary' }, signal)
      if (!physical.confirmedClosed(original, session)) return false
      const { mainId, deviceId, workerInstallationId, bootId, keyRevision, authorizationRevision,
        connectionGeneration } = captured.binding
      const authenticated = DeviceConnectionIdentitySchema.parse({ mainId, deviceId, workerInstallationId,
        bootId, keyRevision, authorizationRevision, connectionGeneration })
      const committed = await VerifiedRemoteEvidence.commit(status.receipt, authenticated,
        new OwnedRemoteReceiptCommit(owner, status.receipt, authenticated, {
          async assertCurrent(sql, intent, placement, connection) {
            await authority(sql, { intent, placement }, connection, 'read')
            if (!physical.confirmedClosed(original, session)) throw new DomainError(
              'REMOTE_CLOSURE_INVALID', 'The original physical closure changed during recovery.', 409)
          },
          async publishNative() {
            if (!physical.confirmedClosed(original, session)) throw new DomainError(
              'REMOTE_CLOSURE_INVALID', 'The original physical closure changed during publication.', 409)
          },
        }))
      if (committed === 'rejected') throw new DomainError('REMOTE_CLOSURE_RECEIPT_REJECTED',
        'The original closure receipt was rejected by its canonical owner.', 409)
      return true
    },
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
        ...(input.preparationTimeoutMs ? { preparationTimeoutMs: input.preparationTimeoutMs } : {}),
        ...(input.workerExecution ? { workerExecution: input.workerExecution } : {}),
        beforePrepare: (intent, _placement, connection) => {
          const owner = requireOwner()
          return owner.oneShotConnection().transaction(sql => reserveRemoteDispatchOrigin(sql, owner, intent, connection,
            { assertCurrent: async (sql, current, pin, authenticated) => {
              await authority(sql, { intent: current, placement: pin }, authenticated, 'start')
            } }))
        },
        commit: (receipt, authenticated) => {
          const owner = requireOwner()
          const assertCurrent = () => { requireOwner(); const current = input.endpoint().currentBinding(authenticated.deviceId)
            if (!current || current.mainId !== authenticated.mainId || current.workerInstallationId !== authenticated.workerInstallationId
              || current.bootId !== authenticated.bootId || current.connectionGeneration !== authenticated.connectionGeneration
              || current.keyRevision !== authenticated.keyRevision || current.authorizationRevision !== authenticated.authorizationRevision)
              throw new DomainError('REMOTE_CONNECTION_CONFLICT', 'The original authenticated native response connection changed.', 409) }
          return new OwnedRemoteReceiptCommit(owner, receipt, authenticated, {
            async assertCurrent(sql, intent, placement, connection) {
              await authority(sql, { intent, placement }, connection, 'read')
              await assertRemoteReviewerReceipt(sql, receipt)
            },
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
          for (const [oldKey, old] of entries) if (oldKey !== key && (old.acknowledgment || source.type === 'history' && old.source.type === 'history' && !old.evidence)) entries.delete(oldKey)
          entries.set(key, { source, prepared })
          retained.set(receipt.intent.executionId, entries)
          latest.set(receipt.intent.executionId, key)
        },
        controlFor: async command => {
          if (interactionConnection.getStore()) throw new DomainError('REMOTE_CONTROL_TRANSACTION_UNAVAILABLE', 'Remote native response delivery requires an admitted effect outside the Main delivery transaction.', 409)
          const owner = requireOwner()
          return owner.oneShotConnection().transaction(sql => admitRemoteOwnerControl(sql, owner, binding, command, readOriginalInteractionDeliveryClaim()))
        },
        readResponseControl: async () => {
          const claim = readOriginalInteractionDeliveryClaim()
          if (!claim) return undefined
          const owner = requireOwner()
          return owner.oneShotConnection().transaction(sql => readAdmittedRemoteOwnerControl(sql, owner, binding, claim))
        },
        authorizeResponseRetry: async command => {
          const claim = readOriginalInteractionDeliveryClaim()
          if (!claim || interactionConnection.getStore()) {
            throw new DomainError('REMOTE_CONTROL_ORIGINAL_CLAIM_REQUIRED', 'Response recovery requires its active delivery claim.', 409)
          }
          const owner = requireOwner()
          await owner.oneShotConnection().transaction(sql => authorizeReservedRemoteResponse(sql, owner, binding, claim, command))
        },
      })
    },
    captureReview(capture: CapturedReviewNativeSource) {
      if (bindings.get(capture.execution.id)?.placement.hostRef.kind !== 'device') return
      if (!capture.owner) throw new DomainError('REMOTE_RUN_OWNER_CONFLICT', 'The original reviewer Run owner is required.', 409)
      let source: WorkflowOriginalNativeSource = { type: 'boundary' }
      if (capture.source.type === 'event') source = { type: 'event', event: { ...capture.source.event, executionId: capture.execution.id } }
      if (capture.source.type === 'history') source = { type: 'history', history: capture.source.history }
      const entry = retained.get(capture.execution.id)?.get(sourceKey(source))
      if (!entry) throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The authenticated review source is unavailable.', 409)
      const evidence = channel.capture(capture.execution.id, source)
      entry.evidence = evidence
      physical.bind(channel.verify.read(evidence), entry.prepared, capture.owner, {
        execution: capture.execution, session: capture.session, lifetimeGeneration: capture.lifetimeGeneration,
        closureGeneration: capture.closureGeneration, lane: capture.lane,
        review: { jobId: capture.job.id, correlationId: capture.job.correlationId }, assertCurrent: capture.assertCurrent,
      })
      reviewCompanions.set(capture, evidence)
    },
    async assertReviewPhysical(sql: GraphTransactionSql, capture: CapturedReviewNativeSource) {
      const evidence = reviewCompanions.get(capture)
      if (!capture.owner || !evidence) throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The original review physical source is unavailable.', 409)
      await physical.assertOriginal(sql, capture.owner, channel.verify.read(evidence))
      const pending = reviewAcknowledgments.get(capture.execution.id) ?? new Map()
      pending.set(channel.verify.read(evidence), sql)
      reviewAcknowledgments.set(capture.execution.id, pending)
    },
    async afterReviewCommit(executionId: string) {
      const pending = reviewAcknowledgments.get(executionId)
      if (!pending) return
      let attempts = 0
      for (const [original, sql] of [...pending]) {
        if (attempts >= 32) break
        pending.delete(original)
        if (!didGraphTransactionCommit(sql)) continue
        try {
          await physical.acknowledge(original)
          retained.get(executionId)?.delete(original.sourceDigest)
        } catch (error) {
          if (error instanceof DomainError && error.code === 'REMOTE_NATIVE_ACK_OBSOLETE') {
            retained.get(executionId)?.delete(original.sourceDigest)
            continue
          }
          pending.set(original, sql)
        }
        attempts++
      }
      if (!pending.size) reviewAcknowledgments.delete(executionId)
    },
    capture(inputCapture: WorkflowNativeCaptureInput, capture: WorkflowNativeCapture) {
      const binding = bindings.get(capture.execution.id)
      if (binding?.placement.hostRef.kind !== 'device') return
      const entries = retained.get(capture.execution.id)
      const entry = entries?.get(sourceKey(capture.source))
      if (!entry || !capture.closureGeneration) throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The authenticated original remote source is unavailable at the actual native lifetime boundary.', 409)
      if (!entry.evidence) {
        entry.evidence = channel.capture(capture.execution.id, entry.source)
        const original = channel.verify.read(entry.evidence)
        physical.bind(original, entry.prepared, inputCapture.owner, { execution: capture.execution, session: capture.session,
          lifetimeGeneration: capture.lifetimeGeneration, closureGeneration: capture.closureGeneration, lane: capture.lane,
          assertCurrent: capture.assertCurrent })
      }
      entry.capture = capture
      companions.set(capture, entry.evidence)
    },
    async artifactTerminalContext(sql: GraphTransactionSql, owner: RunOwnership, capture: WorkflowNativeCapture, proof: WorkflowNativeProofRecord) {
      const evidence = companions.get(capture)
      if (!evidence) throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The original artifact terminal has no authenticated physical companion.', 409)
      const original = channel.verify.read(evidence)
      const context = await physical.artifactTerminalContext(sql, owner, original, capture, proof)
      artifactTerminals.set(capture, original)
      return context
    },
    assertArtifactTerminal(sql: GraphTransactionSql, owner: RunOwnership, capture: WorkflowNativeCapture, proof: WorkflowNativeProofRecord) {
      return physical.assertArtifactTerminal(sql, owner, capture, proof)
    },
    assertAdoptedArtifacts(sql: GraphTransactionSql, owner: RunOwnership, capture: WorkflowNativeCapture) {
      const original = artifactTerminals.get(capture)
      if (!original) throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The original artifact terminal companion is unavailable.', 409)
      return physical.assertAdoptedArtifacts(sql, owner, original)
    },
    fileTransferContext(capture: WorkflowNativeCapture) {
      if (bindings.get(capture.execution.id)?.placement.hostRef.kind !== 'device') return undefined
      const evidence = companions.get(capture)
      const original = evidence && channel.verify.read(evidence)
      if (!original) throw new DomainError('REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', 'The original physical file publisher is unavailable.', 409)
      const captured = physical.passiveNativeOwner(original)
      if (!captured) return undefined // Closed native observations cannot admit a live file publisher.
      capture.assertCurrent(); captured.assertCurrent()
      return transferContextForBinding(captured.binding)
    },
    getRemoteNativeOwners(): readonly CapturedRemoteTelemetryNativeOwner[] {
      const owners: CapturedRemoteTelemetryNativeOwner[] = []
      for (const [executionId, entries] of retained) {
        const entry = entries.get(latest.get(executionId) ?? '')
        const capture = entry?.capture
        if (!entry?.evidence || !capture?.lane) continue
        let physicalOwner: ReturnType<typeof physical.passiveNativeOwner>
        try { physicalOwner = physical.passiveNativeOwner(channel.verify.read(entry.evidence)) } catch { continue }
        if (!physicalOwner) continue
        const assertCurrent = () => {
          if (retained.get(executionId)?.get(latest.get(executionId) ?? '') !== entry || entry.capture !== capture)
            throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The original remote telemetry lifetime changed.', 409)
          capture.assertCurrent(); physicalOwner.assertCurrent()
        }
        try { assertCurrent() } catch { continue }
        owners.push({ execution: structuredClone(capture.execution), session: structuredClone(capture.session),
          writer: { id: capture.lane.id, token: capture.lane.token, connectionGeneration: capture.lane.connectionGeneration },
          ...physicalOwner, assertCurrent })
      }
      return owners
    },
    async afterCommit(capture: WorkflowNativeCapture) {
      const evidence = companions.get(capture)
      if (!evidence) return
      acknowledgments.add(channel.verify.read(evidence))
      // Obsolete observations do not consume the network retry budget.
      let attempts = 0
      for (const original of [...acknowledgments]) {
        if (attempts >= 32) break
        acknowledgments.delete(original)
        const executionId = original.verified.receipt.intent.executionId
        const entries = retained.get(executionId)
        const entry = entries?.get(original.sourceDigest)
        try {
          await physical.acknowledge(original)
          try { await physical.acknowledgeReply(original) }
          catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'
              || error.details?.reason !== 'uncommitted_history') throw error
          }
          if (entry) entry.acknowledgment = 'sent'
        } catch (error) {
          if (error instanceof DomainError && error.code === 'REMOTE_NATIVE_ACK_OBSOLETE') {
            if (entry) entry.acknowledgment = 'obsolete'
            if (latest.get(executionId) !== original.sourceDigest) entries?.delete(original.sourceDigest)
            continue
          }
          // Move a transient failure behind observations that have not had a turn.
          acknowledgments.add(original)
        }
        attempts++
        if (entry?.acknowledgment === 'sent' && latest.get(executionId) !== original.sourceDigest) {
          entries?.delete(original.sourceDigest)
        }
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
