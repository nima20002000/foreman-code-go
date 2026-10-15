import assert from 'node:assert/strict'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { test, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'

test('a Run whose recovery keeps failing stops being retried and is reported once', async () => {
  vi.useFakeTimers()
  try {
    const reported: unknown[] = []
    const runs = { repeatRepositoryFactory: () => ({}),
      reconciliationCandidates: vi.fn(async (after: string) => after === '' ? [{ id: 'run-stuck' }] : []) }
    const engine = new LangGraphWorkflowEngine(runs as never, {} as never, { reconcileReviews: async () => {} } as never,
      new MemorySaver(), '/workspace/reconcile-bound', {} as never, {} as never, {} as never)
    const start = vi.spyOn(engine, 'start').mockRejectedValue(new DomainError('REMOTE_NATIVE_PHYSICAL_BACKPRESSURE',
      'Original physical source retention is full.', 503))
    for (let pass = 0; pass < 40; pass++) {
      await engine.reconcile(error => { reported.push(error) })
      await vi.advanceTimersByTimeAsync(60_000)
    }
    assert.equal(start.mock.calls.length, 10)
    assert.equal(reported.length, 10)
    assert.equal((reported.at(-1) as DomainError).code, 'RUN_RECONCILIATION_EXHAUSTED')
  } finally {
    vi.useRealTimers()
  }
})
