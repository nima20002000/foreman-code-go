import type pg from 'pg'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, RunGraphScopeSchema } from '@foreman-code/contracts/wave25'
import { afterEach, expect, it, vi } from 'vitest'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { PostgresNativeGraphProjectionWriter } from '../src/modules/run-graph/nativeWriter.js'
import { appendWorkflowNativeGraphEventLocked } from '../src/modules/runs/workflowNativeGraph.js'
import * as ingestion from '../src/modules/run-graph/nativeIngestion.js'
import * as rawEvents from '../src/modules/runs/nativeEvents.js'
import * as records from '../src/modules/run-graph/records.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'

vi.mock('../src/modules/run-graph/publication.js', () => ({ currentRunGraphPublication: () => ({}) }))
afterEach(() => vi.restoreAllMocks())

// SQL-only composition model. Actual private-capture/physical proof checks are
// exercised separately; this does not claim PostgreSQL or native process proof.
function fixture(type: string, expiresBeforeCommit = false) {
  const { run, version } = makeCurrentWorkflowFixture('transcript-fast-path')
  const node = version.definition.nodes[0]!
  const execution = HarnessExecutionSchema.parse({ id: 'original-execution', runId: run.id,
    workflowNodeId: node.id, agentId: node.agentId,
    agentConfigurationVersionId: run.agentConfigurationVersionIds[node.agentId!], attempt: 1,
    input: {}, state: 'running', createdAt: run.createdAt, startedAt: run.createdAt,
    workingDirectory: '/owned/project', runtimeDirectory: '/owned/runtime', nativeSessionId: 'original-session' })
  const owner = { runId: run.id, assertOwned() {},
    readOneShotFence: async () => ({ ownerId: 'original-owner', fence: '1' }) } as unknown as RunOwnership
  const raw = vi.spyOn(rawEvents, 'appendNormalizedNativeEvent').mockResolvedValue({ inserted: true, rejected: false })
  const semantic = vi.spyOn(ingestion, 'appendNativeGraphEvent').mockResolvedValue({ rawInserted: false,
    projected: 0, rejected: 0, ignored: 1 })
  vi.spyOn(records, 'readNativeGraphCorrelation').mockResolvedValue(undefined)
  const correlation = vi.spyOn(PostgresNativeGraphProjectionWriter.prototype, 'persistCorrelation').mockResolvedValue(undefined)
  const statements: string[] = []
  const connection = new ExclusiveGraphConnection({ query: async (sql: string) => {
    statements.push(sql)
    if (sql.startsWith('select record from runs')) return { rows: [{ record: run }], rowCount: 1 }
    if (sql.startsWith('select record from harness_executions')) return { rows: [{ record: execution }], rowCount: 1 }
    if (sql.includes('select record,harness,native_session_id')) return { rows: [{ record: {
      leaseToken: 'original-lease', leaseExpiresAt: '2099-01-01T00:00:00Z', connectionGeneration: 1 },
    live: true, harness: 'codex', native_session_id: execution.nativeSessionId, owner_agent_id: execution.agentId }], rowCount: 1 }
    if (sql.startsWith('select 1 from native_session_lanes')) return { rows: [], rowCount: expiresBeforeCommit ? 0 : 1 }
    if (['commit', 'rollback'].includes(sql) || sql.startsWith('begin')) return { rows: [], rowCount: 0 }
    throw new Error(`Unexpected composition SQL: ${sql}`)
  } } as unknown as pg.ClientBase, () => owner.assertOwned())
  const event = { executionId: execution.id, connectionId: 'original-connection', sequence: 1,
    occurredAt: run.createdAt, type, payload: { text: 'original transcript', turnId: 'original-turn' } }
  const append = () => connection.transaction((sql) => appendWorkflowNativeGraphEventLocked(sql, owner, event,
    { id: 'original-lane', token: 'original-lease', providerId: 'original-turn', live: true }))
  const appendCaptured = (mismatch?: 'transaction' | 'run' | 'execution') => connection.transaction((sql) => {
    const context = { sql, execution, scope: RunGraphScopeSchema.parse({
      workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
      workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3,
    }) }
    if (mismatch === 'transaction') context.sql = { ...sql }
    if (mismatch === 'run') context.scope = { ...context.scope, runId: 'another-run' }
    if (mismatch === 'execution') context.execution = { ...execution, id: 'another-execution' }
    return appendWorkflowNativeGraphEventLocked(sql, owner, event,
      { id: 'original-lane', token: 'original-lease', providerId: 'original-turn', live: true },
      undefined, undefined, context)
  })
  return { append, appendCaptured, raw, semantic, correlation, statements, event }
}

it('retains the original transcript and correlation without redundant semantic ingestion', async () => {
  const f = fixture('native.notification'); await f.append()
  expect(f.raw).toHaveBeenCalledOnce()
  expect(f.raw.mock.calls[0]![1].event).toEqual(f.event)
  expect(f.correlation).toHaveBeenCalledOnce()
  expect(f.semantic).not.toHaveBeenCalled()
  expect(f.statements).toContain('commit')
})

for (const type of ['turn.started', 'transport.disconnected']) it(`still ingests ${type} evidence`, async () => {
  const f = fixture(type); await f.append()
  expect(f.semantic).toHaveBeenCalledOnce()
})

it('still rejects an expired original lane before committing a transcript', async () => {
  const f = fixture('native.notification', true)
  await expect(f.append()).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
  expect(f.statements).toContain('rollback')
  expect(f.statements).not.toContain('commit')
})

it('retains the same captured transcript and correlation when reusing its validated context', async () => {
  const f = fixture('native.notification')
  await f.appendCaptured()
  expect(f.raw.mock.calls[0]![1].event).toEqual(f.event)
  expect(f.correlation).toHaveBeenCalledOnce()
  expect(f.semantic).not.toHaveBeenCalled()
})

it.each(['transaction', 'run', 'execution'] as const)('rejects reused context for another %s before persisting', async mismatch => {
  const f = fixture('native.notification')
  await expect(f.appendCaptured(mismatch)).rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
  expect(f.raw).not.toHaveBeenCalled()
  expect(f.correlation).not.toHaveBeenCalled()
})

it('revalidates lane expiry before commit after reusing a captured context', async () => {
  const f = fixture('native.notification', true)
  await expect(f.appendCaptured()).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
  expect(f.raw.mock.calls[0]![1].event).toEqual(f.event)
})
