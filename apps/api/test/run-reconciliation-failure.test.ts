import assert from 'node:assert/strict'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { afterEach, test, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

async function sweep(failure: unknown, passes: number) {
  vi.useFakeTimers()
  const owner = { runId: 'run-stuck', release: vi.fn(async () => {}) }
  const runs = { repeatRepositoryFactory: () => ({}),
    reconciliationCandidates: vi.fn(async (after: string) => after === '' ? [{ id: 'run-stuck' }] : []),
    acquireOwnership: vi.fn(async () => owner),
    requestCleanup: vi.fn(async () => {}) }
  const engine = new LangGraphWorkflowEngine(runs as never, {} as never, { reconcileReviews: async () => {} } as never,
    new MemorySaver(), '/workspace/reconcile-failure', {} as never, {} as never, {} as never)
  const start = vi.spyOn(engine, 'start').mockRejectedValue(failure)
  const reported: unknown[] = []
  for (let pass = 0; pass < passes; pass++) {
    await engine.reconcile(error => { reported.push(error) })
    await vi.advanceTimersByTimeAsync(60_000)
  }
  return { start, runs, owner, reported }
}

test('a Run whose recovery fails transiently stays eligible for recovery with backoff', async () => {
  const { start, runs, reported } = await sweep(new DomainError('REMOTE_NATIVE_PHYSICAL_BACKPRESSURE',
    'Original physical source retention is full.', 503), 40)
  assert.equal(start.mock.calls.length, 40)
  assert.equal(runs.requestCleanup.mock.calls.length, 0)
  assert.ok(reported.every(error => (error as DomainError).code === 'REMOTE_NATIVE_PHYSICAL_BACKPRESSURE'))
})

test('a Run whose recovery keeps failing permanently is failed with the real cause and settled by cleanup', async () => {
  const { start, runs, owner } = await sweep(new DomainError('RUN_PIN_CONFLICT', 'The checkpoint belongs to another Run.', 409), 40)
  assert.equal(runs.requestCleanup.mock.calls.length >= 1, true)
  assert.deepEqual(runs.requestCleanup.mock.calls[0], ['run-stuck', owner, { outcome: 'failed',
    error: { code: 'RUN_PIN_CONFLICT', message: 'The checkpoint belongs to another Run.', retryable: false } }])
  assert.equal(owner.release.mock.calls.length, runs.requestCleanup.mock.calls.length)
  // The cleanup request is settled by the same recovery sweep, so the Run is never dropped from it.
  assert.ok(start.mock.calls.length > 10)
})
