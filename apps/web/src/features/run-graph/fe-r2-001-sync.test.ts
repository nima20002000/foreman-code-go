import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver, skipToken } from '@tanstack/react-query'
import { DISABLED_RUN_GRAPH_CAPABILITIES } from '@graphql/contracts/wave25'
import { ApiError } from '../../shared/api/client'
import { beginSessionChange, finishSessionChange, sessionGeneration } from '../../shared/api/sessionBoundary'
import { graphRecordKey } from './cache'
import type { RunGraphClient } from './client'
import type { RunGraphRecord } from './types'
import { retainRunGraphSync } from './sync'
import { legacyCurrent, legacyScope } from './fe-r2-001.fixtures'

const cleanup: Array<() => void> = []
const tick = async (ms = 1) => { await vi.advanceTimersByTimeAsync(ms) }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-22T00:00:00.000Z')) })
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); finishSessionChange(); vi.useRealTimers() })
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  cleanup.push(() => client.clear())
  const key = graphRecordKey(legacyScope, sessionGeneration())
  const api = {
    capabilities: vi.fn(async () => DISABLED_RUN_GRAPH_CAPABILITIES),
    snapshot: vi.fn<RunGraphClient['snapshot']>(async () => { throw new Error('No v2 fallback') }),
    events: vi.fn<RunGraphClient['events']>(async () => { throw new Error('No v2 fallback') }),
    legacy: vi.fn<RunGraphClient['legacy']>(async () => legacyCurrent()),
  } satisfies RunGraphClient
  const lease = () => { const held = retainRunGraphSync(client, legacyScope, api); cleanup.push(held.release); return held }
  const read = () => client.getQueryData<RunGraphRecord>(key)
  return { client, key, api, lease, read }
}

describe('FE-R2-001 actual Query/serial compatibility synchronization', () => {
  it.each(['10', '100000'])('shares bounded current polling across observers at history head %s', async (head) => {
    const f = setup()
    f.api.legacy.mockResolvedValue(legacyCurrent(head))
    const a = f.lease(), b = f.lease()
    const observers = Array.from({ length: 300 }, () => new QueryObserver(f.client,
      { queryKey: f.key, queryFn: skipToken, enabled: false, refetchInterval: false }).subscribe(() => undefined))
    cleanup.push(() => { for (const stop of observers) stop() })
    await tick()
    expect(f.api.legacy).toHaveBeenCalledTimes(1)
    await tick(2000)
    expect(f.api.legacy).toHaveBeenCalledTimes(3)
    expect(f.read()?.facts).toMatchObject({ reader: 'legacy', response: { history: 'not-included', asOfActivitySequence: head } })
    expect(f.api.events).not.toHaveBeenCalled()
    expect(f.api.snapshot).not.toHaveBeenCalled()
    a.release()
    await tick(1000)
    expect(f.api.legacy).toHaveBeenCalledTimes(4)
    b.release()
    await tick(5000)
    expect(f.api.legacy).toHaveBeenCalledTimes(4)
  })
  it.each([false, true])('does not infer complete settlement from a completed Run with cleanup=%s', async (cleanupPending) => {
    const f = setup()
    const value = legacyCurrent('50', cleanupPending)
    value.run = { ...value.run, executionState: 'completed', outcome: 'succeeded', finishedAt: '2026-09-22T01:00:00.000Z' }
    f.api.legacy.mockResolvedValue(value)
    f.lease()
    await tick()
    await tick(2000)
    expect(f.api.legacy).toHaveBeenCalledTimes(3)
    expect(f.read()?.facts).toMatchObject({ response: { cleanupPending, settlement: 'unconfirmed', run: { outcome: 'succeeded' } } })
  })
  it('drops restored full-history cache data before awaiting a capability read', async () => {
    const f = setup()
    f.client.setQueryData(f.key, { kind: 'run-graph-cache', scope: legacyScope, epoch: 0,
      transport: { phase: 'live' }, facts: { reader: 'legacy', response: { run: legacyCurrent().run, activity: Array(1000).fill({}), executions: [] } } })
    f.api.capabilities.mockImplementation(() => new Promise(() => undefined))
    f.lease()
    await tick()
    expect(f.read()?.facts).toBeUndefined()
  })
  it.each([401, 403])('purges current facts and stops shared polling on permission loss %s', async (status) => {
    const f = setup()
    const observer = new QueryObserver<RunGraphRecord>(f.client, { queryKey: f.key, queryFn: skipToken, enabled: false })
    cleanup.push(observer.subscribe(() => undefined))
    f.lease()
    await tick()
    expect(observer.getCurrentResult().data?.facts).toBeDefined()
    f.api.legacy.mockRejectedValue(new ApiError({ code: 'ACCESS_DENIED', message: 'Denied' }, status))
    await tick(1000)
    expect(observer.getCurrentResult().data?.facts).toBeUndefined()
    expect(observer.getCurrentResult().data?.transport.phase).toBe('denied')
    const calls = f.api.legacy.mock.calls.length
    await tick(5000)
    expect(f.api.legacy).toHaveBeenCalledTimes(calls)
  })
  it('discards a delayed current response after session loss even when its transport ignores abort', async () => {
    const f = setup()
    let resolve!: (value: ReturnType<typeof legacyCurrent>) => void
    f.api.legacy.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const observer = new QueryObserver<RunGraphRecord>(f.client, { queryKey: f.key, queryFn: skipToken, enabled: false })
    cleanup.push(observer.subscribe(() => undefined))
    f.lease()
    await tick()
    beginSessionChange()
    resolve(legacyCurrent('100000'))
    await tick()
    expect(observer.getCurrentResult().data?.facts).toBeUndefined()
  })
})
