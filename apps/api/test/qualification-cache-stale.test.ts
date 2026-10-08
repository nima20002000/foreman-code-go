import { describe, expect, it } from 'vitest'
import { QualificationCache } from '../src/modules/harnesses/qualificationCache.js'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('qualification cache stale-while-revalidate', () => {
  it('serves an expired success while one refresh runs, then the refreshed value', async () => {
    let now = 0
    const cache = new QualificationCache<string>(1_000, 8, () => now, true)
    expect(await cache.get('codex', async () => 'first')).toBe('first')
    now = 2_000
    const refresh = deferred<string>()
    let loads = 0
    const load = () => { loads += 1; return refresh.promise }
    expect(await cache.get('codex', load)).toBe('first')
    expect(await cache.get('codex', load)).toBe('first')
    expect(loads).toBe(1)
    refresh.resolve('second')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await cache.get('codex', load)).toBe('second')
  })

  it('reports a failed refresh instead of the old success', async () => {
    let now = 0
    const cache = new QualificationCache<string>(1_000, 8, () => now, true)
    await cache.get('codex', async () => 'first')
    now = 2_000
    const refresh = deferred<string>()
    expect(await cache.get('codex', () => refresh.promise)).toBe('first')
    refresh.reject(new Error('signed out'))
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(cache.get('codex', async () => 'unused')).rejects.toThrow('signed out')
  })

  it('never serves a stale value after invalidation or without the option', async () => {
    let now = 0
    const swr = new QualificationCache<string>(1_000, 8, () => now, true)
    await swr.get('codex', async () => 'first')
    now = 2_000
    swr.clear()
    expect(await swr.get('codex', async () => 'fresh')).toBe('fresh')
    const plain = new QualificationCache<string>(1_000, 8, () => now)
    await plain.get('codex', async () => 'first')
    now = 4_000
    expect(await plain.get('codex', async () => 'fresh')).toBe('fresh')
  })

  it('drops the stale value when invalidated during a refresh', async () => {
    let now = 0
    const cache = new QualificationCache<string>(1_000, 8, () => now, true)
    await cache.get('codex', async () => 'first')
    now = 2_000
    const refresh = deferred<string>()
    expect(await cache.get('codex', () => refresh.promise)).toBe('first')
    cache.clear()
    const waiting = cache.get('codex', async () => 'after-clear')
    refresh.resolve('second')
    expect(await waiting).toBe('after-clear')
  })
})
