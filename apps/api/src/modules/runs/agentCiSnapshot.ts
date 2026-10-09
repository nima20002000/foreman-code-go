/** CI tickets keep their initiating Agent instead of pretending to be graph Job nodes. */
export const AGENT_CI_SNAPSHOT_SQL = `select q.execution_id as id,q.attempt_id,q.operation_id,
  ((q.record->>'revision')::bigint+coalesce(j.activity_record_revision,0))::text as revision,
  e.workflow_node_id as node_id,q.record #>> '{definition,id}' as definition_id,
  (q.record #>> '{definition,revision}')::integer as definition_revision,
  q.definition_version_id,
  e.agent_id as ci_agent_id,e.id as ci_agent_execution_id,
  coalesce(j.record #>> '{process,phase}',case q.record->>'state'
    when 'terminal' then 'terminal' when 'claimed' then 'preparing' else 'queued' end) as phase,
  coalesce(j.record #>> '{process,outcome}',q.record->>'terminalReason') as outcome,
  coalesce((j.record #>> '{process,processStopped}')::boolean,q.record->>'state'='terminal') as stopped,
  coalesce(j.record->>'publication',case when q.record->>'state'='terminal' then 'complete' else 'pending' end) as publication,
  j.record->>'startedAt' as started_at,coalesce(j.record->>'finishedAt',q.record->>'finishedAt') as finished_at,
  to_char((q.record->>'enqueuedAt')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
  coalesce(e.id is not null and e.agent_id=q.record #>> '{initiatingAgent,agentId}'
    and e.record->>'agentConfigurationVersionId'=r.record->'agentConfigurationVersionIds'->>e.agent_id
    and (j.id is null or (j.workspace_id=q.workspace_id and j.accepted_spec=j.record->'acceptedSpec'
      and j.record->>'id'=j.id and j.record->>'workspaceId'=j.workspace_id
      and j.record->>'attemptId'=q.attempt_id and j.attempt_id=q.attempt_id
      and j.record->>'operationId'=q.operation_id and j.operation_id=q.operation_id
      and j.definition_version_id=q.definition_version_id
      and j.record->'initiatingAgent'=q.record->'initiatingAgent')),false) as pinned
  from job_admission_queue q join runs r on r.id=$1 and r.workspace_id=$2 and r.workflow_id=$3
  left join harness_executions e on e.id=q.record #>> '{initiatingAgent,executionId}' and e.run_id=r.id
  left join job_executions j on j.id=q.execution_id
  where q.workspace_id=$2 and q.record #>> '{initiatingAgent,runId}'=$1
    and q.record #>> '{initiatingAgent,workflowId}'=$3`
