import { channel } from 'node:diagnostics_channel'
import { lookup } from 'node:dns/promises'
import { once } from 'node:events'
import type { Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createPool } from '../src/infrastructure/pool.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { ownedTestDatabaseUrl } from './helpers/testResources.js'

async function holdPostgresResponses(connectionString: string) {
  const target = new URL(connectionString)
  // Socket addresses are resolved IPs, even when the endpoint uses localhost.
  const hostname = target.hostname.replace(/^\[|\]$/g, '')
  const addresses = new Set((await lookup(hostname, { all: true })).map(result => result.address))
  const connections = channel('net.client.socket')
  const sockets = new Set<Socket>()
  const pending = new Map<Socket, () => void>()
  let current: Socket | undefined
  const keepPaused = () => current?.pause()
  const observe = (message: unknown) => {
    const { socket } = message as { socket: Socket }
    const connected = () => {
      pending.delete(socket)
      if (!socket.remoteAddress || !addresses.has(socket.remoteAddress)
        || socket.remotePort !== Number(target.port || 5432)) return
      current = socket
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    }
    pending.set(socket, connected)
    socket.once('connect', connected)
  }
  connections.subscribe(observe)
  return {
    hold() {
      if (!current || current.destroyed) throw new Error('Owned PostgreSQL connection is unavailable')
      current.pause()
      // Removing the last readable listener resumes data flow, so retain this one until release.
      current.on('readable', keepPaused)
    },
    async received() {
      if (!current || current.destroyed) throw new Error('Owned PostgreSQL connection is unavailable')
      const socket = current
      if (socket.readableLength === 0) {
        // Socket I/O and this abort deadline progress while query timers are frozen.
        await once(socket, 'readable', { signal: AbortSignal.timeout(2000) })
      }
      expect(socket.readableLength).toBeGreaterThan(0)
    },
    release() {
      current?.off('readable', keepPaused)
      current?.resume()
    },
    close() {
      connections.unsubscribe(observe)
      for (const [socket, connected] of pending) socket.off('connect', connected)
      pending.clear()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
  }
}

it.skipIf(!postgresEnabled)('delivers completed queries after a delayed reply while retaining the SQL and response deadlines', async () => {
  const fixture = await currentDatabase()
  try {
    const url = new URL(ownedTestDatabaseUrl())
    url.searchParams.set('options', `-c search_path=${fixture.schema}`)
    // Hold the real connection's incoming bytes; the dedicated endpoint and guard stay unchanged.
    const responses = await holdPostgresResponses(url.toString())
    try {
      const pool = createPool({ connectionString: url.toString(), maxConnections: 1,
        connectionTimeoutMs: 2000, queryTimeoutMs: 1000 }, 'database-response-deadline')
      const table = `response_deadline_${randomUUID().replaceAll('-', '')}`
      try {
        await pool.query('select 1')
        await pool.query(`create table ${table}(value int primary key)`)
        responses.hold()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true })
        const completed = pool.query<{ value: number }>('select 42::int as value')
          .then(result => ({ rows: result.rows }), error => ({ error }))
        await responses.received()
        await vi.advanceTimersByTimeAsync(1001)
        responses.release()
        expect(await completed).toEqual({ rows: [{ value: 42 }] })

        responses.hold()
        const committed = pool.query<{ value: number }>(`insert into ${table}(value) values(42) returning value`)
          .then(result => ({ rows: result.rows }), error => ({ error }))
        await responses.received()
        await vi.advanceTimersByTimeAsync(1001)
        responses.release()
        expect(await committed).toEqual({ rows: [{ value: 42 }] })
        vi.useRealTimers()
        expect((await pool.query(`select value from ${table}`)).rows).toEqual([{ value: 42 }])

        await expect(pool.query('select pg_sleep(2)')).rejects.toMatchObject({ code: '57014' })

        // Pool.query discards the canceled connection. Finish the replacement
        // handshake before withholding a query response.
        await pool.query('select 1')
        responses.hold()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true })
        const silent = pool.query('select 1').catch(error => error as Error)
        await responses.received()
        await vi.advanceTimersByTimeAsync(2001)
        await expect(silent).resolves.toMatchObject({ message: 'Query read timeout' })
      } finally {
        vi.useRealTimers()
        responses.release()
        await pool.end()
      }
    } finally { responses.close() }
  } finally { await fixture.close() }
}, 30_000)
