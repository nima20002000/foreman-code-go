import { EventEmitter } from 'node:events'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { retainRunSource, withRunSourceUse } from './runSourceUse.js'

type Use = { use_id: string; snapshot_id: string; owner: unknown }
function fixture() {
  let held = false
  const uses = new Map<string, Use>()
  const query = async (text: string, values: unknown[] = []) => {
    if (text.startsWith('insert')) {
      const [useId, snapshotId, owner] = values as [string, string, string]
      uses.set(useId, { use_id: useId, snapshot_id: snapshotId, owner: JSON.parse(owner) })
      return { rows: [{ snapshot_id: snapshotId }], rowCount: 1 }
    }
    if (text.startsWith('delete')) {
      const ids = Array.isArray(values[0]) ? values[0] : [values[0]]
      for (const id of ids) uses.delete(String(id))
      return { rows: [], rowCount: ids.length }
    }
    return { rows: [...uses.values()], rowCount: uses.size }
  }
  const connect = async () => {
    if (held) throw new Error('Pool connection unavailable')
    held = true
    return Object.assign(new EventEmitter(), {
      query,
      release() { held = false },
    })
  }
  const pool = { connect, async query(text: string, values?: unknown[]) {
    const client = await connect()
    try { return await client.query(text, values) } finally { client.release() }
  } } as unknown as pg.Pool
  const readSource = async () => {
    const sql = await pool.connect()
    try { await retainRunSource(pool, sql, 'snapshot') } finally { sql.release() }
  }
  return { pool, held: () => held, uses, readSource }
}

it('keeps snapshot use persisted while releasing the connection before slow preparation', async () => {
  const f = fixture()
  const entered = deferred()
  const resume = deferred()
  const start = withRunSourceUse(f.pool, 'workspace', async () => {
    await f.readSource()
    entered.resolve()
    await resume.promise
    return 'accepted'
  })
  const finishedEarly = start.then(() => { throw new Error('Source use finished before its preparation barrier') })
  try {
    await Promise.race([entered.promise, finishedEarly])
    expect(f.held()).toBe(false)
    expect(f.uses.size).toBe(1)
    const accountConnection = await f.pool.connect()
    accountConnection.release()
    expect(f.uses.size).toBe(1)
  } finally {
    resume.resolve()
    await start
  }
  expect(await start).toBe('accepted')
  expect(f.held()).toBe(false)
  expect(f.uses.size).toBe(0)
})

it('preserves a preparation error and releases its persisted snapshot use', async () => {
  const f = fixture()
  const failure = new Error('Source preparation failed')
  await expect(withRunSourceUse(f.pool, 'workspace', async () => {
    await f.readSource()
    throw failure
  })).rejects.toBe(failure)
  expect(f.held()).toBe(false)
  expect(f.uses.size).toBe(0)
})
