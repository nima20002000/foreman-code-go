import net from 'node:net'
import pg from 'pg'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { agent3Database } from './helpers/wave25Agent3.js'

async function responseProxy(url: string) {
  const target = new URL(url)
  const sockets = new Set<net.Socket>()
  let blocked = false
  const server = net.createServer(downstream => {
    const upstream = net.connect({ host: target.hostname, port: Number(target.port || 5432) })
    sockets.add(downstream)
    sockets.add(upstream)
    downstream.on('data', bytes => upstream.write(bytes))
    upstream.on('data', bytes => { if (!blocked) downstream.write(bytes) })
    const close = () => {
      downstream.destroy()
      upstream.destroy()
      sockets.delete(downstream)
      sockets.delete(upstream)
    }
    downstream.on('error', close)
    upstream.on('error', close)
    downstream.on('close', close)
    upstream.on('close', close)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a proxy port')
  target.hostname = '127.0.0.1'
  target.port = String(address.port)
  return { url: target.toString(), block: () => { blocked = true },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    } }
}

it('releases a real Run owner and its advisory lock while rollback replies remain unavailable', async () => {
  const db = await agent3Database()
  const proxy = await responseProxy(process.env.TEST_DATABASE_URL!)
  const pool = new pg.Pool({ ...db.pool.options, connectionString: proxy.url, query_timeout: 100 })
  const lost = vi.fn()
  const owner = await RunOwnership.acquire(pool, 'rollback-owner', lost)
  if (!owner) throw new Error('Expected the original Run owner')
  let replacement: RunOwnership | undefined
  try {
    const connection = owner.oneShotConnection()
    const work = vi.fn(async (sql: GraphTransactionSql) => {
      await sql.query('select 1')
      proxy.block()
      await sql.query('select 2')
    })
    const failed = connection.transaction(work).catch(error => error)
    const queued = connection.query('select 3').catch(error => error)
    await delay(250)
    await owner.release()
    expect(await failed).toMatchObject({ message: 'Query read timeout' })
    expect(await queued).toMatchObject({ code: 'GRAPH_TRANSACTION_FAILED' })
    expect(connection.unusable).toBe(true)
    expect(work).toHaveBeenCalledOnce()
    await vi.waitFor(async () => {
      replacement ??= await RunOwnership.acquire(db.pool, owner.runId, () => undefined)
      expect(replacement).toBeDefined()
    }, { timeout: 3_000, interval: 10 })
    expect((await replacement!.client.query('select 1 as usable')).rows).toEqual([{ usable: 1 }])
  } finally {
    await owner.release()
    await replacement?.release()
    await pool.end()
    await proxy.close()
    await db.close()
  }
}, 60_000)
