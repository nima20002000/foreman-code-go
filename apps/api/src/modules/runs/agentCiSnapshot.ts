import { CiActivitySchema, CiRunRecordSchema, type CiActivity } from '@foreman-code/contracts'

/** The originating execution fixes the CI ticket's Run and Agent ownership. */
export const AGENT_CI_SNAPSHOT_SQL = `select c.id::text,c.activity_record_revision::text as revision,
  e.id as execution_id,e.agent_id,e.workflow_node_id as node_id,c.record,
  coalesce(c.record->>'id'=c.id::text and c.record->>'workspaceId'=c.workspace_id
    and c.record->>'groupId'=c.group_id::text and c.record->>'state'=c.state
    and e.record->>'agentConfigurationVersionId'=r.record->'agentConfigurationVersionIds'->>e.agent_id,false) as pinned
  from ci_runs c join harness_executions e on e.id=c.record#>>'{initiator,executionId}'
  join runs r on r.id=e.run_id and r.id=$1 and r.workspace_id=$2 and r.workflow_id=$3
    and r.workflow_version_id=$4
  where c.workspace_id=r.workspace_id order by c.created_at,c.id limit 16001`

export function ciActivityFromRecord(record: unknown): CiActivity {
  const run = CiRunRecordSchema.parse(record)
  return CiActivitySchema.parse({
    id: run.id, groupId: run.groupId, suite: run.suite, part: run.part, partition: run.partition,
    state: run.state, queuedAt: run.queuedAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
    computer: run.computer ? { ...run.computer, label: run.computer.label.slice(0, 100) } : null,
    step: run.step?.slice(0, 80) ?? null, exitCode: run.exitCode,
  })
}
