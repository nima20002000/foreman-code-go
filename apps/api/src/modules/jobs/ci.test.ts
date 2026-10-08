import type pg from 'pg'
import { expect, it } from 'vitest'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { ciFixture } from '../../../test/helpers/ciFixture.js'
import { CiService } from './ci.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function database() {
  const bothRequests = deferred()
  const lockWaiters: Array<() => void> = []
  const poolWaiters: Array<() => void> = []
  let locked = false
  let lockRequests = 0
  let connections = 0
  const connection = () => ({
    async query(text: string) {
      if (text.includes('pg_advisory_unlock')) {
        const next = lockWaiters.shift()
        if (next) next()
        else locked = false
      } else if (text.includes('pg_advisory_lock')) {
        lockRequests++
        if (lockRequests === 2) bothRequests.resolve()
        if (locked) await new Promise<void>(done => { lockWaiters.push(done) })
        else locked = true
      }
      return { rows: [] }
    },
  })
  const pool = {
    async connect() {
      if (connections === 2) await new Promise<void>(done => { poolWaiters.push(done) })
      else connections++
      return { ...connection(), release() {
        const next = poolWaiters.shift()
        if (next) next()
        else connections--
      } }
    },
    async query() {
      const client = await pool.connect()
      try { return { rows: [] } } finally { client.release() }
    },
  }
  return { pool: pool as unknown as pg.Pool, connection, bothRequests }
}

it('enqueues concurrent same-suite requests with a two-connection pool and nested reads', async () => {
  const f = ciFixture()
  const db = database()
  const commands = {
    execute: async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
      const client = db.connection() as unknown as pg.PoolClient
      return f.commands.execute({ ...input, perform: () => input.perform(client) })
    },
  } as unknown as PostgresCommandCoordinator
  const choices = f.jobs.choices.bind(f.jobs)
  f.jobs.choices = async (...args) => {
    await db.bothRequests.promise
    await db.pool.query('select 1')
    return choices(...args)
  }
  const ci = new CiService(db.pool, commands, f.authority, f.sources, f.jobs)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const requests = Promise.all(['first', 'second'].map(commandId => ci.run(f.operator, {
      workspaceId: f.workspaceId, commandId, suite: 'unit',
    })))
    const results = await Promise.race([requests, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('CI requests exhausted the application pool.')), 500)
    })])
    expect(results).toHaveLength(2)
    expect(results[0]!.ticketId).not.toBe(results[1]!.ticketId)
    expect(f.counts().enqueues).toBe(2)
  } finally { if (timer) clearTimeout(timer) }
})
