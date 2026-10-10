import { GraphIdSchema, RunActivityPublicSchema,
  type RunActivityPublic, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { repeatId } from './repeatResolution.js'
import { safeNodeName, nativeToolTitle } from './nativeAction.js'
import { nativeActivityStatus } from './nativeActivityStatus.js'
import { claudeConversationActivity } from '../harnesses/claudeSdk/conversationActivity.js'
import { codexUnsupportedInteractionMessage } from '@foreman-code/contracts'
import { JobOrdinaryVerificationSuiteSchema } from '@foreman-code/contracts/job-verification'

export interface ActivityReadRow {
  sequence: string; source: string; kind: string; occurred_at: Date;
  harness_execution_id: string | null;
  execution_node_id: string | null; execution_agent_id: string | null;
  execution_attempt: number | null; work_activation_id: string | null;
  job_execution_id?: string | null; job_attempt_id?: string | null; job_operation_id?: string | null;
  node_execution_id?: string | null; job_definition_id?: string | null;
  ci_ticket_id?: string | null; ci_execution_id?: string | null;
  ci_attempt_id?: string | null; ci_operation_id?: string | null;
  job_definition_revision?: number | null; job_definition_version_id?: string | null;
  result_outcome: string | null;
  safe_payload: Record<string, unknown>; native: Record<string, unknown> | null;
}

const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const id = (value: unknown): string | undefined => GraphIdSchema.safeParse(value).success ? value as string : undefined
const count = (value: unknown): number | undefined => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0 ? value : undefined

function toolLabel(native: Record<string, unknown>): string | undefined {
  const item = string(native.itemType), part = string(native.partTool)
  if (item === 'commandExecution' && native.commandName) {
    return nativeToolTitle(item, undefined, string(native.commandName))
  }
  if ((item === 'mcpToolCall' || item === 'dynamicToolCall') && native.toolName) {
    return nativeToolTitle(item, string(native.toolName))
  }
  if (item === 'commandExecution' || part === 'bash') return 'Command action'
  if (item === 'fileChange' || ['write','edit','apply_patch','multiedit'].includes(part ?? '')) return 'File change'
  if (item === 'webSearch' || ['websearch','webfetch','codesearch'].includes(part ?? '')) return 'Web search'
  if (item === 'mcpToolCall' || part?.startsWith('foreman-code_') || part?.startsWith('foreman_code_') || part?.startsWith('graphql_') || part?.startsWith('graphql-app_')) return 'MCP tool action'
  if (item === 'collabAgentToolCall' || part === 'task') return 'Subagent action'
  if (part === 'read') return 'File read'
  if (part === 'grep' || part === 'glob' || part === 'list') return 'File search'
  return undefined
}

function toolStatus(native: Record<string, unknown>): RunActivityPublic['status'] {
  const item = nativeActivityStatus(string(native.itemStatus))
  const part = nativeActivityStatus(string(native.partStatus))
  if (item === 'canceled' || part === 'canceled') return 'canceled'
  if (native.itemError === true || item === 'failed' || part === 'failed') return 'failed'
  if (native.type === 'item.completed' || item === 'completed' || part === 'completed') return 'completed'
  if (item === 'unknown' || part === 'unknown') return 'unknown'
  if (item === 'pending' || part === 'pending') return 'pending'
  if (native.type === 'item.started' || item === 'running' || part === 'running') return 'running'
  return 'recorded'
}

/** Deliberate allowlist: no original payload, prompt, file path, command,
 * provider text, error body or raw tool argument reaches Activities. */
export function publicRunActivity(row: ActivityReadRow, version: WorkflowVersionV3,
  runId: string, runOutcome: string): RunActivityPublic {
  const scope = { workspaceId: version.workspaceId, workflowId: version.workflowId,
    runId, workflowVersionId: version.id,
    executionSemanticsVersion: 3 as const }
  const payload = row.safe_payload, native = row.native ?? {}
  const node = version.definition.nodes.find((item) => item.id === row.execution_node_id)
  const actorKind = new Set(['node_scheduled','node_state_changed','harness_session_started',
    'harness_output','harness_session_finished','result_recorded','work_result_accepted',
    'work_handoff_accepted','work_handoff_returned','work_handoff_denied','work_rerouted','ci_state_changed'])
  const jobActor = node?.kind === 'job' && row.job_execution_id && row.node_execution_id === row.job_execution_id
    && row.job_definition_id === node.jobDefinitionId && row.job_definition_revision === node.jobDefinitionRevision
    && row.job_definition_version_id === node.jobDefinitionVersionId
    ? { kind: 'job' as const, nodeId: node.id, nodeName: string(payload.actorName) ?? 'Job',
      jobDefinitionId: node.jobDefinitionId, jobDefinitionRevision: node.jobDefinitionRevision,
      jobDefinitionVersionId: node.jobDefinitionVersionId } : undefined
  const actor = actorKind.has(row.kind) && jobActor ? jobActor
    : actorKind.has(row.kind) && node && node.kind !== 'job' && node.agentId === row.execution_agent_id
    ? { agentId: node.agentId, agentName: safeNodeName(payload.actorName) ?? 'Agent',
      nodeId: node.id, nodeName: safeNodeName(payload.actorName) ?? 'Agent' } : undefined
  const subjectId = row.kind === 'work_requester_reactivated' ? id(payload.requesterNodeId)
    : row.kind.startsWith('work_limit_notice_') || row.kind === 'work_rerouted'
      ? id(payload.destinationNodeId) : undefined
  const subjectNode = version.definition.nodes.find((item) => item.id === subjectId)
  const subject = subjectNode?.kind === 'job' ? { kind: 'job' as const, nodeId: subjectNode.id,
    nodeName: string(payload.subjectName) ?? 'Job', jobDefinitionId: subjectNode.jobDefinitionId,
    jobDefinitionRevision: subjectNode.jobDefinitionRevision, jobDefinitionVersionId: subjectNode.jobDefinitionVersionId }
    : subjectNode ? { agentId: subjectNode.agentId,
    agentName: safeNodeName(payload.subjectName) ?? 'Agent',
    nodeId: subjectNode.id, nodeName: safeNodeName(payload.subjectName) ?? 'Agent' } : undefined
  const relationship = id(payload.relationshipId)
  const fromRelationship = id(payload.fromRelationshipId)
  const requesterNode = id(payload.requesterNodeId)
  const destinationNode = id(payload.destinationNodeId)
  const refs = {
    ...(row.ci_ticket_id && row.ci_execution_id ? { jobExecutionId: row.ci_execution_id,
      jobAttemptId: id(row.ci_attempt_id), jobOperationId: id(row.ci_operation_id) } : {}),
    ...(jobActor ? { executionId: row.job_execution_id, jobExecutionId: row.job_execution_id,
      jobAttemptId: id(row.job_attempt_id), jobOperationId: id(row.job_operation_id), nodeExecutionId: row.node_execution_id } : {}),
    ...(!jobActor && row.harness_execution_id && row.execution_node_id ? { executionId: row.harness_execution_id } : {}),
    ...(id(row.work_activation_id ?? payload.activationId) ? { activationId: id(row.work_activation_id ?? payload.activationId) } : {}),
    ...(id(payload.requestId) ? { requestId: id(payload.requestId) } : {}),
    ...(id(payload.returnId) ? { returnId: id(payload.returnId) } : {}),
    ...(id(payload.denialId) ? { denialId: id(payload.denialId) } : {}),
    ...(id(payload.noticeId) ? { noticeId: id(payload.noticeId) } : {}),
    ...(id(payload.unresolvedId) ? { unresolvedId: id(payload.unresolvedId) } : {}),
    ...(relationship && version.definition.edges.some((edge) => edge.id === relationship)
      ? { relationshipId: relationship } : {}),
    ...(fromRelationship && version.definition.edges.some((edge) => edge.id === fromRelationship)
      ? { fromRelationshipId: fromRelationship } : {}),
    ...(requesterNode && version.definition.nodes.some((item) => item.id === requesterNode)
      ? { requesterNodeId: requesterNode } : {}),
    ...(destinationNode && version.definition.nodes.some((item) => item.id === destinationNode)
      ? { destinationNodeId: destinationNode } : {}),
    ...(id(payload.interactionId) ? { interactionId: id(payload.interactionId) } : {}),
    ...(id(payload.reviewJobId) ? { reviewJobId: id(payload.reviewJobId) } : {}),
    ...(id(payload.acknowledgementId) ? { acknowledgementId: id(payload.acknowledgementId) } : {}),
    ...(count(row.execution_attempt) && row.execution_node_id ? { technicalAttempt: row.execution_attempt! } : {}),
    ...(count(payload.nativeEventSequence) !== undefined ? { nativeEventSequence: count(payload.nativeEventSequence) } : {}),
  }
  const used = count(payload.used), maximum = count(payload.maximum)
  const usageProven = row.kind === 'work_handoff_accepted' ? Boolean(refs.requestId)
    : row.kind === 'work_handoff_denied' ? Boolean(refs.denialId)
      : row.kind.startsWith('work_limit_notice_') ? Boolean(refs.noticeId) : true
  const usage = used === undefined || !usageProven ? undefined
    : { used, limit: maximum && maximum > 0 ? maximum : null }
  let kind: RunActivityPublic['kind'] = jobActor ? 'job_work' : 'agent_work'
  let status: RunActivityPublic['status']
  let summary: string
  let detail: string | undefined
  switch (row.kind) {
    case 'ci_state_changed': {
      kind = 'job_work'
      if (!row.ci_ticket_id || !refs.jobExecutionId || !actor) {
        status = 'unknown'
        summary = 'CI activity details unavailable'
        break
      }
      const state = string(payload.state)
      const outcome = string(payload.outcome)
      const suite = JobOrdinaryVerificationSuiteSchema.safeParse(payload.suite)
      const name = suite.success ? `CI ${suite.data}` : 'CI'
      if (state === 'terminal') {
        status = 'failed'
        if (outcome === 'succeeded') status = 'completed'
        else if (outcome === 'cancelled') status = 'canceled'
        else if (!outcome || outcome === 'completed') status = 'unknown'
      } else if (state === 'running') status = 'running'
      else if (state === 'preparing') status = 'starting'
      else status = 'queued'
      summary = `${name} ${status}`
      break
    }
    case 'run_state_changed': {
      kind = 'run'
      const state = string(payload.executionState)
      status = state === 'completed' ? runOutcome === 'failed' ? 'failed'
        : runOutcome === 'canceled' ? 'canceled' : 'completed'
        : state === 'running' ? 'running' : state === 'queued' ? 'queued'
          : state === 'interrupted' ? 'unknown' : 'pending'
      summary = state === 'completed' ? 'Run completed' : state === 'running' ? 'Run started'
        : state === 'queued' ? 'Run queued' : state === 'waiting' ? 'Run waiting'
          : 'Run state changed'
      break
    }
    case 'run_stop_requested': kind = 'stop'; status = 'pending'; summary = 'Stop requested'; break
    case 'run_cleanup_checked':
      kind = 'recovery'; status = payload.failed === true ? 'failed' : 'completed'
      summary = payload.failed === true ? 'Native cleanup remains pending' : 'Native cleanup verified'
      break
    case 'node_scheduled': case 'work_activation_queued':
      status = 'queued'; summary = 'Work turn queued'; break
    case 'node_state_changed': {
      const state = string(payload.state)
      status = state === 'completed' ? row.result_outcome === 'failed' ? 'failed'
        : row.result_outcome === 'canceled' ? 'canceled' : 'completed'
        : state === 'starting' ? 'starting' : state === 'running' ? 'running'
          : state === 'waiting' ? 'pending' : 'queued'
      const label = jobActor ? 'Job' : 'Agent'
      summary = state === 'completed' ? `${label} work completed`
        : state === 'running' ? `${label} working` : state === 'waiting' ? `${label} waiting`
          : `${label} work queued`
      if (status === 'failed') detail = 'Error details are available in Run inspection.'
      break
    }
    case 'harness_session_started': status = 'running'; summary = 'Native session started'; break
    case 'harness_session_finished': status = 'completed'; summary = 'Native session finished'; break
    case 'harness_output': {
      const unsupported = string(native.type) === 'interaction.unsupported'
        ? codexUnsupportedInteractionMessage(native.unsupportedInteractionCode) : undefined
      if (unsupported) {
        kind = 'error'
        status = 'failed'
        summary = unsupported
        break
      }
      const claude = claudeConversationActivity({ type: string(native.type) ?? '', payload: {
        itemId: native.claudeItemId, taskId: native.claudeTaskId, name: native.claudeName, status: native.claudeStatus,
      } }, runId)
      const label = claude?.title ?? toolLabel(native)
      kind = label ? 'tool_action' : 'tool_log'
      status = claude?.status ?? toolStatus(native)
      const action = status === 'running' ? 'started' : status
      summary = label ? `${label} ${action}` : 'Native activity recorded; details unavailable'
      break
    }
    case 'result_recorded': case 'work_result_accepted':
      status = 'completed'; summary = 'Work result recorded'; break
    case 'work_handoff_accepted':
      kind = 'work_request'; status = refs.requestId ? 'accepted' : 'unknown'
      summary = refs.requestId ? 'Work request admitted' : 'Work request details unavailable'; break
    case 'work_handoff_returned':
      kind = 'work_return'; status = !refs.returnId ? 'unknown'
        : payload.outcome === 'needs_changes' ? 'needs_changes'
          : payload.outcome === 'accepted' ? 'accepted' : 'unknown'
      summary = status === 'needs_changes' ? 'Review returned with changes needed'
        : status === 'accepted' ? 'Work return accepted' : 'Work return details unavailable'
      break
    case 'work_handoff_denied':
      kind = 'work_request'; status = refs.denialId ? 'denied' : 'unknown'
      summary = refs.denialId ? 'Work request denied at connection limit'
        : 'Work denial details unavailable'; break
    case 'work_requester_reactivated':
      kind = 'agent_work'; status = refs.activationId ? 'queued' : 'unknown'
      summary = refs.activationId ? `${subject?.nodeName ?? 'Requester'} continuation queued`
        : 'Requester continuation details unavailable'; break
    case 'work_rerouted':
      kind = 'reroute'; status = refs.requestId && refs.noticeId && refs.relationshipId
        && refs.fromRelationshipId ? 'accepted' : 'unknown'
      summary = status === 'accepted' ? 'Work rerouted on a saved connection'
        : 'Reroute details unavailable'; break
    case 'work_limit_notice_queued': case 'work_limit_notice_pending':
    case 'work_limit_notice_delivered': case 'work_limit_notice_unknown':
      kind = 'work_notice'
      status = !refs.noticeId ? 'unknown'
        : row.kind === 'work_limit_notice_delivered' ? 'delivered'
        : row.kind === 'work_limit_notice_unknown' ? 'unknown'
          : row.kind === 'work_limit_notice_pending' ? 'pending' : 'queued'
      summary = !refs.noticeId ? 'Work limit notice details unavailable'
        : status === 'delivered' ? 'Work limit notice acknowledged by requester'
        : status === 'unknown' ? 'Work limit notice delivery uncertain'
          : status === 'pending' ? 'Work limit notice bound to requester turn'
            : 'Work limit notice queued'
      if (subject) summary = `${summary} for ${subject.nodeName}`
      break
    case 'work_needs_direction': case 'work_direction_wait':
      kind = 'needs_direction'
      status = row.kind === 'work_direction_wait' || refs.unresolvedId ? 'needs_direction' : 'unknown'
      summary = status === 'unknown' ? 'Unresolved work details unavailable'
        : row.kind === 'work_direction_wait' ? 'Run waiting for direction' : 'Work needs direction'
      break
    case 'interaction_pending':
      kind = 'approval'; status = refs.interactionId ? 'pending' : 'unknown'
      summary = refs.interactionId ? 'Approval requested' : 'Approval details unavailable'; break
    case 'interaction_decided':
      kind = 'approval'; status = 'recorded'
      summary = !refs.interactionId ? 'Approval decision details unavailable'
        : payload.selectedSemantic === 'reject' ? 'Approval rejected; decision recorded'
        : payload.selectedSemantic === 'cancel' ? 'Approval canceled; decision recorded'
          : ['approve_once','allow_turn','allow_session','provider_scoped_allow','persistent_policy_change']
            .includes(string(payload.selectedSemantic) ?? '')
            ? 'Approval granted; decision recorded' : 'Approval decision recorded'
      break
    case 'interaction_delivery_state': case 'interaction_resolved': {
      kind = 'approval'
      const delivery = string(payload.deliveryState), resolution = string(payload.status)
      status = !refs.interactionId ? 'unknown'
        : delivery === 'delivered' && resolution === 'delivered' ? 'delivered'
        : resolution === 'delivery_failed' || delivery === 'failed' ? 'delivery_failed'
          : delivery === 'unknown' ? 'unknown' : resolution === 'canceled' ? 'canceled' : 'pending'
      summary = !refs.interactionId ? 'Approval details unavailable'
        : status === 'delivered' ? 'Approval delivered to provider'
        : status === 'delivery_failed' ? 'Approval delivery failed'
          : status === 'unknown' ? 'Approval delivery uncertain'
            : status === 'canceled' ? 'Approval canceled' : 'Approval delivery pending'
      break
    }
    case 'interaction_worker_ack':
      kind = 'approval'; status = refs.interactionId && refs.acknowledgementId ? 'acknowledged' : 'unknown'
      summary = status === 'acknowledged' ? 'Worker acknowledged approval'
        : 'Worker acknowledgement details unavailable'; break
    case 'review_job_state': {
      kind = 'review'
      const state = string(payload.state)
      status = !refs.reviewJobId ? 'unknown'
        : state === 'completed' ? 'completed' : state === 'failed' ? 'failed'
        : state === 'uncertain' ? 'unknown' : 'pending'
      summary = !refs.reviewJobId ? 'Review details unavailable'
        : status === 'completed' ? 'Review completed'
        : status === 'failed' ? 'Review failed' : 'Review status updated'
      break
    }
    default: kind = 'error'; status = 'unknown'; summary = 'Activity details unavailable'
  }
  const severity = status === 'failed' || status === 'delivery_failed' ? 'error'
    : ['denied','unknown','needs_direction'].includes(status) ? 'warning' : 'info'
  return RunActivityPublicSchema.parse({ id: repeatId('activity', scope.runId, row.sequence),
    scope, sequence: row.sequence, occurredAt: row.occurred_at.toISOString(), source: row.source,
    kind, status, severity, summary,
    ...(detail ? { detail } : {}), ...(actor ? { actor } : {}),
    ...(subject ? { subject } : {}), refs,
    ...(usage ? { usage } : {}) })
}
