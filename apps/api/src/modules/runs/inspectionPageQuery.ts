import type { RunExecutionsListInput } from '@graphql/contracts/wave25'
import type { ExecutionPagePosition } from './inspectionCursor.js'

export const INSPECTION_OCCURRENCE_COLUMNS = `o.occurrence_id,o.run_id as occurrence_run_id,o.workspace_id as occurrence_workspace_id,
  o.workflow_id as occurrence_workflow_id,o.workflow_version_id as occurrence_version_id,
  o.block_id as occurrence_block_id,o.occurrence_index,o.record->'identity' as occurrence_identity`

/** Input is parsed by RunExecutionsListInputSchema in the shared service.
 * Separate equality shapes match the four keyset indexes; no nullable-OR
 * filters, OFFSET, lifetime aggregate, unbounded JSON bodies or interpolated IDs. */
export function inspectionExecutionsQuery(input: RunExecutionsListInput, after: ExecutionPagePosition | undefined) {
  const values: unknown[] = [input.runId]
  const where = ['e.run_id=$1']
  if (input.workflowNodeId !== undefined) { values.push(input.workflowNodeId); where.push(`e.workflow_node_id=$${values.length}`) }
  if (input.occurrenceId !== undefined) { values.push(input.occurrenceId); where.push(`e.repeat_occurrence_id=$${values.length}`) }
  if (after) {
    values.push(after.createdAt, after.executionId)
    where.push(`(e.created_at,e.id)<($${values.length - 1}::timestamptz,$${values.length}::text)`)
  }
  values.push(input.limit + 1)
  return { text: `select e.id,e.run_id,e.workflow_node_id,e.agent_id,e.attempt,e.repeat_occurrence_id,e.accepted,
        to_char(e.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as page_created_at,
        jsonb_strip_nulls(jsonb_build_object('executionId',e.record->'id','workflowNodeId',e.record->'workflowNodeId',
          'agentId',e.record->'agentId','agentConfigurationVersionId',e.record->'agentConfigurationVersionId',
          'attempt',e.record->'attempt','state',e.record->'state','createdAt',e.record->'createdAt',
          'startedAt',e.record->'startedAt','finishedAt',e.record->'finishedAt','acceptedResultAvailable',e.accepted)) as summary,
        e.record->'result'->>'outcome' as reported_outcome,
        x.identity,x.run_id as identity_run_id,x.occurrence_id as identity_occurrence_id,x.technical_attempt,
        s.slot_id,s.run_id as slot_run_id,s.workflow_node_id as slot_node_id,s.occurrence_id as slot_occurrence_id,
        ${INSPECTION_OCCURRENCE_COLUMNS}
        from harness_executions e left join run_repeat_executions x on x.execution_id=e.id
        left join run_repeat_slots s on s.slot_id=x.slot_id
        left join run_repeat_occurrences o on o.occurrence_id=e.repeat_occurrence_id
        where ${where.join(' and ')}
        order by e.created_at desc,e.id desc limit $${values.length}`, values }
}
