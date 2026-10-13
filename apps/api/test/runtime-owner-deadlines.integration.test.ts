import { createServer, createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { OperatorRuntimeOwner } from '../src/infrastructure/operatorRuntimeOwner.js'
import { DomainError } from '../src/modules/errors.js'
import { readUntil } from './helpers/observableCondition.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

async function stalledReplies(afterReady: number) {
  const upstream = new URL(process.env.TEST_DATABASE_URL!)
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    const backend = createConnection({ host: upstream.hostname, port: Number(upstream.port || 5432) })
    sockets.add(socket)
    sockets.add(backend)
    const close = () => { socket.destroy(); backend.destroy() }
    socket.on('error', close)
    backend.on('error', close)
    socket.on('close', close)
    backend.on('close', close)
    socket.pipe(backend)
    let ready = 0
    let pending = Buffer.alloc(0)
    backend.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const length = pending.readInt32BE(1) + 1
        if (pending.length < length) break
        const frame = pending.subarray(0, length)
        pending = pending.subarray(length)
        if (ready < afterReady) socket.write(frame)
        if (frame[0] === 90) ready += 1
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected the fault proxy TCP address')
  const url = new URL(upstream)
  url.hostname = '127.0.0.1'
  url.port = String(address.port)
  url.searchParams.set('sslmode', 'disable')
  return { url: url.toString(), async close() {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}

describe.skipIf(!postgresEnabled)('runtime owner with PostgreSQL reply loss', () => {
  it.each(['acquire', 'epoch', 'close'] as const)('bounds %s and releases its physical advisory-lock session', async (operation) => {
    const proxy = await stalledReplies(operation === 'acquire' ? 1 : 2)
    const owner = new OperatorRuntimeOwner(proxy.url, () => undefined)
    let successor: OperatorRuntimeOwner | undefined
    let work: Promise<unknown> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (operation !== 'acquire') await owner.acquire()
      work = operation === 'acquire' ? owner.acquire()
        : operation === 'epoch' ? owner.readRuntimeEpoch() : owner.close()
      const result = work.then(() => 'success', error => error)
      const watchdog = new Promise<string>(resolve => { timer = setTimeout(() => resolve('unbounded'), 7000) })
      expect(await Promise.race([result, watchdog])).toBeInstanceOf(Error)
      expect(owner.active).toBe(false)
      successor = await readUntil(async () => {
        const candidate = new OperatorRuntimeOwner(process.env.TEST_DATABASE_URL!, () => undefined)
        try {
          await candidate.acquire()
          return candidate
        } catch (error) {
          await candidate.close()
          if (error instanceof DomainError && error.code === 'OPERATOR_API_ALREADY_OWNED') return undefined
          throw error
        }
      }, candidate => candidate !== undefined, { timeoutMs: 5000, description: 'released runtime-owner session' })
      expect(successor?.active).toBe(true)
    } finally {
      if (timer) clearTimeout(timer)
      await proxy.close()
      if (work) await work.catch(() => { /* ignore: the operation's failure is asserted above. */ })
      await owner.close().catch(() => { /* ignore: a failed unlock still closes the physical session. */ })
      await successor?.close()
    }
  }, 20_000)
})
