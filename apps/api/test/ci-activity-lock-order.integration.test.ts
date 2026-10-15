import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { deferred } from './helpers/deferred.js'
import { graphFixture } from './eng04-graph-composition-fixture.js'

it('publishes CI activity while execution publication holds the parent Run without deadlocking', async () => {
  const db = await currentDatabase()
  const graph = await graphFixture(db, { form: 'single' })
  const locked = deferred<number>()
  const publish = deferred()
  const ciStarted = deferred<number>()
  const node = agentWorkflowNode(graph.version.definition.nodes[0])
  const executionId = randomUUID()
  try {
    await db.pool.query(`insert into harness_executions
      (id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,1,$5::jsonb)`,
    [executionId, graph.run.id, node.id, node.agentId, JSON.stringify({
      id: executionId, runId: graph.run.id, workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: graph.version.agentConfigurationVersionIds[node.agentId],
      state: 'starting', attempt: 1, input: {}, createdAt: graph.run.createdAt,
    })])
    const baseline = (await db.pool.query<{ sequence: string }>(
      'select coalesce(max(sequence),0)::text as sequence from run_activity where run_id=$1',
      [graph.run.id])).rows[0]!.sequence
    const ticket = CiRunRecordSchema.parse({
      id: randomUUID(), workspaceId: graph.scope.workspaceId, groupId: randomUUID(), suite: 'lint',
      commit: 'a'.repeat(40), repository: 'example/project', partition: null,
      state: 'queued', computer: null, step: null, exitCode: null, message: null,
      queuedAt: graph.run.createdAt, startedAt: null, finishedAt: null,
      initiator: { principalId: graph.writer.principal.id, executionId },
    })
    const execution = withTransaction(db.pool, async client => {
      await client.query('select id from runs where id=$1 for update', [graph.run.id])
      locked.resolve((await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid)
      await publish.promise
      await client.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
        values($1,'backend','execution_state_changed',$2,clock_timestamp(),'{}'::jsonb)`, [graph.run.id, executionId])
    })
    const results = Promise.allSettled([execution, (async () => {
      await locked.promise
      await withTransaction(db.pool, async client => {
        ciStarted.resolve((await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid)
        await client.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
          values($1,$2,$3,$4,$5::jsonb)`,
        [ticket.id, ticket.workspaceId, ticket.groupId, ticket.state, JSON.stringify(ticket)])
      })
    })()])
    try {
      const runPid = await locked.promise
      const ciPid = await ciStarted.promise
      await expect.poll(async () => (await db.pool.query<{ blocked: boolean }>(
        'select $1 = any(pg_blocking_pids($2)) as blocked', [runPid, ciPid])).rows[0]!.blocked)
        .toBe(true)
    } finally {
      publish.resolve()
    }
    expect(await results).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }])
    const activity = (await db.pool.query<{ kind: string }>(
      'select kind from run_activity where harness_execution_id=$1 and sequence>$2 order by sequence',
      [executionId, baseline])).rows
    expect(activity.map(row => row.kind)).toEqual(['execution_state_changed', 'ci_state_changed'])
  } finally {
    publish.resolve()
    await graph.app.close()
    await db.close()
  }
}, 60_000)
