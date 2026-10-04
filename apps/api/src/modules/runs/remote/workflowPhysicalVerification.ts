import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import type { RemoteNativeIdentity } from '@graphql/contracts/remote-execution'
import { isDeepStrictEqual } from 'node:util'
import { canonicalGraphJson } from '@graphql/contracts/wave25'
import { HarnessExecutionSchema, NativeSessionReferenceSchema, type HarnessExecution, type NativeSessionReference } from '@graphql/contracts'
import { DeviceConnectionIdentitySchema } from '@graphql/contracts/device-identity'
import { commandInputHash } from '@graphql/contracts/command-identity-node'
import { RemoteWorkflowPhysicalReadoutSchema,RemoteWorkflowPhysicalAckSchema, type RemoteWorkflowPhysicalReadout,type RemoteWorkflowPhysicalAck } from '@graphql/contracts/remote-workflow-physical'
import type { AcceptedNodePlacement } from '@graphql/contracts/node-placement'
import type { RemoteOperationReceipt } from '@graphql/contracts/remote-execution'
import type { DeviceEndpoint } from '../../devices/deviceEndpoint.js'
import type { WorkflowOriginalNativeSource, WorkflowNativeCapture } from '../../interactions/workflowNativeCapture.js'
import type { RemoteNativePhysicalVerification, VerifiedRemoteOriginalSource } from '../../placement/remoteNativeSource.js'
import { readAcceptedPlacement, readNativePlacement } from '../../placement/persistence.js'
import { readNativeExecutionBinding } from '../../placement/executionBinding.js'
import { sourceMaterializationDigest } from '../../sources/bindingHash.js'
import { assertGraphTransaction,didGraphTransactionCommit,beforeGraphCommit,poisonGraphTransaction, type GraphTransactionSql } from '../../run-graph/connection.js'
import type { RunOwnership } from '../ownership.js'
import { readReconciledDispatchIntent } from './persistence.js'
import { repeatExecutionIdentity,repeatDigest } from '../repeatResolution.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import { remoteWorkflowProcessDigest, remoteWorkflowSourceDigest,remoteWorkflowNativeHistory } from './workflowPhysicalReadout.js'
import { DomainError } from '../../errors.js'
import { transferContextForBinding } from '../../byte-transfer/carrier.js'
import type { TransferContext } from '@graphql/contracts/byte-transfer'
import { assertRepeatCanonicalReceiptLocked,requireRepeatCanonicalReceiptBeforeCommit } from '../../run-graph/repeatReceipts.js'
import type { WorkflowPhysicalArtifactsPort } from './workflowPhysicalArtifacts.js'
import { readWorkflowNativeEntryLocked,workflowNativeReservation,type WorkflowNativeReservation,type WorkflowNativeEntryRecord } from '../workflowNativeEntry.js'
import { canonicalRepeatEffectReceipt } from '../../run-graph/repeatPublication.js'

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
export interface PassiveRemoteNativeOwner {
  nativeOwner: string; native: RemoteNativeIdentity; binding: Readonly<DeviceSessionBinding>; assertCurrent(): void
}
interface Prepared {
  binding: Readonly<DeviceSessionBinding>
  readout: RemoteWorkflowPhysicalReadout
  placement: AcceptedNodePlacement
  source: WorkflowOriginalNativeSource
  assertCurrent(): void
  acknowledge(sourceDigest:string):Promise<RemoteWorkflowPhysicalAck>
}
interface Bound extends Prepared { owner: RunOwnership; lifetime: RemoteWorkflowMainLifetime;publications:Set<GraphTransactionSql>;replyPublications:Set<GraphTransactionSql>;terminalCapture?:WorkflowNativeCapture }
const unavailable = (reason: string): never => {
  throw new DomainError('REMOTE_NATIVE_PHYSICAL_UNAVAILABLE',
    'Actual authenticated original native and source evidence is required.', 409, { reason })
}
function same(left: unknown, right: unknown) { return isDeepStrictEqual(left, right) }
function assertSource(readout: RemoteWorkflowPhysicalReadout, source: WorkflowOriginalNativeSource) {
  const { receipt, session, launch, observation } = readout
  if (!receipt.native || receipt.native.sessionId !== session.nativeSessionId || session.harness !== 'codex'
    || launch.owner !== `execution:${receipt.intent.executionId}` || launch.bootId !== receipt.connection.bootId
    || launch.lifecycle !== 'active' || remoteWorkflowProcessDigest(receipt.connection, receipt.intent, launch) !== receipt.native.processIdentityDigest
    || observation.launchId !== launch.launchId || observation.owner !== launch.owner || observation.bootId !== launch.bootId
    || !same(observation.guardian, launch.guardian) || !same(observation.provider, launch.provider) || !same(observation.boundary, launch.boundary)) return unavailable('process_identity')
  if (source.type === 'session_created' && !same(source.session, session)) return unavailable('session_identity')
  if (source.type === 'history' && !same(source.history, readout.history)) return unavailable('history_identity')
  if (source.type === 'event' && (!readout.history || !readout.history.events.some(event => same({...event,executionId:receipt.intent.executionId}, source.event)))) return unavailable('event_identity')
  if (receipt.terminal) {
    const terminal = readout.history?.terminalTurn
    if (!readout.closure || observation.lifecycle !== 'closed' || observation.closureEvidence !== 'cgroup_v2_empty'
      || !same(readout.closure.launch, observation) || !readout.closure.ownerClosed
      || receipt.terminal.kind === 'not_started'
      || receipt.terminal.closureEvidenceDigest !== commandInputHash({ intent:receipt.intent,native:receipt.native,
        launch,physicalOwnerClosed:true }).slice('sha256:'.length)) return unavailable('terminal_closure')
    if (receipt.terminal.result) {
      if (!terminal || terminal.correlationId !== receipt.turnInput?.correlationId || terminal.providerId !== receipt.native.turnId
        || readout.history?.nativeTurnId !== receipt.native.turnId || !same(terminal.result, receipt.terminal.result)
        || !readout.output || !same(readout.output.result, terminal.result)
        || receipt.terminal.resultDigest !== commandInputHash(terminal.result).slice('sha256:'.length)
        || receipt.terminal.kind !== (terminal.result.outcome==='succeeded'?'completed':terminal.result.outcome==='failed'?'failed':'cancelled')) return unavailable('terminal_result')
      if(readout.output.kind==='text-only'&&(receipt.terminal.artifactDigests?.length??0)!==0)return unavailable('text_artifacts')
    } else if(receipt.terminal.kind!=='cancelled'||!receipt.stopFence||readout.output||(receipt.terminal.artifactDigests?.length??0)!==0)return unavailable('cancellation_closure')
  } else {
    if (readout.output || (readout.closure
      ? observation.lifecycle !== 'closed' || observation.closureEvidence !== 'cgroup_v2_empty' || !same(readout.closure.launch,observation)
      : observation.lifecycle !== 'active')) return unavailable('running_process')
  }
}
/** Network and real worker observations occur only in prefetch. bind() attaches
 * its opaque result to this exact private original-source object. SQL verification
 * reads retained evidence and original Main rows; it never performs native IO. */
export function createRemoteWorkflowPhysicalVerification(input: {
  endpoint(): Pick<DeviceEndpoint, 'captureRequest' | 'currentBinding'>
  artifacts?: WorkflowPhysicalArtifactsPort
}): RemoteNativePhysicalVerification & {
  passiveNativeOwner(original: VerifiedRemoteOriginalSource): PassiveRemoteNativeOwner | undefined
  prefetch(receipt: RemoteOperationReceipt, placement: AcceptedNodePlacement, source: WorkflowOriginalNativeSource, signal?: AbortSignal): Promise<PreparedRemoteWorkflowPhysical>
  bind(original: VerifiedRemoteOriginalSource, prepared: PreparedRemoteWorkflowPhysical, owner: RunOwnership, lifetime: RemoteWorkflowMainLifetime): void
  /** Caller invokes only after durable canonical publication, outside G1. */
  acknowledge(original:VerifiedRemoteOriginalSource):Promise<RemoteWorkflowPhysicalAck>
  /** Requires every original event in this reply to have durably published. */
  acknowledgeReply(original:VerifiedRemoteOriginalSource):Promise<RemoteWorkflowPhysicalAck>
  artifactTerminalContext(sql:GraphTransactionSql,owner:RunOwnership,original:VerifiedRemoteOriginalSource,capture:WorkflowNativeCapture,proof:WorkflowNativeProofRecord):Promise<TransferContext>
  assertArtifactTerminal(sql:GraphTransactionSql,owner:RunOwnership,capture:WorkflowNativeCapture,proof:WorkflowNativeProofRecord):Promise<void>
  assertAdoptedArtifacts(sql:GraphTransactionSql,owner:RunOwnership,original:VerifiedRemoteOriginalSource):Promise<void>
} {
  const prepared = new WeakMap<object, Prepared>(), bound = new WeakMap<object, Bound>()
  const terminals=new WeakMap<WorkflowNativeCapture,{original:VerifiedRemoteOriginalSource;capture:Bound;proof:WorkflowNativeProofRecord;sql:GraphTransactionSql}>()
  return {
    async prefetch(receipt, placement, source, signal) {
      signal?.throwIfAborted()
      if (placement.hostRef.kind !== 'device' || !placement.registration || !receipt.native) return unavailable('remote_placement')
      const endpoint = input.endpoint(), captured = endpoint.captureRequest(placement.hostRef.deviceId, 'execution-v1')
      if (!captured) return unavailable('device_connection')
      let expiresAt=Date.now()+60_000
      const assertCurrent = () => {
        signal?.throwIfAborted()
        const current = endpoint.currentBinding(placement.hostRef.kind === 'device' ? placement.hostRef.deviceId : '')
        if (expiresAt<=Date.now()||!current || !same(current, captured.binding)
          || !same(DeviceConnectionIdentitySchema.parse({mainId:current.mainId,deviceId:current.deviceId,
            workerInstallationId:current.workerInstallationId,keyRevision:current.keyRevision,authorizationRevision:current.authorizationRevision,
            bootId:current.bootId,connectionGeneration:current.connectionGeneration}), receipt.connection)) return unavailable('connection_expired')
      }
      assertCurrent()
      const reply = await captured.request({ method: 'physical-readout', intent: receipt.intent, placement,
        receiptSequence: receipt.sequence, sourceDigest: remoteWorkflowSourceDigest(source) }, signal ? { signal } : {})
      if (reply.bytes !== undefined) return unavailable('readout_binary')
      const readout = RemoteWorkflowPhysicalReadoutSchema.parse(reply.payload)
      expiresAt=Math.min(expiresAt,Date.parse(readout.expiresAt))
      assertCurrent()
      if (!same(readout.receipt, receipt)) return unavailable('readout_receipt')
      assertSource(readout, source)
      const result = Object.freeze({ kind: 'original-remote-physical' as const })
      prepared.set(result, { binding: Object.freeze(structuredClone(captured.binding)), readout, placement: structuredClone(placement), source: structuredClone(source), assertCurrent,
        acknowledge:async(sourceDigest)=>{
          assertCurrent()
          const reply=await captured.request({method:'physical-ack',intent:receipt.intent,placement,receiptSequence:receipt.sequence,sourceDigest},signal?{signal}:{})
          if(reply.bytes!==undefined)return unavailable('ack_binary')
          const ack=RemoteWorkflowPhysicalAckSchema.parse(reply.payload)
          assertCurrent()
          if(ack.operationId!==receipt.intent.operationId||ack.receiptSequence!==receipt.sequence||ack.sourceDigest!==sourceDigest)return unavailable('ack_identity')
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
        || !Number.isSafeInteger(lifetime.lifetimeGeneration) || !/^[1-9][0-9]*$/.test(lifetime.closureGeneration)) return unavailable('main_lifetime')
      owner.assertOwned(); original.assertCurrent(); capture.assertCurrent(); lifetime.assertCurrent()
      const previous = bound.get(original)
      if (previous) {
        if(previous.owner!==owner||!same(previous.readout,capture.readout)||previous.lifetime.lifetimeGeneration!==lifetime.lifetimeGeneration
          ||previous.lifetime.closureGeneration!==lifetime.closureGeneration||!same(previous.lifetime.session,lifetime.session)
          ||!same(previous.lifetime.lane,lifetime.lane)||!same(repeatExecutionIdentity(previous.lifetime.execution),repeatExecutionIdentity(lifetime.execution)))return unavailable('main_lifetime_changed')
        previous.lifetime.assertCurrent();return
      }
      bound.set(original, { ...capture, owner, lifetime:{...lifetime,execution:structuredClone(lifetime.execution),session:structuredClone(lifetime.session),
        lane:lifetime.lane?structuredClone(lifetime.lane):null},publications:new Set(),replyPublications:new Set() })
    },
    passiveNativeOwner(original) {
      const capture = bound.get(original)
      if (!capture || !capture.lifetime.lane || !capture.readout.receipt.native || capture.readout.receipt.terminal
        || capture.readout.observation.lifecycle !== 'active' || capture.readout.closure) return undefined
      const assertCurrent = () => {
        if (bound.get(original) !== capture) return unavailable('passive_owner')
        capture.owner.assertOwned(); original.assertCurrent(); capture.assertCurrent(); capture.lifetime.assertCurrent()
        assertSource(capture.readout, original.source)
      }
      try { assertCurrent() } catch { return undefined }
      return { nativeOwner: capture.readout.launch.owner, native: structuredClone(capture.readout.receipt.native),
        binding: Object.freeze(structuredClone(capture.binding)), assertCurrent }
    },
    async acknowledge(original) {
      const capture=bound.get(original)
      if(!capture||![...capture.publications].some(didGraphTransactionCommit))return unavailable('uncommitted_publication')
      original.assertCurrent();capture.assertCurrent()
      return capture.acknowledge(original.sourceDigest)
    },
    async acknowledgeReply(original) {
      const capture=bound.get(original)
      if(!capture?.readout.history||![...capture.replyPublications].some(didGraphTransactionCommit))return unavailable('uncommitted_history')
      original.assertCurrent();capture.assertCurrent()
      return capture.acknowledge(remoteWorkflowSourceDigest({type:'history',history:remoteWorkflowNativeHistory(capture.readout.history)}))
    },
    async artifactTerminalContext(sql,owner,original,capture,proof) {
      assertGraphTransaction(sql)
      try {
        const actual=bound.get(original)
        if(!actual||actual.owner!==owner||!same(actual.lifetime.session,capture.session)
          ||!same(repeatExecutionIdentity(actual.lifetime.execution),repeatExecutionIdentity(capture.execution))
          ||actual.lifetime.lifetimeGeneration!==capture.lifetimeGeneration||actual.lifetime.closureGeneration!==capture.closureGeneration
          ||!same(actual.lifetime.lane,capture.lane)
          ||actual.readout.output?.kind!=='published-artifacts'||!actual.readout.closure
          ||capture.source.type!=='history'||proof.original.type!=='history'
          ||capture.owner!==owner||!same(capture.source,original.source)||!same(proof.original,capture.source)
          ||!same(proof.execution,repeatExecutionIdentity(capture.execution))||!same(proof.session,capture.session)
          ||!same(proof.lane,capture.lane)||proof.lifetimeGeneration!==capture.lifetimeGeneration
          ||proof.closureGeneration!==capture.closureGeneration||proof.commandId!==`execution:${capture.execution.id}`
          ||proof.scope.runId!==owner.runId||proof.ref.nodeId!==capture.execution.workflowNodeId
          ||proof.inputDigest!==repeatDigest(capture.execution.input))return unavailable('terminal_capture')
        // Establish this capability while the genuine private producer still owns the capture.
        actual.assertCurrent();capture.assertCurrent()
        await assertBound(sql,owner,original,false)
        const previous=terminals.get(capture)
        if(previous&&(!same(previous.proof,proof)||previous.original!==original||previous.capture!==actual))return unavailable('terminal_capture_changed')
        const retained={original,capture:actual,proof:structuredClone(proof),sql}
        await assertTerminal(sql,owner,capture,retained,false)
        terminals.set(capture,retained)
        actual.terminalCapture=capture
        requireRepeatCanonicalReceiptBeforeCommit(sql,{scope:proof.scope,evidence:{sourceKind:'native_event',sourceId:proof.proofId,sourceRevision:'1'},
          sourceDigest:repeatDigest(proof,4*1024*1024),effect:null})
        beforeGraphCommit(sql,()=>assertTerminal(sql,owner,capture,retained,false))
        return transferContextForBinding(actual.binding)
      }catch(error){poisonGraphTransaction(sql);throw error}
    },
    async assertArtifactTerminal(sql,owner,capture,proof) {
      assertGraphTransaction(sql)
      try {
        const retained=terminals.get(capture)
        if(!retained||!didGraphTransactionCommit(retained.sql)||!same(retained.proof,proof))return unavailable('uncommitted_terminal')
        await assertTerminal(sql,owner,capture,retained,true)
        beforeGraphCommit(sql,()=>assertTerminal(sql,owner,capture,retained,true))
      }catch(error){poisonGraphTransaction(sql);throw error}
    },
    async assertAdoptedArtifacts(sql,owner,original) {
      assertGraphTransaction(sql)
      try {
        const capture=bound.get(original)
        const terminal=capture?.terminalCapture&&terminals.get(capture.terminalCapture)
        if(!capture?.terminalCapture||!terminal||terminal.original!==original||!didGraphTransactionCommit(terminal.sql)
          ||![...capture.publications].some(didGraphTransactionCommit)||!input.artifacts)return unavailable('artifact_publication')
        await assertTerminal(sql,owner,capture.terminalCapture,terminal,true)
        await input.artifacts.assertAdopted(sql,capture.readout,capture.binding)
        beforeGraphCommit(sql,async()=>{await assertTerminal(sql,owner,capture.terminalCapture!,terminal,true);await input.artifacts!.assertAdopted(sql,capture.readout,capture.binding)})
      }catch(error){poisonGraphTransaction(sql);throw error}
    },
    assertOriginal: (sql: GraphTransactionSql, owner: RunOwnership, original: VerifiedRemoteOriginalSource) => assertBound(sql, owner, original, false),
  }
  async function assertTerminal(sql:GraphTransactionSql,owner:RunOwnership,captured:WorkflowNativeCapture,
    retained:NonNullable<ReturnType<typeof terminals.get>>,committed:boolean) {
    try {
      if(retained.capture.owner!==owner||captured.owner!==owner||bound.get(retained.original)!==retained.capture)return unavailable('terminal_owner')
      if(!committed)retained.capture.assertCurrent()
      const proof=retained.proof
      const fence=await owner.readOneShotFence(sql)
      if(fence.ownerId!==proof.ownerId||fence.fence!==proof.ownerFence)return unavailable('terminal_run_owner')
      const row=(await sql.query<{record:WorkflowNativeProofRecord;source_digest:string}>(
        'select record,source_digest from workflow_native_proofs where proof_id=$1 and run_id=$2 and execution_id=$3 for share',
        [proof.proofId,proof.scope.runId,captured.execution.id])).rows[0]
      if(!row||!same(row.record,proof)||row.source_digest!==repeatDigest(proof,4*1024*1024))return unavailable('terminal_proof')
      await assertBound(sql,owner,retained.original,true)
      if(committed){
        const execution=(await sql.query<{record:unknown}>('select record from harness_executions where id=$1 and run_id=$2 for share',
          [captured.execution.id,owner.runId])).rows[0]
        const saved=HarnessExecutionSchema.safeParse(execution?.record)
        if(!saved.success||saved.data.state!=='completed'||!same(saved.data.result,retained.capture.readout.output?.result))return unavailable('terminal_execution')
        await assertRepeatCanonicalReceiptLocked(sql,{scope:proof.scope,
          evidence:{sourceKind:'native_event',sourceId:proof.proofId,sourceRevision:'1'},sourceDigest:row.source_digest,effect:null})
      }
    }catch(error){poisonGraphTransaction(sql);throw error}
  }
  async function assertBound(sql: GraphTransactionSql, owner: RunOwnership, original: VerifiedRemoteOriginalSource, retained: boolean) {
      assertGraphTransaction(sql)
      const capture = bound.get(original)
      if (!capture || capture.owner !== owner) return unavailable('unbound_owner')
      const { readout, lifetime } = capture, receipt = readout.receipt, intent = receipt.intent
      const published=readout.output?.kind==='published-artifacts'
      const check = () => {
        owner.assertOwned()
        if(retained){
          if(!published||!readout.closure||!same(input.endpoint().currentBinding(capture.binding.deviceId),capture.binding)
            ||!same(original.verified.receipt,receipt)||!same(original.source,capture.source)
            ||original.sourceDigest!==remoteWorkflowSourceDigest(capture.source))return unavailable('published_capture')
        }else{original.assertCurrent();capture.assertCurrent();lifetime.assertCurrent()}
        assertSource(readout,original.source)
      }
      check()
      const current = await readReconciledDispatchIntent(sql, intent.operationId, true)
      const placement = await readAcceptedPlacement(sql, intent.runId, intent.nodeId)
      const rawNative = await readNativePlacement(sql, intent.executionId)
      if (!current || !placement || !rawNative || !same(current, intent) || !same(placement, capture.placement)) return unavailable('dispatch_binding')
      const native = readNativeExecutionBinding(placement, intent, rawNative)
      if (sourceMaterializationDigest(native.materialization) !== sourceMaterializationDigest(readout.source.record)
        || !same(native.workingTree, readout.source.workingTree) || readout.runtimeLeaf.bindingHash !== native.bindingHash
        || readout.runtimeLeaf.executionId !== intent.executionId || readout.runtimeLeaf.attemptId !== intent.attemptId
        || readout.runtimeLeaf.operationId !== intent.operationId || readout.runtimeLeaf.materializationId !== native.materialization.receipt.materializationId
        || readout.runtimeLeaf.materializationDigest !== native.workingTree.materializationDigest
        || readout.runtimeLeaf.canonicalRuntimeDirectory !== lifetime.execution.runtimeDirectory) return unavailable('runtime_binding')
      const origin = (await sql.query<{ connection: unknown }>('select connection from remote_dispatch_origins where operation_id=$1 for share', [intent.operationId])).rows[0]
      if (!origin || !same(DeviceConnectionIdentitySchema.parse(origin.connection), receipt.connection)) return unavailable('dispatch_connection')
      // accepted marks terminal result acceptance, after physical proof/adoption.
      const executionRow = (await sql.query<{ record: unknown }>('select record from harness_executions where id=$1 and run_id=$2 for share', [intent.executionId, intent.runId])).rows[0]
      const execution = HarnessExecutionSchema.safeParse(executionRow?.record)
      if (!execution.success || execution.data.id !== lifetime.execution.id
        || execution.data.agentId !== lifetime.execution.agentId || execution.data.attempt !== intent.technicalAttempt
        || execution.data.workflowNodeId !== intent.nodeId || execution.data.workingDirectory !== native.workingTree.canonicalCwd
        || execution.data.nativeSessionId !== undefined && execution.data.nativeSessionId !== readout.session.nativeSessionId) return unavailable('execution_binding')
      if(published){
        if(execution.data.runId!==lifetime.execution.runId||!same(repeatExecutionIdentity(execution.data),repeatExecutionIdentity(lifetime.execution))
          ||execution.data.runtimeDirectory!==lifetime.execution.runtimeDirectory||!same(execution.data.input,lifetime.execution.input)
          ||execution.data.createdAt!==lifetime.execution.createdAt
          ||execution.data.result!==undefined&&!same(execution.data.result,readout.output?.result))return unavailable('published_execution')
        const saved=(await sql.query<{receipt:unknown}>('select receipt from remote_execution_receipts where operation_id=$1 for share',[intent.operationId])).rows[0]
        if(!saved||!same(saved.receipt,receipt))return unavailable('published_receipt')
      }
      const entry = (await sql.query<{ phase: string; source_id: string | null; source_digest: string | null;
        reservation: WorkflowNativeReservation; transition: WorkflowNativeEntryRecord }>(
        'select phase,source_id,source_digest,reservation,transition from workflow_native_entries where execution_id=$1 and run_id=$2 for share', [intent.executionId, intent.runId])).rows[0]
      if (!entry || entry.phase !== 'entered' || entry.transition?.phase !== 'entered' || !entry.transition.launchDigest || !entry.source_id || !entry.source_digest
        || entry.reservation?.scope?.runId !== intent.runId || !same(entry.reservation.execution, repeatExecutionIdentity(execution.data))
        || !same(entry.transition.reservation,entry.reservation)) return unavailable('native_entry')
      if(published){
        const reservation=workflowNativeReservation(entry.reservation.scope,entry.reservation.ref,execution.data,repeatDigest(execution.data.input,4*1024*1024))
        const admitted=await readWorkflowNativeEntryLocked(sql,reservation)
        if(admitted.phase!=='entered'||!same(admitted.transition,entry.transition)||admitted.source_id!==entry.source_id
          ||admitted.source_digest!==entry.source_digest||entry.source_digest!==repeatDigest(entry.transition,8*1024*1024)
          ||(reservation.ref.occurrence?.occurrenceId??null)!==intent.occurrenceId
          ||(reservation.ref.occurrence?.occurrenceIndex??0)!==intent.occurrenceIndex)return unavailable('published_native_entry')
        await assertRepeatCanonicalReceiptLocked(sql,{scope:reservation.scope,
          evidence:{sourceKind:'execution',sourceId:entry.source_id,sourceRevision:'1'},sourceDigest:entry.source_digest,effect:null})
        const effects=await sql.query<{payload_digest:string}>(
          "select payload_digest from run_repeat_effects where run_id=$1 and effect_kind='input.bind' and entity_id=$2 for share",
          [intent.runId,intent.executionId])
        if(effects.rows.length!==1||!effects.rows[0])return unavailable('input_binding')
        const inputReceipt=canonicalRepeatEffectReceipt(reservation.scope,{kind:'input.bind',entityId:intent.executionId,digest:effects.rows[0].payload_digest})
        await assertRepeatCanonicalReceiptLocked(sql,inputReceipt)
        requireRepeatCanonicalReceiptBeforeCommit(sql,inputReceipt)
      }
      const sessionRow = (await sql.query<{ reference: unknown }>('select reference from execution_native_sessions where execution_id=$1 for share', [intent.executionId])).rows[0]
      if (sessionRow ? !same(NativeSessionReferenceSchema.parse(sessionRow.reference), readout.session) : original.source.type !== 'session_created') return unavailable('stored_session')
      const closure = (await sql.query<{ generation: string; expected_reference: unknown; closed_reference:unknown; closed: boolean; detached:boolean;
        closed_without_session:boolean; execution_identity:unknown }>(`select generation::text,expected_reference,closed_reference,execution_identity,closed_without_session,
        closed_at is not null as closed,detached_at is not null as detached from execution_native_closures where execution_id=$1 order by generation desc limit 1 for share`, [intent.executionId])).rows[0]
      if (!closure || closure.generation !== lifetime.closureGeneration || closure.detached
        || closure.expected_reference !== null && !same(closure.expected_reference, readout.session)) return unavailable('closure_generation')
      if(closure.closed){
        const e=execution.data
        const identity={id:e.id,runId:e.runId,workflowNodeId:e.workflowNodeId,agentId:e.agentId,
          agentConfigurationVersionId:e.agentConfigurationVersionId,attempt:e.attempt,
          ...(e.workingDirectory?{workingDirectory:e.workingDirectory}:{}),...(e.runtimeDirectory?{runtimeDirectory:e.runtimeDirectory}:{})}
        if(!published||!readout.closure||closure.closed_without_session||!same(closure.closed_reference,readout.session)
          ||!same(closure.execution_identity,identity))return unavailable('stored_closure')
      }
      if (lifetime.lane) {
        const lane = (await sql.query<{ owner_agent_id: string; harness: string; native_session_id: string; generation: string;
          token: string | null; correlation: string | null; provider_id: string | null; held: boolean }>(`select owner_agent_id,harness,native_session_id,
          record->>'connectionGeneration' as generation,record->>'leaseToken' as token,record->>'correlationId' as correlation,
          record->>'currentTurnOrMessageId' as provider_id,coalesce((record->>'leaseExpiresAt')::timestamptz>clock_timestamp(),false) as held
          from native_session_lanes where id=$1 for share`, [lifetime.lane.id])).rows[0]
        if (!lane || (!lane.held&&!(retained&&closure.closed&&lane.token===null)) || lane.owner_agent_id !== execution.data.agentId || lane.harness !== readout.session.harness
          || lane.native_session_id !== readout.session.nativeSessionId || lane.token !== lifetime.lane.token&&!(retained&&closure.closed&&lane.token===null)
          || lane.generation !== String(lifetime.lane.connectionGeneration) || lane.correlation !== `execution:${intent.executionId}`
          || receipt.native?.turnId !== undefined && lane.provider_id !== receipt.native.turnId
          || lifetime.lane.providerId !== null && lane.provider_id !== lifetime.lane.providerId) return unavailable('writer_lane')
      } else if (original.source.type === 'history' || original.source.type === 'event') return unavailable('missing_writer_lane')
      if(published){if(!input.artifacts)return unavailable('artifact_verifier');await input.artifacts.assertPublications(sql,readout,capture.binding)}
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
  }
}
