import {
  AgentConfigurationVersionSchema,
  HarnessExecutionSchema,
  WorkflowRunSchema,
  WorkflowVersionSchema,
  directApprovalConnection,
  type DurableInteraction,
  type DirectApprovalConnection,
} from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'

type RequestIdentity = Pick<DurableInteraction,
  'workspaceId' | 'workflowId' | 'runId' | 'executionId' | 'requestingAgentId' | 'approval'>

function denied(): never {
  throw new DomainError('INTERACTION_ACCESS_DENIED',
    'Orchestrator review requires the exact requesting node to have a direct edge to the designated Orchestrator in this Run’s saved workflow version.', 403)
}

/**
 * Use only immutable Run/version/configuration pins, never the editable board.
 * Call with the decision transaction's client to retain its credential/Stop locks.
 * Native self-review never enters this routed-interaction boundary.
 */
export async function assertOrchestratorGraphAuthority(
  client: pg.Pool | pg.ClientBase,
  interaction: RequestIdentity,
  reviewer: { executionId?: string; principalId?: string } = {},
): Promise<DirectApprovalConnection | undefined> {
  if (interaction.approval.handler !== 'orchestrator') return undefined
  const reviewerId = interaction.approval.designatedOrchestratorAgentId
  if (!reviewerId || reviewerId === interaction.requestingAgentId) return denied()
  const found = await client.query<{
    run_record: unknown; version_record: unknown; execution_record: unknown; configuration_record: unknown; workflow_node_id: string
  }>(
    `select r.record as run_record, v.record as version_record,
            e.record as execution_record, e.workflow_node_id, c.record as configuration_record
     from harness_executions e
     join runs r on r.id=e.run_id
     join workflow_versions v on v.id=r.workflow_version_id
       and v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id
     join agent_configuration_versions c on c.id=(r.record->'agentConfigurationVersionIds'->>$6)
       and c.workspace_id=r.workspace_id and c.agent_id=$6
     where e.id=$1 and r.id=$2 and r.workspace_id=$3 and r.workflow_id=$4 and e.agent_id=$5`,
    [interaction.executionId, interaction.runId, interaction.workspaceId, interaction.workflowId,
      interaction.requestingAgentId, reviewerId],
  )
  const row = found.rows[0]
  const run = WorkflowRunSchema.safeParse(row?.run_record)
  const version = WorkflowVersionSchema.safeParse(row?.version_record)
  const execution = HarnessExecutionSchema.safeParse(row?.execution_record)
  const configuration = AgentConfigurationVersionSchema.safeParse(row?.configuration_record)
  if (!run.success || !version.success || !execution.success || !configuration.success) return denied()
  const r = run.data
  const v = version.data
  const e = execution.data
  const c = configuration.data
  if (r.id !== interaction.runId || r.workspaceId !== interaction.workspaceId || r.workflowId !== interaction.workflowId
    || v.id !== r.workflowVersionId || v.workspaceId !== r.workspaceId || v.workflowId !== r.workflowId
    || v.definition.id !== r.workflowId || v.definition.workspaceId !== r.workspaceId
    || e.workflowNodeId !== row?.workflow_node_id || e.id !== interaction.executionId || e.runId !== r.id || e.agentId !== interaction.requestingAgentId
    || e.agentConfigurationVersionId !== r.agentConfigurationVersionIds[e.agentId]
    || e.agentConfigurationVersionId !== v.agentConfigurationVersionIds[e.agentId]
    || c.id !== r.agentConfigurationVersionIds[reviewerId] || c.id !== v.agentConfigurationVersionIds[reviewerId]
    || c.agentId !== reviewerId || c.productRole !== 'orchestrator'
    || r.approval?.handler !== 'orchestrator' || r.approval.designatedOrchestratorAgentId !== reviewerId
    || v.approval?.handler !== 'orchestrator' || v.approval.designatedOrchestratorAgentId !== reviewerId
    || v.definition.approval?.handler !== 'orchestrator'
    || v.definition.approval.designatedOrchestratorAgentId !== reviewerId) return denied()
  const connection = directApprovalConnection(v.definition, e.workflowNodeId, e.agentId, reviewerId)
  if (!connection) return denied()

  // A reviewer credential belongs to one execution occurrence, not every node
  // using that Agent. Existing authentication still checks its live eligibility.
  if (reviewer.executionId || reviewer.principalId) {
    const owner = await client.query<{ id: string; record: unknown }>(
      `select e.id,e.record from harness_executions e
       where e.run_id=$1 and e.agent_id=$2 and e.workflow_node_id=$3
         and ($4::text is null or e.id=$4)
         and ($5::text is null or exists (
           select 1 from worker_credential_bindings b where b.principal_id=$5
             and b.execution_id=e.id and b.run_id=e.run_id and b.agent_id=e.agent_id))`,
      [r.id, reviewerId, connection.orchestratorNodeId, reviewer.executionId ?? null, reviewer.principalId ?? null],
    )
    const bound = HarnessExecutionSchema.safeParse(owner.rows[0]?.record)
    if (owner.rows.length !== 1 || !bound.success || bound.data.id !== owner.rows[0]?.id || bound.data.runId !== r.id
      || bound.data.workflowNodeId !== connection.orchestratorNodeId || bound.data.agentId !== reviewerId
      || bound.data.agentConfigurationVersionId !== c.id) return denied()
  }
  return connection
}
