import { isDeepStrictEqual } from 'node:util'
import { canonicalGraphJson } from '@graphql/contracts/wave25'
import { HarnessExecutionSchema, NativeSessionReferenceSchema, type HarnessExecution, type NativeSessionReference } from '@graphql/contracts'
import { DeviceConnectionIdentitySchema } from '@graphql/contracts/device-identity'
import { commandInputHash } from '@graphql/contracts/command-identity-node'
import { RemoteWorkflowPhysicalReadoutSchema,RemoteWorkflowPhysicalAckSchema, type RemoteWorkflowPhysicalReadout,type RemoteWorkflowPhysicalAck } from '@graphql/contracts/remote-workflow-physical'
import type { AcceptedNodePlacement } from '@graphql/contracts/node-placement'
import type { RemoteOperationReceipt } from '@graphql/contracts/remote-execution'
import type { DeviceEndpoint } from '../../devices/deviceEndpoint.js'
import type { WorkflowOriginalNativeSource } from '../../interactions/workflowNativeCapture.js'
import type { RemoteNativePhysicalVerification, VerifiedRemoteOriginalSource } from '../../placement/remoteNativeSource.js'
import { readAcceptedPlacement, readNativePlacement } from '../../placement/persistence.js'
import { readNativeExecutionBinding } from '../../placement/executionBinding.js'
import { sourceMaterializationDigest } from '../../sources/bindingHash.js'
import { assertGraphTransaction,didGraphTransactionCommit, type GraphTransactionSql } from '../../run-graph/connection.js'
import type { RunOwnership } from '../ownership.js'
import { readReconciledDispatchIntent } from './persistence.js'
import { repeatExecutionIdentity } from '../repeatResolution.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import { remoteWorkflowProcessDigest, remoteWorkflowSourceDigest,remoteWorkflowNativeHistory } from './workflowPhysicalReadout.js'
import { DomainError } from '../../errors.js'

export interface RemoteWorkflowMainLifetime {
  execution: HarnessExecution
  session: NativeSessionReference
  lifetimeGeneration: number
  closureGeneration: string
  lane: { id: string; token: string; connectionGeneration: number; providerId: string | null } | null
  assertCurrent(): void
}
/** Descriptor only: the producer's private WeakMap is the authority. */
export interface PreparedRemoteWorkflowPhysical { readonly kind: 'original-remote-physical' }
interface Prepared {
  readout: RemoteWorkflowPhysicalReadout
  placement: AcceptedNodePlacement
  source: WorkflowOriginalNativeSource
  assertCurrent(): void
  acknowledge(sourceDigest:string):Promise<RemoteWorkflowPhysicalAck>
}
interface Bound extends Prepared { owner: RunOwnership; lifetime: RemoteWorkflowMainLifetime;publications:Set<GraphTransactionSql>;replyPublications:Set<GraphTransactionSql> }
const unavailable = (): never => { throw new DomainError('REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', 'Actual authenticated original native and source evidence is required.', 409) }
function same(left: unknown, right: unknown) { return isDeepStrictEqual(left, right) }
function assertSource(readout: RemoteWorkflowPhysicalReadout, source: WorkflowOriginalNativeSource) {
  const { receipt, session, launch, observation } = readout
  if (!receipt.native || receipt.native.sessionId !== session.nativeSessionId || session.harness !== 'codex'
    || launch.owner !== `execution:${receipt.intent.executionId}` || launch.bootId !== receipt.connection.bootId
    || launch.lifecycle !== 'active' || remoteWorkflowProcessDigest(receipt.connection, receipt.intent, launch) !== receipt.native.processIdentityDigest
    || observation.launchId !== launch.launchId || observation.owner !== launch.owner || observation.bootId !== launch.bootId
    || !same(observation.guardian, launch.guardian) || !same(observation.provider, launch.provider) || !same(observation.boundary, launch.boundary)) return unavailable()
  if (source.type === 'session_created' && !same(source.session, session)) return unavailable()
  if (source.type === 'history' && !same(source.history, readout.history)) return unavailable()
  if (source.type === 'event' && (!readout.history || !readout.history.events.some(event => same({...event,executionId:receipt.intent.executionId}, source.event)))) return unavailable()
  if (receipt.terminal) {
    const terminal = readout.history?.terminalTurn
    if (!readout.closure || observation.lifecycle !== 'closed' || observation.closureEvidence !== 'cgroup_v2_empty'
      || !same(readout.closure.launch, observation) || !readout.closure.ownerClosed
      || receipt.terminal.kind === 'not_started' || (receipt.terminal.artifactDigests?.length ?? 0) !== 0
      || receipt.terminal.closureEvidenceDigest !== commandInputHash({ intent:receipt.intent,native:receipt.native,
        launch,physicalOwnerClosed:true }).slice('sha256:'.length)) return unavailable()
    if (receipt.terminal.result) {
      if (!terminal || terminal.correlationId !== receipt.turnInput?.correlationId || terminal.providerId !== receipt.native.turnId
        || readout.history?.nativeTurnId !== receipt.native.turnId || !same(terminal.result, receipt.terminal.result)
        || !readout.output || !same(readout.output.result, terminal.result)
        || receipt.terminal.resultDigest !== commandInputHash(terminal.result).slice('sha256:'.length)
        || receipt.terminal.kind !== (terminal.result.outcome==='succeeded'?'completed':terminal.result.outcome==='failed'?'failed':'cancelled')) return unavailable()
    } else if(receipt.terminal.kind!=='cancelled'||!receipt.stopFence||readout.output)return unavailable()
  } else {
    if (readout.output || (readout.closure
      ? observation.lifecycle !== 'closed' || observation.closureEvidence !== 'cgroup_v2_empty' || !same(readout.closure.launch,observation)
      : observation.lifecycle !== 'active')) return unavailable()
  }
}
/** Network and real worker observations occur only in prefetch. bind() attaches
 * its opaque result to this exact private original-source object. SQL verification
 * reads retained evidence and original Main rows; it never performs native IO. */
export function createRemoteWorkflowPhysicalVerification(input: {
  endpoint(): Pick<DeviceEndpoint, 'captureRequest' | 'currentBinding'>
}): RemoteNativePhysicalVerification & {
  prefetch(receipt: RemoteOperationReceipt, placement: AcceptedNodePlacement, source: WorkflowOriginalNativeSource, signal?: AbortSignal): Promise<PreparedRemoteWorkflowPhysical>
  bind(original: VerifiedRemoteOriginalSource, prepared: PreparedRemoteWorkflowPhysical, owner: RunOwnership, lifetime: RemoteWorkflowMainLifetime): void
  /** Caller invokes only after durable canonical publication, outside G1. */
  acknowledge(original:VerifiedRemoteOriginalSource):Promise<RemoteWorkflowPhysicalAck>
  /** Requires every original event in this reply to have durably published. */
  acknowledgeReply(original:VerifiedRemoteOriginalSource):Promise<RemoteWorkflowPhysicalAck>
} {
  const prepared = new WeakMap<object, Prepared>(), bound = new WeakMap<object, Bound>()
  return {
    async prefetch(receipt, placement, source, signal) {
      signal?.throwIfAborted()
      if (placement.hostRef.kind !== 'device' || !placement.registration || !receipt.native) return unavailable()
      const endpoint = input.endpoint(), captured = endpoint.captureRequest(placement.hostRef.deviceId, 'execution-v1')
      if (!captured) return unavailable()
      let expiresAt=Date.now()+60_000
      const assertCurrent = () => {
        signal?.throwIfAborted()
        const current = endpoint.currentBinding(placement.hostRef.kind === 'device' ? placement.hostRef.deviceId : '')
        if (expiresAt<=Date.now()||!current || !same(current, captured.binding)
          || !same(DeviceConnectionIdentitySchema.parse({mainId:current.mainId,deviceId:current.deviceId,
            workerInstallationId:current.workerInstallationId,keyRevision:current.keyRevision,authorizationRevision:current.authorizationRevision,
            bootId:current.bootId,connectionGeneration:current.connectionGeneration}), receipt.connection)) return unavailable()
      }
      assertCurrent()
      const reply = await captured.request({ method: 'physical-readout', intent: receipt.intent, placement,
        receiptSequence: receipt.sequence, sourceDigest: remoteWorkflowSourceDigest(source) }, signal ? { signal } : {})
      if (reply.bytes !== undefined) return unavailable()
      const readout = RemoteWorkflowPhysicalReadoutSchema.parse(reply.payload)
      expiresAt=Math.min(expiresAt,Date.parse(readout.expiresAt))
      assertCurrent()
      if (!same(readout.receipt, receipt)) return unavailable()
      assertSource(readout, source)
      const result = Object.freeze({ kind: 'original-remote-physical' as const })
      prepared.set(result, { readout, placement: structuredClone(placement), source: structuredClone(source), assertCurrent,
        acknowledge:async(sourceDigest)=>{
          assertCurrent()
          const reply=await captured.request({method:'physical-ack',intent:receipt.intent,placement,receiptSequence:receipt.sequence,sourceDigest},signal?{signal}:{})
          if(reply.bytes!==undefined)return unavailable()
          const ack=RemoteWorkflowPhysicalAckSchema.parse(reply.payload)
          assertCurrent()
          if(ack.operationId!==receipt.intent.operationId||ack.receiptSequence!==receipt.sequence||ack.sourceDigest!==sourceDigest)return unavailable()
          return ack
        } })
      return result
    },
    bind(original, proof, owner, lifetime) {
      const capture = prepared.get(proof)
      if (!capture || original.verified.receipt.intent.runId !== owner.runId
        || !same(original.verified.receipt, capture.readout.receipt) || !same(original.source, capture.source)
        || original.sourceDigest !== remoteWorkflowSourceDigest(capture.source)
        || lifetime.execution.id !== capture.readout.receipt.intent.executionId || lifetime.execution.runId !== owner.runId
        || !same(lifetime.session, capture.readout.session) || lifetime.lifetimeGeneration < 1
        || !Number.isSafeInteger(lifetime.lifetimeGeneration) || !/^[1-9][0-9]*$/.test(lifetime.closureGeneration)) return unavailable()
      owner.assertOwned(); original.assertCurrent(); capture.assertCurrent(); lifetime.assertCurrent()
      const previous = bound.get(original)
      if (previous) {
        if(previous.owner!==owner||!same(previous.readout,capture.readout)||previous.lifetime.lifetimeGeneration!==lifetime.lifetimeGeneration
          ||previous.lifetime.closureGeneration!==lifetime.closureGeneration||!same(previous.lifetime.session,lifetime.session)
          ||!same(previous.lifetime.lane,lifetime.lane)||!same(repeatExecutionIdentity(previous.lifetime.execution),repeatExecutionIdentity(lifetime.execution)))return unavailable()
        previous.lifetime.assertCurrent();return
      }
      bound.set(original, { ...capture, owner, lifetime,publications:new Set(),replyPublications:new Set() })
    },
    async acknowledge(original) {
      const capture=bound.get(original)
      if(!capture||![...capture.publications].some(didGraphTransactionCommit))return unavailable()
      original.assertCurrent();capture.assertCurrent()
      return capture.acknowledge(original.sourceDigest)
    },
    async acknowledgeReply(original) {
      const capture=bound.get(original)
      if(!capture?.readout.history||![...capture.replyPublications].some(didGraphTransactionCommit))return unavailable()
      original.assertCurrent();capture.assertCurrent()
      return capture.acknowledge(remoteWorkflowSourceDigest({type:'history',history:remoteWorkflowNativeHistory(capture.readout.history)}))
    },
    async assertOriginal(sql: GraphTransactionSql, owner, original) {
      assertGraphTransaction(sql)
      const capture = bound.get(original)
      if (!capture || capture.owner !== owner) return unavailable()
      const { readout, lifetime } = capture, receipt = readout.receipt, intent = receipt.intent
      const check = () => { owner.assertOwned(); original.assertCurrent(); capture.assertCurrent(); lifetime.assertCurrent(); assertSource(readout, original.source) }
      check()
      const current = await readReconciledDispatchIntent(sql, intent.operationId, true)
      const placement = await readAcceptedPlacement(sql, intent.runId, intent.nodeId)
      const rawNative = await readNativePlacement(sql, intent.executionId)
      if (!current || !placement || !rawNative || !same(current, intent) || !same(placement, capture.placement)) return unavailable()
      const native = readNativeExecutionBinding(placement, intent, rawNative)
      if (sourceMaterializationDigest(native.materialization) !== sourceMaterializationDigest(readout.source.record)
        || !same(native.workingTree, readout.source.workingTree) || readout.runtimeLeaf.bindingHash !== native.bindingHash
        || readout.runtimeLeaf.executionId !== intent.executionId || readout.runtimeLeaf.attemptId !== intent.attemptId
        || readout.runtimeLeaf.operationId !== intent.operationId || readout.runtimeLeaf.materializationId !== native.materialization.receipt.materializationId
        || readout.runtimeLeaf.materializationDigest !== native.workingTree.materializationDigest
        || readout.runtimeLeaf.canonicalRuntimeDirectory !== lifetime.execution.runtimeDirectory) return unavailable()
      const origin = (await sql.query<{ connection: unknown }>('select connection from remote_dispatch_origins where operation_id=$1 for share', [intent.operationId])).rows[0]
      if (!origin || !same(DeviceConnectionIdentitySchema.parse(origin.connection), receipt.connection)) return unavailable()
      const executionRow = (await sql.query<{ record: unknown; accepted: boolean }>('select record,accepted from harness_executions where id=$1 and run_id=$2 for share', [intent.executionId, intent.runId])).rows[0]
      const execution = HarnessExecutionSchema.safeParse(executionRow?.record)
      if (!executionRow?.accepted || !execution.success || execution.data.id !== lifetime.execution.id
        || execution.data.agentId !== lifetime.execution.agentId || execution.data.attempt !== intent.technicalAttempt
        || execution.data.workflowNodeId !== intent.nodeId || execution.data.workingDirectory !== native.workingTree.canonicalCwd
        || execution.data.nativeSessionId !== undefined && execution.data.nativeSessionId !== readout.session.nativeSessionId) return unavailable()
      const entry = (await sql.query<{ phase: string; source_id: string | null; source_digest: string | null;
        reservation: { execution: ReturnType<typeof repeatExecutionIdentity>; scope: {runId:string} };
        transition: { phase: string; launchDigest: string | null; reservation: unknown } }>(
        'select phase,source_id,source_digest,reservation,transition from workflow_native_entries where execution_id=$1 and run_id=$2 for share', [intent.executionId, intent.runId])).rows[0]
      if (!entry || entry.phase !== 'entered' || entry.transition?.phase !== 'entered' || !entry.transition.launchDigest || !entry.source_id || !entry.source_digest
        || entry.reservation?.scope?.runId !== intent.runId || !same(entry.reservation.execution, repeatExecutionIdentity(execution.data))
        || !same(entry.transition.reservation,entry.reservation)) return unavailable()
      const sessionRow = (await sql.query<{ reference: unknown }>('select reference from execution_native_sessions where execution_id=$1 for share', [intent.executionId])).rows[0]
      if (sessionRow ? !same(NativeSessionReferenceSchema.parse(sessionRow.reference), readout.session) : original.source.type !== 'session_created') return unavailable()
      const closure = (await sql.query<{ generation: string; expected_reference: unknown; closed: boolean }>(`select generation::text,expected_reference,
        (closed_at is not null or detached_at is not null) as closed from execution_native_closures where execution_id=$1 order by generation desc limit 1 for share`, [intent.executionId])).rows[0]
      if (!closure || closure.generation !== lifetime.closureGeneration || closure.closed
        || closure.expected_reference !== null && !same(closure.expected_reference, readout.session)) return unavailable()
      if (lifetime.lane) {
        const lane = (await sql.query<{ owner_agent_id: string; harness: string; native_session_id: string; generation: string;
          token: string | null; correlation: string | null; provider_id: string | null; held: boolean }>(`select owner_agent_id,harness,native_session_id,
          record->>'connectionGeneration' as generation,record->>'leaseToken' as token,record->>'correlationId' as correlation,
          record->>'currentTurnOrMessageId' as provider_id,coalesce((record->>'leaseExpiresAt')::timestamptz>clock_timestamp(),false) as held
          from native_session_lanes where id=$1 for share`, [lifetime.lane.id])).rows[0]
        if (!lane?.held || lane.owner_agent_id !== execution.data.agentId || lane.harness !== readout.session.harness
          || lane.native_session_id !== readout.session.nativeSessionId || lane.token !== lifetime.lane.token
          || lane.generation !== String(lifetime.lane.connectionGeneration) || lane.correlation !== `execution:${intent.executionId}`
          || receipt.native?.turnId !== undefined && lane.provider_id !== receipt.native.turnId
          || lifetime.lane.providerId !== null && lane.provider_id !== lifetime.lane.providerId) return unavailable()
      } else if (original.source.type === 'history' || original.source.type === 'event') return unavailable()
      check()
      // Publication is acknowledged only after this exact original was retained
      // by the existing canonical writer AND its owning transaction committed.
      const proofs=await sql.query<{record:WorkflowNativeProofRecord}>(`select record from workflow_native_proofs
        where execution_id=$1 and run_id=$2 and record->'original'=$3::jsonb limit 1`, [intent.executionId,intent.runId,canonicalGraphJson(original.source,4*1024*1024)])
      if(proofs.rows.some(row=>row.record.execution.executionId===intent.executionId&&same(row.record.session,readout.session)
        &&same(row.record.original,original.source)))capture.publications.add(sql)
      if(readout.history) {
        const sources:WorkflowOriginalNativeSource[]=readout.history.events.map(event=>({type:'event',event:{...event,executionId:intent.executionId}}))
        const events=await sql.query<{original:WorkflowOriginalNativeSource}>(`select record->'original' as original from workflow_native_proofs
          where execution_id=$1 and run_id=$2 and record->'original'=any($3::jsonb[])`,
          [intent.executionId,intent.runId,sources.map(source=>canonicalGraphJson(source,4*1024*1024))])
        if(sources.every(source=>events.rows.some(row=>same(row.original,source)))&&capture.publications.has(sql))capture.replyPublications.add(sql)
      }
      check()
    },
  }
}
