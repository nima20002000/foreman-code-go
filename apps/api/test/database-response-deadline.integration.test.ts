import { createConnection, createServer, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { createPool } from '../src/infrastructure/pool.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

async function forwardPostgres(connectionString: string) {
  const upstream = new URL(connectionString)
  const sockets = new Set<Socket>()
  const queued: { socket: Socket; data: Buffer | string }[] = []
  let holdResponses = false
  const server = createServer(client => {
    const database = createConnection({ host: upstream.hostname, port: Number(upstream.port || 5432) })
    for (const socket of [client, database]) {
      sockets.add(socket)
      socket.on('error', () => { client.destroy(); database.destroy() })
      socket.on('close', () => { sockets.delete(socket); client.destroy(); database.destroy() })
    }
    client.pipe(database)
    database.on('data', data => {
      if (holdResponses) queued.push({ socket: client, data })
      else client.write(data)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('PostgreSQL test proxy did not listen')
  const url = new URL(connectionString)
  url.hostname = '127.0.0.1'
  url.port = String(address.port)
  return {
    connectionString: url.toString(),
    hold() { holdResponses = true },
    async received() { await expect.poll(() => queued.length, { timeout: 2000 }).toBeGreaterThan(0) },
    release() {
      holdResponses = false
      for (const { socket, data } of queued.splice(0)) if (!socket.destroyed) socket.write(data)
    },
    async close() {
      queued.length = 0
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

it.skipIf(!postgresEnabled)('delivers completed queries after a delayed reply while retaining the SQL and response deadlines', async () => {
  const fixture = await currentDatabase()
  try {
    const url = new URL(process.env.TEST_DATABASE_URL!)
    url.searchParams.set('options', `-c search_path=${fixture.schema},public`)
    const proxy = await forwardPostgres(url.toString())
    try {
      const pool = createPool({ connectionString: proxy.connectionString, maxConnections: 1,
        connectionTimeoutMs: 2000, queryTimeoutMs: 1000 }, 'database-response-deadline')
      const table = `response_deadline_${randomUUID().replaceAll('-', '')}`
      try {
        await pool.query('select 1')
        await pool.query(`create table ${table}(value int primary key)`)
        proxy.hold()
        const readStarted = Date.now()
        const completed = pool.query<{ value: number }>('select 42::int as value')
          .then(result => ({ rows: result.rows }), error => ({ error }))
        await proxy.received()
        await delay(Math.max(0, 1250 - (Date.now() - readStarted)))
        proxy.release()
        expect(await completed).toEqual({ rows: [{ value: 42 }] })

        proxy.hold()
        const writeStarted = Date.now()
        const committed = pool.query<{ value: number }>(`insert into ${table}(value) values(42) returning value`)
          .then(result => ({ rows: result.rows }), error => ({ error }))
        await proxy.received()
        await delay(Math.max(0, 1250 - (Date.now() - writeStarted)))
        proxy.release()
        expect(await committed).toEqual({ rows: [{ value: 42 }] })
        expect((await pool.query(`select value from ${table}`)).rows).toEqual([{ value: 42 }])

        await expect(pool.query('select pg_sleep(2)')).rejects.toMatchObject({ code: '57014' })

        proxy.hold()
        const silent = pool.query('select 1').catch(error => error as Error)
        await proxy.received()
        await expect(silent).resolves.toMatchObject({ message: 'Query read timeout' })
      } finally {
        proxy.release()
        await pool.end()
      }
    } finally { await proxy.close() }
  } finally { await fixture.close() }
}, 30_000)
