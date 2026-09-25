import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import type pg from 'pg'
import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { startFixture } from './eng04-start-fixtures.js'

// Dispatch tests; proof writers are recording doubles. The immutable reader,
// canonical SQL and native boundary have their own separate qualification suites.
const calls = vi.hoisted(() => ({ running: [] as unknown[][], stop: [] as unknown[][], legacy: [] as unknown[][] }))
vi.mock('../src/modules/runs/repeatLifecycle.js', () => ({
  markRepeatRunRunning: async (...args: unknown[]) => { calls.running.push(args) },
  requestRepeatRunStop: async (...args: unknown[]) => { calls.stop.push(args) },
}))
vi.mock('../src/modules/runs/oneShotLifecycle.js', () => ({
  changeOneShotLifecycle: async (...args: unknown[]) => { calls.legacy.push(args) },
}))
vi.mock('../src/modules/run-graph/repeatPublication.js', () => ({ openRepeatCanonicalPublicationLocked: () => {
  throw new Error('Native activation is not supplied by this dispatch fixture')
} }))
vi.mock('../src/modules/runs/repeatStartRead.js', () => ({ readAcceptedRepeatRunLocked: () => {
  throw new Error('Unexpected immutable reader; updateState discovery is explicitly doubled')
} }))

async function fixture() {
  calls.running = []; calls.stop = []; calls.legacy = []
  const f = startFixture(), state = { tag: 3 as unknown, physical: 3, queries: [] as string[] }
  const query = async (sql: string) => {
    state.queries.push(sql)
    assert.ok(sql.includes('join workflow_versions'), 'dispatch must not make raw lifecycle writes')
    return { rows: [{ record: { ...f.run, executionSemanticsVersion: state.tag },
      version: { ...f.version, executionSemanticsVersion: state.tag }, execution_semantics_version: state.physical }], rowCount: 1 }
  }
  const pool = { query } as unknown as pg.Pool
  const owner = { runId: f.run.id, assertOwned: () => undefined, client: { query } } as unknown as RunOwnership
  const locations = {} as ConstructorParameters<typeof PostgresRunRepository>[2]
  const { PostgresRunRepository: Repository } = await import('../src/modules/runs/postgres.js')
  const repository = new Repository(pool, {} as ConstructorParameters<typeof PostgresRunRepository>[1], locations)
  repository.get = async () => structuredClone(f.run)
  return { f, state, pool, owner, locations, repository }
}

test('ENG04 repository: v3 running passes the exact owner, policy service and update to its writer', async () => {
  const f = await fixture(), update = { executionState: 'running' as const, outcome: 'pending' as const }
  await f.repository.updateState(f.f.run.id, update, f.owner)
  assert.deepEqual(calls.running, [[f.owner, f.locations, update]])
  assert.equal(calls.legacy.length, 0); assert.equal(f.state.queries.length, 0)
})

test('ENG04 repository: missing or different Run owner never reaches the v3 writer', async () => {
  const f = await fixture(), update = { executionState: 'running' as const, outcome: 'pending' as const }
  await assert.rejects(f.repository.updateState(f.f.run.id, update), { code: 'RUN_OWNERSHIP_REQUIRED' })
  await assert.rejects(f.repository.updateState(f.f.run.id, update, { ...f.owner, runId: 'other-run' } as RunOwnership), { code: 'GRAPH_SCOPE_MISMATCH' })
  assert.equal(calls.running.length, 0)
})

test('ENG04 repository: v3 Stop requires the exact live authorizer; v2 stays on its existing writer', async () => {
  const f = await fixture(), authorize = async () => undefined
  await assert.rejects(f.repository.requestStop(f.f.run.id), { code: 'REPEAT_STOP_AUTHORIZATION_REQUIRED' })
  assert.equal(calls.stop.length, 0)
  await f.repository.requestStop(f.f.run.id, authorize)
  assert.deepEqual(calls.stop, [[f.pool, f.f.run.id, authorize]])
  f.state.tag = 2; f.state.physical = 2
  await f.repository.requestStop(f.f.run.id, authorize)
  assert.deepEqual(calls.legacy, [[f.pool, f.f.run.id, { kind: 'stop', authorize }]])
  f.state.tag = 1; f.state.physical = 1
  await f.repository.requestStop(f.f.run.id, authorize)
  assert.equal(calls.stop.length, 1); assert.equal(calls.legacy.length, 1)
})

test('ENG04 repository: v3 cleanup/orphan paths and production factory remain closed', async () => {
  const f = await fixture()
  await assert.rejects(f.repository.requestCleanup(f.f.run.id), { code: 'REPEAT_LIFECYCLE_PUBLICATION_REQUIRED' })
  await assert.rejects(f.repository.finishCleanup(f.f.run.id, false), { code: 'REPEAT_LIFECYCLE_PUBLICATION_REQUIRED' })
  await assert.rejects(f.repository.settleOrphan(f.f.run.id, f.owner, true), { code: 'REPEAT_LIFECYCLE_PUBLICATION_REQUIRED' })
  assert.throws(() => f.repository.repeatRepositoryFactory(), { code: 'REPEAT_NATIVE_HOST_REQUIRED' })
  assert.equal(calls.stop.length, 0); assert.equal(calls.running.length, 0); assert.equal(calls.legacy.length, 0)
})

test('ENG04 repository: unknown or physically mismatched semantics cannot request Stop', async () => {
  const f = await fixture()
  for (const tag of ['3', null, 4]) {
    f.state.tag = tag
    await assert.rejects(f.repository.requestStop(f.f.run.id, async () => undefined), { code: 'EXECUTION_SEMANTICS_UNSUPPORTED' })
  }
  f.state.tag = 3; f.state.physical = 2
  await assert.rejects(f.repository.requestStop(f.f.run.id, async () => undefined), { code: 'RUN_PIN_CONFLICT' })
  assert.equal(calls.stop.length, 0)
})
