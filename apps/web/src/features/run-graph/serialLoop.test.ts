import { describe, expect, it, vi } from 'vitest'
import { createSerialLoop, type LoopClock } from './serialLoop'

function timer() {
  const pending = new Map<number, { fn: () => void; delay: number }>()
  let next = 0
  const clock: LoopClock = { schedule: (fn, delay) => { pending.set(++next, { fn, delay }); return next }, cancel: (id) => { pending.delete(id as number) } }
  return { pending, clock, tick() { const item = [...pending][0]; if (item) { pending.delete(item[0]); item[1].fn() } } }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('serial request/timer ownership', () => {
  it('owns exactly one timer and cannot overlap requests', async () => {
    const t = timer()
    let resolve!: (delay: number) => void
    const work = vi.fn(() => new Promise<number>((done) => { resolve = done }))
    const loop = createSerialLoop(work, vi.fn(), t.clock)
    expect(t.pending.size).toBe(1)
    t.tick(); loop.wake(); t.tick()
    expect(work).toHaveBeenCalledTimes(1)
    expect(t.pending.size).toBe(0)
    resolve(1000); await flush()
    expect([...t.pending.values()].map((item) => item.delay)).toEqual([1000])
    loop.dispose()
    expect(t.pending.size).toBe(0)
  })
  it('fences a late task even when the task ignores abort', async () => {
    const t = timer()
    let resolve!: (delay: number) => void
    const loop = createSerialLoop(() => new Promise<number>((done) => { resolve = done }), vi.fn(), t.clock)
    t.tick(); loop.dispose(); resolve(0); await flush()
    expect(loop.signal.aborted).toBe(true)
    expect(t.pending.size).toBe(0)
  })
  it('can explicitly retry a settled/stopped poll without starting multiple timers', async () => {
    const t = timer()
    const work = vi.fn(async () => false as const)
    const loop = createSerialLoop(work, vi.fn(), t.clock)
    t.tick(); await flush()
    expect(t.pending.size).toBe(0)
    loop.wake(); loop.wake()
    expect(t.pending.size).toBe(1)
    t.tick(); await flush()
    expect(work).toHaveBeenCalledTimes(2)
    loop.dispose()
  })
  it('surfaces an unexpected failure rather than silently restarting it forever', async () => {
    const t = timer()
    const error = new Error('broken task')
    const onError = vi.fn()
    const loop = createSerialLoop(async () => { throw error }, onError, t.clock)
    t.tick(); await flush()
    expect(onError).toHaveBeenCalledWith(error)
    expect(t.pending.size).toBe(0)
    loop.dispose()
  })
})
