import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver, skipToken } from '@tanstack/react-query'
import { DISABLED_RUN_GRAPH_CAPABILITIES, type RunGraphSnapshot } from '@graphql/contracts/wave25'
import { ApiError } from '../../shared/api/client'
import { beginSessionChange, finishSessionChange, sessionGeneration } from '../../shared/api/sessionBoundary'
import { graphRecordKey } from './cache'
import { retainRunGraphSync } from './sync'
import { reduceGraphPage } from './reducer'
import type { RunGraphClient } from './client'
import type { RunGraphRecord } from './types'
import { batch, fixture, page, queued } from './testFixtures'

const clients: QueryClient[] = []
const release: Array<() => void> = []
function setup(suffix = 'owner') {
  const f = fixture(suffix)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  clients.push(client)
  const api = {
    capabilities: vi.fn(async () => ({ ...DISABLED_RUN_GRAPH_CAPABILITIES, protocolVersions: [1] as [1], executionSemanticsVersions: [2] as [2] })),
    snapshot: vi.fn(async () => f.snapshot),
    events: vi.fn<RunGraphClient['events']>(async (scope, after) => page(scope, [], after)),
    legacy: vi.fn<RunGraphClient['legacy']>(async () => { throw new Error('Unexpected legacy call') }),
  } satisfies RunGraphClient
  const key = graphRecordKey(f.scope, sessionGeneration())
  const read = () => client.getQueryData<RunGraphRecord>(key)
  const lease = () => { const held = retainRunGraphSync(client, f.scope, api); release.push(held.release); return held }
  return { ...f, client, api, key, read, lease }
}
const tick = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms) }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-22T05:00:00.000Z')) })
afterEach(() => {
  for (const dispose of release.splice(0)) dispose()
  for (const client of clients.splice(0)) client.clear()
  finishSessionChange()
  vi.useRealTimers()
})

describe('one Query synchronization owner per viewed Run', () => {
  it('shares snapshot and polling across repeated mounts and starts no per-observer fetchers', async () => {
    const f = setup()
    const a = f.lease()
    const b = f.lease()
    expect(a.epoch).toBe(b.epoch)
    const observers = Array.from({ length: 300 }, () => new QueryObserver(f.client, {
      queryKey: f.key, queryFn: skipToken, enabled: false, refetchInterval: false,
    }).subscribe(() => undefined))
    await tick(1)
    expect(f.api.snapshot).toHaveBeenCalledTimes(1)
    expect(f.api.events).toHaveBeenCalledTimes(1)
    expect(f.api.events.mock.calls[0]?.[1]).toBe('0')
    a.release()
    await tick(1000)
    expect(f.api.events).toHaveBeenCalledTimes(2)
    b.release()
    await tick(5000)
    expect(f.api.events).toHaveBeenCalledTimes(2)
    for (const unsubscribe of observers) unsubscribe()
    const c = f.lease()
    expect(c.epoch).not.toBe(a.epoch)
    await tick(1)
    expect(f.api.snapshot).toHaveBeenCalledTimes(1)
    expect(f.api.events).toHaveBeenCalledTimes(3)
  })

  it('cold-loads a snapshot when a saved cursor has no state', async () => {
    const f = setup()
    f.client.setQueryData(f.key, { asOfSequence: '300' })
    f.lease()
    await tick(1)
    expect(f.api.snapshot).toHaveBeenCalledTimes(1)
    expect(f.api.events.mock.calls[0]?.[1]).toBe('0')
  })

  it('catches a snapshot/delta race, suppresses catch-up effects, and emits live IDs only after the cache commit', async () => {
    const f = setup()
    const first = batch(f.scope, '1', [queued(f)], 1)
    const second = batch(f.scope, '2', [queued(f, 1)], 2)
    f.api.events.mockImplementation(async (_scope, after) => after === '0' ? page(f.scope, [first]) : page(f.scope, [second]))
    const held = f.lease()
    const cues: Array<{ mode: string; sequence: string; committed: string | undefined }> = []
    held.subscribe((cue) => {
      const facts = f.read()?.facts
      cues.push({ mode: cue.mode, sequence: cue.sequence, committed: facts?.reader === 'graph' ? facts.snapshot.asOfSequence : undefined })
      expect(Object.isFrozen(cue)).toBe(true)
      expect(Object.isFrozen(cue.eventIds)).toBe(true)
      expect(Object.isFrozen(cue.scope)).toBe(true)
    })
    await tick(1)
    expect(cues).toEqual([{ mode: 'catchup', sequence: '1', committed: '1' }])
    await tick(1000)
    expect(cues.at(-1)).toEqual({ mode: 'live', sequence: '2', committed: '2' })
    await tick(1000)
    expect(cues).toHaveLength(2)
  })

  it('bounds pagination bursts and never stores the captured head prematurely', async () => {
    const f = setup()
    f.api.events.mockImplementation(async (_scope, after) => page(f.scope, [batch(f.scope,
      (BigInt(after) + 1n).toString(), [queued(f)], Number(after) + 1)], after, '99'))
    const held = f.lease()
    const live = vi.fn()
    held.subscribe((cue) => { if (cue.mode === 'live') live(cue) })
    await tick(10)
    expect(f.api.events.mock.calls.length).toBeLessThanOrEqual(4)
    const facts = f.read()?.facts
    expect(facts?.reader === 'graph' && BigInt(facts.snapshot.asOfSequence) < 99n).toBe(true)
    expect(live).not.toHaveBeenCalled()
  })

  it('retries a gap from the confirmed cursor before taking an explicit reset snapshot', async () => {
    const f = setup()
    f.api.events.mockResolvedValue(page(f.scope, [batch(f.scope, '3', [queued(f)])], '2'))
    f.lease()
    await tick(1)
    expect(f.api.events.mock.calls[0]?.[1]).toBe('0')
    expect(f.read()?.transport.reason).toBe('GRAPH_GAP')
    await tick(1001)
    expect(f.api.events.mock.calls.every((call) => call[1] === '0')).toBe(true)
    expect(f.api.snapshot.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('makes history expiry explicit and snapshots without emitting reset/backlog live cues', async () => {
    const f = setup()
    const newer = reduceGraphPage(f.snapshot, page(f.scope, [batch(f.scope, '1', [queued(f)])])).snapshot
    f.api.snapshot.mockResolvedValueOnce(f.snapshot).mockResolvedValue(newer)
    f.api.events.mockImplementation(async (_scope, after) => after === '0' ? {
      kind: 'reset', protocolVersion: 1, scope: f.scope, reason: 'history_expired', requestedSequence: '0',
      headSequence: '1', retentionFloor: '1', action: 'fetch_snapshot',
    } : page(f.scope, [], after))
    const listener = vi.fn()
    const held = f.lease()
    const initialEpoch = held.epoch
    held.subscribe(listener)
    await tick(10)
    expect(held.epoch).toBeGreaterThan(initialEpoch)
    expect(f.read()?.epoch).toBe(held.epoch)
    expect(f.api.snapshot).toHaveBeenCalledTimes(2)
    expect(f.read()?.facts).toMatchObject({ reader: 'graph', snapshot: { asOfSequence: '1' } })
    expect(listener).not.toHaveBeenCalled()
  })

  it('discards a delayed old Run request even when the transport ignores AbortSignal', async () => {
    const a = setup('a')
    const b = fixture('b')
    let resolve!: (value: RunGraphSnapshot) => void
    a.api.snapshot.mockImplementationOnce(() => new Promise<RunGraphSnapshot>((done) => { resolve = done }))
    const first = a.lease()
    await tick(1)
    first.release()
    const apiB: RunGraphClient = { ...a.api, snapshot: async () => b.snapshot, events: async (scope, after) => page(scope, [], after) }
    const second = retainRunGraphSync(a.client, b.scope, apiB)
    release.push(second.release)
    await tick(1)
    resolve(a.snapshot)
    await tick(1)
    const data = a.client.getQueryData<RunGraphRecord>(graphRecordKey(b.scope, sessionGeneration()))
    expect(data?.scope.runId).toBe(b.scope.runId)
    expect(data?.facts).toMatchObject({ reader: 'graph', snapshot: { scope: b.scope } })
    expect(a.read()?.facts).toBeUndefined()
  })

  it('fences a delayed same-Run old-version request and refuses simultaneous conflicting version owners', async () => {
    const f = setup()
    let resolve!: (value: RunGraphSnapshot) => void
    f.api.snapshot.mockImplementationOnce(() => new Promise<RunGraphSnapshot>((done) => { resolve = done }))
    const a = f.lease()
    const scope = { ...f.scope, workflowVersionId: 'new-version' }
    expect(() => retainRunGraphSync(f.client, scope, f.api)).toThrow('GRAPH_SCOPE_MISMATCH')
    await tick(1)
    a.release()
    const next = { ...f.snapshot, scope }
    const b = retainRunGraphSync(f.client, scope, { ...f.api, snapshot: async () => next, events: async (pin, after) => page(pin, [], after) })
    release.push(b.release)
    await tick(1)
    resolve(f.snapshot)
    await tick(1)
    expect(f.client.getQueryData<RunGraphRecord>(graphRecordKey(scope, sessionGeneration()))?.facts).toMatchObject({ snapshot: { scope } })
    expect(f.read()?.facts).toBeUndefined()
  })

  it('retains last-confirmed facts on a disconnect and never silently switches readers', async () => {
    const f = setup()
    f.lease()
    await tick(1)
    const facts = f.read()?.facts
    f.api.events.mockRejectedValue(new ApiError({ code: 'NETWORK_ERROR', message: 'Disconnected' }))
    await tick(1000)
    expect(f.read()?.transport.phase).toBe('stale')
    expect(f.read()?.facts).toBe(facts)
    expect(f.api.legacy).not.toHaveBeenCalled()
    f.api.events.mockResolvedValue(page(f.scope, [], '0'))
    await tick(1000)
    expect(f.read()?.transport.phase).toBe('live')
    expect(f.read()?.facts).toBe(facts)
  })

  it('clears active observer facts on 403 without allowing a late response to restore them', async () => {
    const f = setup()
    const observer = new QueryObserver<RunGraphRecord>(f.client, { queryKey: f.key, queryFn: skipToken, enabled: false })
    const unsubscribe = observer.subscribe(() => undefined)
    f.lease()
    await tick(1)
    expect(observer.getCurrentResult().data?.facts).toBeDefined()
    f.api.events.mockRejectedValue(new ApiError({ code: 'GRAPH_READ_ACCESS_DENIED', message: 'Denied' }, 403))
    await tick(1000)
    expect(observer.getCurrentResult().data?.facts).toBeUndefined()
    expect(observer.getCurrentResult().data?.transport.phase).toBe('denied')
    const calls = f.api.events.mock.calls.length
    await tick(5000)
    expect(f.api.events).toHaveBeenCalledTimes(calls)
    unsubscribe()
  })

  it('clears retained unmounted data and aborts requests on session loss', async () => {
    const f = setup()
    const observer = new QueryObserver<RunGraphRecord>(f.client, { queryKey: f.key, queryFn: skipToken, enabled: false })
    const unsubscribe = observer.subscribe(() => undefined)
    f.lease()
    await tick(1)
    let resolve!: (value: ReturnType<typeof page>) => void
    f.api.events.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    await tick(1000)
    beginSessionChange()
    resolve(page(f.scope, [batch(f.scope, '1', [queued(f)])]))
    await tick(1)
    expect(observer.getCurrentResult().data?.facts).toBeUndefined()
    expect(() => retainRunGraphSync(f.client, f.scope, f.api)).toThrow('GRAPH_READ_ACCESS_DENIED')
    unsubscribe()
  })

  it('purges an unmounted cached Run on logout, not just owners that still have active timers', async () => {
    const f = setup()
    const held = f.lease()
    await tick(1)
    held.release()
    expect(f.read()?.facts).toBeDefined()
    beginSessionChange()
    expect(f.read()).toBeUndefined()
  })

  it('continues terminal cleanup polling until the producer confirms settlement', async () => {
    const f = setup()
    const terminal: RunGraphSnapshot = { ...f.snapshot, state: { ...f.snapshot.state,
      run: { ...f.snapshot.state.run, executionState: 'completed', outcome: 'canceled', cleanupPending: true },
    } }
    f.api.snapshot.mockResolvedValue(terminal)
    f.lease()
    await tick(1)
    f.api.events.mockResolvedValue(page(f.scope, [batch(f.scope, '1', [
      { type: 'run.state', state: { ...terminal.state.run, cleanupPending: false } },
    ])]))
    await tick(1000)
    const calls = f.api.events.mock.calls.length
    await tick(5000)
    expect(f.api.events).toHaveBeenCalledTimes(calls)
    expect(f.read()?.facts).toMatchObject({ snapshot: { state: { run: { outcome: 'canceled', cleanupPending: false } } } })
  })

  it('isolates cue failures and reference-counts identical callback subscriptions independently', async () => {
    const f = setup()
    f.api.events.mockResolvedValue(page(f.scope, [batch(f.scope, '1', [queued(f)])]))
    const a = f.lease()
    const b = f.lease()
    const common = vi.fn()
    a.subscribe(common)
    b.subscribe(common)
    a.release()
    b.subscribe(() => { throw new Error('Optional animation failed') })
    await tick(1)
    expect(common).toHaveBeenCalledTimes(1)
    expect(f.read()?.facts).toMatchObject({ snapshot: { asOfSequence: '1' } })
    expect(f.read()?.transport.phase).toBe('live')
  })
})
