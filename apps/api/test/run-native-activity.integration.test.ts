import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import type { NativeHarnessEvent } from '@graphql/contracts'
import { RunActivitiesPageSchema } from '@graphql/contracts/wave25'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { readNativeActivityFacts, projectNativeActivityFacts } from '../src/modules/runs/nativeActivitySnapshot.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import type { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import { graphFixture, graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'

const occurredAt = '2026-10-04T10:00:00.000Z'
const executionId = 'native-activity-execution'

async function activityFixture(work: (pool: pg.Pool, fixture: Awaited<ReturnType<typeof graphFixture>>,
  app: ReturnType<typeof buildApp>) => Promise<void>) {
  await nim2691TaskDatabase(async (pool, directory) => {
    await applyApplicationMigrations(pool)
    const db = { pool, directory, schema: 'public', close: async () => {} } as Awaited<ReturnType<typeof currentDatabase>>
    const fixture = await graphFixture(db, { form: 'single', qualifiedReads: true })
    const runs = new RunManagementService(pool, fixture.commands, {} as never, {} as never, {} as never)
    const app = buildApp({
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access: fixture.access, services: { commands: fixture.commands, workflows: fixture.workflows, runs } as never },
    })
    try {
      const node = agentWorkflowNode(fixture.version.definition.nodes[0])
      await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
        values($1,$2,$3,$4,1,$5::jsonb)`, [executionId, fixture.run.id, node.id, node.agentId, JSON.stringify({
        id: executionId, runId: fixture.run.id, workflowNodeId: node.id, agentId: node.agentId, attempt: 1,
        state: 'running', input: {}, createdAt: occurredAt, nativeSessionId: 'native-session',
        agentConfigurationVersionId: fixture.version.agentConfigurationVersionIds[node.agentId],
      })])
      await work(pool, fixture, app)
    } finally {
      await app.close()
      await fixture.app.close()
    }
  })
}

async function persistEvent(pool: pg.Pool, runId: string, event: NativeHarnessEvent) {
  await pool.query('insert into harness_native_events(execution_id,sequence,record) values($1,$2,$3::jsonb)',
    [executionId, event.sequence, JSON.stringify(event)])
  await pool.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
    values($1,'harness','harness_output',$2,$3,$4::jsonb)`,
  [runId, executionId, event.occurredAt, JSON.stringify({ nativeEventSequence: event.sequence, nativeEventType: event.type })])
}

async function readBoth(app: ReturnType<typeof buildApp>, fixture: Awaited<ReturnType<typeof graphFixture>>) {
  const args = { workspaceId: fixture.scope.workspaceId, runId: fixture.run.id, limit: 100 }
  const url = `/api/management/workspaces/${args.workspaceId}/runs/${args.runId}/activities?limit=100`
  const http = await app.inject({ method: 'GET', url, headers: graphHeaders(fixture.writer.token) })
  expect(http.statusCode, http.body).toBe(200)
  const page = RunActivitiesPageSchema.parse(http.json())
  const mcp = await graphRpc(app, fixture.writer.token, 'tools/call', { name: 'run_activities_get_v1', arguments: args })
  expect(mcp.result?.isError).not.toBe(true)
  expect(RunActivitiesPageSchema.parse(graphRpcValue(mcp.result))).toEqual(page)
  const denied = await fixture.credential([{ actions: ['workflows:read'], scope: { workspaceIds: [args.workspaceId] } }])
  expect((await app.inject({ method: 'GET', url, headers: graphHeaders(denied.token) })).statusCode).toBe(403)
  const deniedMcp = await graphRpc(app, denied.token, 'tools/call', { name: 'run_activities_get_v1', arguments: args })
  expect(deniedMcp.error || deniedMcp.result?.isError).toBeTruthy()
  return page
}

describe('persisted native Run activity', () => {
  it('distinguishes absent and JSON-null errors from real error objects in PostgreSQL', async () => {
    await activityFixture(async (pool, fixture, app) => {
      const errors = [{}, { error: null }, { error: { message: 'private failure body' } }]
      for (const [index, error] of errors.entries()) {
        await persistEvent(pool, fixture.run.id, { sequence: index + 1, occurredAt, type: 'item.completed', payload: {
          threadId: 'native-session', item: { id: `command-${index}`, type: 'commandExecution', status: 'completed', ...error },
        } })
      }
      const page = await readBoth(app, fixture)
      const tools = page.items.filter((item) => item.kind === 'tool_action')
      expect(tools.map((item) => item.status)).toEqual(['completed', 'completed', 'failed'])
      expect(tools.map((item) => item.summary)).toEqual([
        'Command action completed', 'Command action completed', 'Command action failed',
      ])
      expect(JSON.stringify(page)).not.toContain('private failure body')
      expect((await pool.query('select count(*)::integer as count from harness_native_events where execution_id=$1',
        [executionId])).rows[0]?.count).toBe(3)
    })
  }, 120000)

  it('keeps every native cancellation spelling canceled with and without completion envelopes', async () => {
    await activityFixture(async (pool, fixture, app) => {
      let sequence = 1
      for (const status of ['canceled', 'cancelled', 'interrupted']) {
        for (const type of ['item.started', 'item.completed', 'message.part.updated']) {
          const itemId = `cancellation-${sequence}`
          const payload = type === 'message.part.updated'
            ? { part: { id: itemId, type: 'tool', tool: 'bash', sessionID: 'native-session', state: { status } } }
            : { threadId: 'native-session', item: { id: itemId, type: 'commandExecution', status, error: null } }
          await persistEvent(pool, fixture.run.id, { sequence: sequence++, occurredAt, type, payload })
        }
      }
      const page = await readBoth(app, fixture)
      const tools = page.items.filter((item) => item.kind === 'tool_action')
      expect(tools).toHaveLength(9)
      expect(tools.every((item) => item.status === 'canceled' && item.summary === 'Command action canceled')).toBe(true)
      const native = projectNativeActivityFacts(await readNativeActivityFacts(pool, fixture.run.id), () => ({
        owner: { kind: 'run', ...fixture.scope }, harness: 'codex', sessionId: 'native-session', terminal: false,
      }))
      expect(native.activities).toHaveLength(9)
      expect(native.activities.every((item) => 'status' in item && item.status === 'canceled')).toBe(true)
      expect(native.active).toEqual([])
    })
  }, 120000)
})
