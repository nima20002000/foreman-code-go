import { isDeepStrictEqual as same } from 'node:util'
import { AgentConfigurationVersionSchema, DurableInteractionSchema, HarnessExecutionSchema } from '@graphql/contracts'
import { WORKER_NATIVE_OUTPUT_TOOL_NAMES, nativeOutputToolArguments,
  type WorkerNativeOutputCommand } from '@graphql/contracts/worker-native-output'
import { RemoteNativeHistorySchema } from '@graphql/contracts/remote-workflow-physical'
import type { FileQuery } from '../../files/repository.js'
import { DomainError } from '../../errors.js'
import type { NativeOutputCallCapture } from '../../harnesses/port.js'
import { nativeOpenCodeMcpToolName } from '../../harnesses/openCodePermissionPolicy.js'
import { usesOpenCodeNativeAuto } from '../../harnesses/opencodeNativeAuto.js'
import { matchingDeliveryEvidence } from '../../interactions/delivery.js'
import { repeatDigest, repeatExecutionIdentity } from '../repeatResolution.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import { openCodeWorkflowOutputPolicy } from './localWorkflowOutputPolicy.js'

const denied = (): never => {
  throw new DomainError('WORKFLOW_OUTPUT_PERMISSION_DENIED', 'The original native output call is not authorized.', 403)
}

/** Recheck the captured native call and its original approval within each file mutation transaction. */
export async function assertOpenCodeNativeOutputCall(sql: FileQuery, capture: NativeOutputCallCapture,
  input: { executionId: string; command: WorkerNativeOutputCommand }): Promise<void> {
  capture.assertCurrent()
  const row = (await sql.query<{ execution: unknown; configuration: unknown; workspace_id: string;
    workflow_id: string; workflow_version_id: string }>(
    `select e.record as execution,c.record as configuration,r.workspace_id,r.workflow_id,r.workflow_version_id
     from harness_executions e join runs r on r.id=e.run_id
     join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId' and c.agent_id=e.agent_id
     where e.id=$1 for share of e,r,c`, [input.executionId])).rows[0]
  if (!row) return denied()
  const execution = HarnessExecutionSchema.parse(row.execution)
  const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
  const original = capture.descriptor
  const toolName = WORKER_NATIVE_OUTPUT_TOOL_NAMES[input.command.operation]
  if (configuration.harness.harness !== 'opencode' || execution.id !== input.executionId
    || configuration.id !== execution.agentConfigurationVersionId || configuration.agentId !== execution.agentId
    || configuration.workspaceId !== row.workspace_id
    || original.nativeSessionId !== execution.nativeSessionId || original.toolName !== toolName
    || original.inputDigest !== repeatDigest(nativeOutputToolArguments(input.command), 4 * 1024 * 1024)) return denied()
  const savedPolicy = openCodeWorkflowOutputPolicy(configuration.harness, input.command.operation)
  if (savedPolicy === 'deny' || capture.effectivePolicy === 'deny') return denied()
  if (savedPolicy === 'allow' && capture.effectivePolicy === 'allow') {
    capture.assertCurrent()
    return
  }
  const nativeTool = nativeOpenCodeMcpToolName(toolName)
  const automatic = capture.nativeAutoApproval
  if (usesOpenCodeNativeAuto(configuration.harness) && automatic?.reply === 'once'
    && automatic.nativeSessionId === original.nativeSessionId && automatic.permission === nativeTool
    && automatic.assistantMessageId === original.assistantMessageId && automatic.callId === original.callId
    && same(automatic.patterns, ['*']) && automatic.nativeRequestId) {
    capture.assertCurrent()
    return
  }
  const approvals = (await sql.query<{ interaction: unknown; proof: WorkflowNativeProofRecord;
    source_digest: string; evidence: unknown }>(
    `select i.record as interaction,p.record as proof,p.source_digest,a.evidence
     from durable_interactions i
     join workflow_native_proofs p on p.proof_id=i.approval_native_request_proof_id
       and p.run_id=i.run_id and p.execution_id=i.execution_id
     join run_graph_sources s on s.run_id=p.run_id and s.source_kind='native_event'
       and s.source_id=p.proof_id and s.source_revision=1 and s.source_digest=p.source_digest
     join interaction_delivery_attempts a on a.interaction_id=i.id and a.state='delivered'
     where i.execution_id=$1 and i.run_id=$2 and i.status='delivered'
       and i.record->>'deliveryState'='delivered' and i.record->>'nativeSessionId'=$3
       and i.record#>>'{request,permission}'=$4
       and (i.record#>>'{request,tool,callID}'=$5 or i.record->>'selectedSemantic'='provider_scoped_allow')
     for share of i,p,s,a`,
    [execution.id, execution.runId, original.nativeSessionId, nativeTool, original.callId])).rows
  for (const approval of approvals) {
    const interaction = DurableInteractionSchema.parse(approval.interaction)
    const proof = approval.proof
    if (interaction.workspaceId !== row.workspace_id || interaction.workflowId !== row.workflow_id
      || interaction.requestingAgentId !== execution.agentId || interaction.harness !== 'opencode'
      || interaction.nativeRequestType !== 'permission.asked'
      || proof.scope.runId !== execution.runId || proof.scope.workspaceId !== row.workspace_id
      || proof.scope.workflowId !== row.workflow_id || proof.scope.workflowVersionId !== row.workflow_version_id
      || proof.ref.nodeId !== execution.workflowNodeId || proof.commandId !== `execution:${execution.id}`
      || proof.inputDigest !== repeatDigest(execution.input)
      || !same(proof.execution, repeatExecutionIdentity(execution)) || proof.original.type !== 'history'
      || proof.session.harness !== 'opencode' || proof.session.nativeSessionId !== original.nativeSessionId
      || proof.lane?.providerId !== original.rootTurnId
      || approval.source_digest !== repeatDigest(proof, 4 * 1024 * 1024)) continue
    const pending = proof.original.history.pendingInteractions.find(item =>
      item.turn.nativeRequestId === interaction.nativeRequestId)
    if (!pending || !same(pending.request, interaction.request) || pending.turn.nativeTurnId !== original.rootTurnId
      || !same(pending.responseOptions, interaction.responseOptions) || pending.nativeRequestType !== interaction.nativeRequestType
      || !same(pending.session, proof.session)) continue
    const response = RemoteNativeHistorySchema.shape.responseDeliveries.safeParse([approval.evidence])
    if (!response.success || !response.data || !matchingDeliveryEvidence(interaction, proof.session, {
      events: [], pendingInteractions: [], responseDeliveries: response.data,
    })) continue
    const request = interaction.request as { tool?: { messageID?: string; callID?: string }; always?: string[] }
    const once = interaction.selectedSemantic === 'approve_once'
      && request.tool?.messageID === original.assistantMessageId && request.tool.callID === original.callId
    const instance = interaction.selectedSemantic === 'provider_scoped_allow' && same(request.always, ['*'])
    if (once || instance) {
      capture.assertCurrent()
      return
    }
  }
  throw new DomainError('WORKFLOW_OUTPUT_APPROVAL_PENDING',
    'The original native approval has not been recorded as delivered yet.', 409)
}
