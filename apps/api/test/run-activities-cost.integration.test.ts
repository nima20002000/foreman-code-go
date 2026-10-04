import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { AcceptedWorkflowRunV3Schema, RunActivitiesPageSchema } from '@graphql/contracts/wave25'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { buildApp } from '../src/app.js'
import { RunActivitiesService } from '../src/modules/runs/activities.js'
import { readRunActivitySnapshot } from '../src/modules/runs/activitySnapshot.js'
import { withCurrentRunRead } from '../src/modules/runs/currentRead.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import type { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import { graphFixture, graphHeaders, graphRpc, graphRpcValue,
  type GraphFixture } from './eng04-graph-composition-fixture.js'

const occurredAt = '2026-10-02T00:00:00.000Z'

async function addExecutions(pool: pg.Pool, fixture: GraphFixture, first: number, last: number) {
  const node = agentWorkflowNode(fixture.version.definition.nodes[0])
  await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
    select $1||'-execution-'||n,$1,$2,$3,n,jsonb_build_object(
      'id',$1||'-execution-'||n,'runId',$1,'workflowNodeId',$2,'agentId',$3,'attempt',n,
      'agentConfigurationVersionId',$4::text,'state','completed','input','{}'::jsonb,
      'result',jsonb_build_object('outcome','succeeded'),
      'createdAt',$5::text,'startedAt',$5::text,'finishedAt',$5::text,
      'nativeSessionId',$1||'-session-'||n)
    from generate_series($6::integer,$7::integer) n`,
  [fixture.run.id, node.id, node.agentId, fixture.version.agentConfigurationVersionIds[node.agentId],
    occurredAt, first, last])
  await pool.query(`insert into harness_native_events(execution_id,sequence,record)
    select $1||'-execution-'||n,1,jsonb_build_object(
      'type','item.completed','occurredAt',$2::text,
      'payload',jsonb_build_object('threadId',$1||'-session-'||n,
        'item',jsonb_build_object('id','tool-'||n,'type','commandExecution','status','completed')))
    from generate_series($3::integer,$4::integer) n`, [fixture.run.id, occurredAt, first, last])
}

function measuredActivities(pool: pg.Pool) {
  const work = { queries: 0, rows: 0 }
  const measuredPool = { connect: async () => {
    const client = await pool.connect()
    return {
      async query<R extends pg.QueryResultRow>(text: string, values?: unknown[]) {
        const result = await client.query<R>(text, values)
        work.queries++
        work.rows += result.rows.length
        return result
      },
      on: client.on.bind(client),
      removeListener: client.removeListener.bind(client),
      release: client.release.bind(client),
    }
  } } as unknown as pg.Pool
  return { service: new RunActivitiesService(measuredPool), work,
    reset() {
      work.queries = 0
      work.rows = 0
    } }
}

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('public Activities response and query cost', () => {
  it('keeps all retained public history pageable after the normalized snapshot exceeds the response budget', async () => {
    await nim2691TaskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const db = { pool, directory, schema: 'public', close: async () => {} } as Awaited<ReturnType<typeof currentDatabase>>
      const fixture = await graphFixture(db, { form: 'sequential', qualifiedReads: true, maxNodeExecutions: 300 })
      const runs = new RunManagementService(pool, fixture.commands, {} as never, {} as never, {} as never)
      const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access: fixture.access,
          services: { commands: fixture.commands, workflows: fixture.workflows, runs } as never } })
      try {
        await addExecutions(pool, fixture, 1, 300)
        await pool.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
          select $1,'backend','work_result_accepted',$1||'-execution-'||n,$2,'{}'::jsonb
          from generate_series(1,100) n`,
        [fixture.run.id, occurredAt])
        const snapshot = await withCurrentRunRead(pool, fixture.writer.principal,
          fixture.scope.workspaceId, fixture.run.id, 'runs:read', (sql, { version }) =>
            readRunActivitySnapshot(sql as unknown as Pick<pg.PoolClient, 'query'>, {
              workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
              runId: fixture.run.id, workflowVersionId: fixture.version.id,
            }, version))
        expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(128 * 1024)
        expect(snapshot.sourceRevisions?.filter((entry) => entry.source === 'execution')).toHaveLength(300)
        expect(snapshot.activities.filter((entry) => entry.kind === 'diagnostic')).toHaveLength(100)
        expect(snapshot.activities.filter((entry) => entry.kind === 'tool')).toHaveLength(300)
        const metadata = { ...snapshot,
          activities: snapshot.activities.filter((entry) => entry.source.system !== 'harness_native_events') }
        expect(Buffer.byteLength(JSON.stringify(metadata))).toBeGreaterThan(128 * 1024)

        const args = { workspaceId: fixture.scope.workspaceId, runId: fixture.run.id, limit: 25 }
        const reader = await fixture.credential([{ actions: ['runs:read'],
          scope: { workspaceIds: [args.workspaceId], workflowIds: [fixture.scope.workflowId], runIds: [args.runId] } }])
        const url = `/api/management/workspaces/${args.workspaceId}/runs/${args.runId}/activities`
        const retained = (await pool.query<{ sequence: string }>(
          'select sequence::text from run_activity where run_id=$1 order by sequence desc limit 1000',
          [args.runId])).rows.reverse().map((row) => row.sequence)
        const sequences: string[] = []
        let cursor: string | null = null
        let nextCursor = ''
        do {
          const query = new URLSearchParams({ limit: String(args.limit), ...(cursor ? { cursor } : {}) })
          const http = await app.inject({ method: 'GET', url: `${url}?${query}`,
            headers: graphHeaders(reader.token) })
          expect(http.statusCode, http.body).toBe(200)
          const page = RunActivitiesPageSchema.parse(http.json())
          expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(128 * 1024)
          expect(page).not.toHaveProperty('activitySnapshot')
          const mcp = await graphRpc(app, reader.token, 'tools/call', {
            name: 'run_activities_get_v1', arguments: { ...args, ...(cursor ? { cursor } : {}) } })
          expect(mcp.result?.isError).not.toBe(true)
          expect(RunActivitiesPageSchema.parse(graphRpcValue(mcp.result))).toEqual(page)
          sequences.unshift(...page.items.map((item) => item.sequence))
          if (page.mode === 'initial') nextCursor = page.nextCursor
          cursor = page.olderCursor
        } while (cursor)
        expect(sequences).toEqual(retained)
        expect(new Set(sequences).size).toBe(sequences.length)

        await pool.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
          values($1,'backend','work_result_accepted',$2,'{}'::jsonb)`, [args.runId, occurredAt])
        const incremental = await graphRpc(app, reader.token, 'tools/call', {
          name: 'run_activities_get_v1', arguments: { ...args, cursor: nextCursor } })
        expect(incremental.result?.isError).not.toBe(true)
        const newer = RunActivitiesPageSchema.parse(graphRpcValue(incremental.result))
        expect(newer.items).toHaveLength(1)
        expect(BigInt(newer.items[0]!.sequence)).toBeGreaterThan(BigInt(retained.at(-1)!))

        const denied = await fixture.credential([{ actions: ['workflows:read'],
          scope: { workspaceIds: [args.workspaceId] } }])
        const blocked = await graphRpc(app, denied.token, 'tools/call', {
          name: 'run_activities_get_v1', arguments: args })
        expect(blocked.error || blocked.result?.isError).toBeTruthy()
        const foreign = await fixture.credential([{ actions: ['runs:read'],
          scope: { runIds: ['another-run'] } }])
        const scoped = await graphRpc(app, foreign.token, 'tools/call', {
          name: 'run_activities_get_v1', arguments: args })
        expect(scoped.error || scoped.result?.isError).toBeTruthy()
        expect((await pool.query<{ n: number }>(
          'select count(*)::integer as n from harness_executions where run_id=$1', [args.runId])).rows[0]!.n).toBe(300)
        expect((await pool.query<{ n: number }>(`select count(*)::integer as n from harness_native_events n
          join harness_executions e on e.id=n.execution_id where e.run_id=$1`, [args.runId])).rows[0]!.n).toBe(300)
      } finally { await app.close(); await fixture.app.close() }
    })
  }, 120000)

  it.each(['running', 'completed'] as const)('does constant query work for unchanged short and long %s Runs', async (state) => {
    await nim2691TaskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const db = { pool, directory, schema: 'public', close: async () => {} } as Awaited<ReturnType<typeof currentDatabase>>
      const fixture = await graphFixture(db, { form: 'sequential', qualifiedReads: true, maxNodeExecutions: 300 })
      try {
        const run = AcceptedWorkflowRunV3Schema.parse({ ...fixture.run, executionState: state,
          ...(state === 'completed' ? { outcome: 'succeeded', result: { outcome: 'succeeded' }, finishedAt: occurredAt } : {}) })
        await pool.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
          [run.id, state, JSON.stringify(run)])
        await addExecutions(pool, fixture, 1, 1)
        const args = { workspaceId: fixture.scope.workspaceId, runId: fixture.run.id, limit: 1 }
        const { service, work, reset } = measuredActivities(pool)
        const read = () => service.read(fixture.writer.principal, args)
        let page = await read()
        reset()
        page = await service.read(fixture.writer.principal, { ...args, cursor: page.nextCursor })
        expect(page.items).toEqual([])
        const short = { ...work }

        await addExecutions(pool, fixture, 2, 300)
        page = await read()
        for (let poll = 0; poll < 3; poll++) {
          reset()
          page = await service.read(fixture.writer.principal, { ...args, cursor: page.nextCursor })
          expect(page.items).toEqual([])
          expect(page).not.toHaveProperty('activitySnapshot')
          expect(work).toEqual(short)
        }
        const before = BigInt(page.highWater)
        await pool.query('select append_harness_native_event($1::jsonb)', [JSON.stringify({
          executionId: `${run.id}-execution-300`, sequence: 2, type: 'item.completed', occurredAt,
          payload: { threadId: `${run.id}-session-300`,
            item: { id: 'tool-after-poll', type: 'commandExecution', status: 'completed' } },
        })])
        const next = await service.read(fixture.writer.principal, { ...args, cursor: page.nextCursor })
        expect(next.items).toHaveLength(1)
        expect(next.items[0]).toMatchObject({ kind: 'tool_action', status: 'completed',
          refs: { executionId: `${run.id}-execution-300`, nativeEventSequence: 2 } })
        expect(BigInt(next.highWater)).toBeGreaterThan(before)
      } finally { await fixture.app.close() }
    })
  }, 120000)
})
