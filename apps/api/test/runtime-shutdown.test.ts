import { describe, expect, it, vi } from 'vitest'

import { RuntimeShutdown } from '../src/infrastructure/runtimeShutdown.js'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('runtime shutdown ownership barrier', () => {
  it('signals every runtime before waiting; drains producers, disposes, then releases', async () => {
    const stop = gate(); const producer = gate(); const disposal = gate()
    const disposing = gate(); const draining = gate()
    const calls: string[] = []
    const releaseOwnership = vi.fn(async () => { calls.push('unlock') })
    const shutdown = new RuntimeShutdown({
      stop: [
        { name: 'chat', run: () => { calls.push('signal chat'); return stop.promise } },
        { name: 'reviews', run: () => { calls.push('signal reviews') } },
        { name: 'engine', run: () => { calls.push('signal engine') } },
      ],
      drain: [{ name: 'recovery', run: () => { calls.push('drain'); draining.resolve(); return producer.promise } }],
      dispose: [{ name: 'managers', run: () => { calls.push('dispose'); disposing.resolve(); return disposal.promise } }],
      releaseOwnership,
    })
    shutdown.begin()
    expect(calls).toEqual(['signal chat', 'signal reviews', 'signal engine'])
    const first = shutdown.finish()
    expect(shutdown.finish()).toBe(first)
    expect(releaseOwnership).not.toHaveBeenCalled()
    stop.resolve()
    await draining.promise
    expect(calls).not.toContain('dispose')
    producer.resolve()
    await disposing.promise
    expect(releaseOwnership).not.toHaveBeenCalled()
    disposal.resolve()
    await first
    expect(calls).toEqual(['signal chat', 'signal reviews', 'signal engine', 'drain', 'dispose', 'unlock'])
    await shutdown.finish()
    expect(releaseOwnership).toHaveBeenCalledTimes(1)
  })

  for (const failing of ['stop', 'drain', 'dispose'] as const) {
    it(`retains ownership and the rejected result after a ${failing} failure`, async () => {
      const failure = new Error('closure is uncertain')
      const cleanup = vi.fn(async () => undefined)
      const releaseOwnership = vi.fn(async () => undefined)
      const step = (stage: string) => ({ name: stage, run: async () => { if (stage === failing) throw failure } })
      const shutdown = new RuntimeShutdown({
        stop: [step('stop')], drain: [step('drain')],
        dispose: [step('dispose'), { name: 'other manager', run: cleanup }], releaseOwnership,
      })
      const result = shutdown.finish()
      await expect(result).rejects.toThrow('runtime ownership was not released')
      expect(shutdown.finish()).toBe(result)
      await expect(shutdown.finish()).rejects.toBeInstanceOf(AggregateError)
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(releaseOwnership).not.toHaveBeenCalled()
    })
  }

  it('does not skip sibling cancellation when a public stop throws synchronously', async () => {
    const sibling = vi.fn()
    const releaseOwnership = vi.fn(async () => undefined)
    const shutdown = new RuntimeShutdown({
      stop: [{ name: 'broken', run: () => { throw new Error('stop failed') } }, { name: 'sibling', run: sibling }],
      drain: [], dispose: [], releaseOwnership,
    })
    await expect(shutdown.finish()).rejects.toBeInstanceOf(AggregateError)
    expect(sibling).toHaveBeenCalledOnce()
    expect(releaseOwnership).not.toHaveBeenCalled()
  })

  it('publishes its single-flight result before a synchronous lifecycle re-entry', async () => {
    let reentered: Promise<void> | undefined
    const releaseOwnership = vi.fn(async () => undefined)
    const shutdown = new RuntimeShutdown({
      stop: [{ name: 'reenter', run: () => { reentered = shutdown.finish() } }],
      drain: [], dispose: [], releaseOwnership,
    })
    const result = shutdown.finish()
    expect(reentered).toBe(result)
    await result
    expect(releaseOwnership).toHaveBeenCalledTimes(1)
  })

  it('propagates ownership-release failure instead of claiming shutdown succeeded', async () => {
    const failure = new Error('unlock failed')
    const releaseOwnership = vi.fn(async () => { throw failure })
    const shutdown = new RuntimeShutdown({ stop: [], drain: [], dispose: [], releaseOwnership })
    await expect(shutdown.finish()).rejects.toBe(failure)
    await expect(shutdown.finish()).rejects.toBe(failure)
    expect(releaseOwnership).toHaveBeenCalledTimes(1)
  })
})
