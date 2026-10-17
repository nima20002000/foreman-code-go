import { EventEmitter } from 'node:events'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { retainRunSource, withRunSourceUse } from './runSourceUse.js'

function fixture() {
  let connected = false
  let locked = false
  let released = false
  const client = Object.assign(new EventEmitter(), {
    async query() {
      if (!connected || released) throw new Error('Source-use query outside its injected lease')
      locked = true
      return { rows: [], rowCount: 1 }
    },
    release(destroy: boolean) {
      if (!destroy) throw new Error('Source-use session returned to the pool with locks')
      released = true
      locked = false
    },
  })
  const pool = { async connect() {
    connected = true
    return client
  } } as unknown as pg.Pool
  return { pool, connected: () => connected, locked: () => locked, released: () => released }
}

it('uses the injected pool and holds the source-use session until preparation finishes', async () => {
  const f = fixture()
  const entered = deferred()
  const resume = deferred()
  const start = withRunSourceUse(f.pool, 'workspace', async () => {
    await retainRunSource(f.pool, 'snapshot')
    entered.resolve()
    await resume.promise
    return 'accepted'
  })
  const finishedEarly = start.then(() => { throw new Error('Source use finished before its preparation barrier') })
  try {
    await Promise.race([entered.promise, finishedEarly])
    expect(f.connected()).toBe(true)
    expect(f.locked()).toBe(true)
    expect(f.released()).toBe(false)
  } finally {
    resume.resolve()
    await start
  }
  expect(await start).toBe('accepted')
  expect(f.locked()).toBe(false)
  expect(f.released()).toBe(true)
})

it('preserves a preparation error and disposes the injected source-use session', async () => {
  const f = fixture()
  const failure = new Error('Source preparation failed')
  await expect(withRunSourceUse(f.pool, 'workspace', async () => {
    await retainRunSource(f.pool, 'snapshot')
    throw failure
  })).rejects.toBe(failure)
  expect(f.locked()).toBe(false)
  expect(f.released()).toBe(true)
})
