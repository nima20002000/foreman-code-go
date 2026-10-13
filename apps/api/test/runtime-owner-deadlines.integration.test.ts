import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { OperatorRuntimeOwner } from '../src/infrastructure/operatorRuntimeOwner.js'
import { DomainError } from '../src/modules/errors.js'
import { readUntil } from './helpers/observableCondition.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { deferred } from './helpers/deferred.js'

async function stalledReplies(afterReady: number) {
  const query = pg.Client.prototype.query as unknown as
    (this: pg.Client, ...args: unknown[]) => Promise<pg.QueryResult>
  const release = deferred()
  let ownerClient: pg.Client | undefined
  let replies = 0
  // Keep the guarded disposable endpoint; suppress delivery after PostgreSQL executes the query.
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation((function (
    this: pg.Client, ...args: unknown[]
  ) {
    const response = query.apply(this, args)
    if (!ownerClient && args[0] !== 'select pg_try_advisory_lock($1) as acquired') return response
    ownerClient ??= this
    if (this !== ownerClient || ++replies < afterReady) return response
    return response.then(async result => {
      await release.promise
      return result
    })
  }) as typeof pg.Client.prototype.query)
  return { url: process.env.TEST_DATABASE_URL!, async close() {
    spy.mockRestore()
    release.resolve()
  } }
}

describe.skipIf(!postgresEnabled)('runtime owner with PostgreSQL reply loss', () => {
  it('acquires ownership and reads an epoch before injecting reply loss', async () => {
    const proxy = await stalledReplies(3)
    const owner = new OperatorRuntimeOwner(proxy.url, () => undefined)
    try {
      await owner.acquire()
      expect(owner.active).toBe(true)
      expect(await owner.readRuntimeEpoch()).toMatch(/^\d+$/)
    } finally {
      await proxy.close()
      await owner.close().catch(() => { /* ignore: cleanup after a failed acquisition reports its original failure. */ })
    }
  })

  it.each(['acquire', 'epoch', 'close'] as const)('bounds %s and releases its physical advisory-lock session', async (operation) => {
    const monitor = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL! })
    await monitor.connect()
    const proxy = await stalledReplies(operation === 'acquire' ? 1 : 2)
    const owner = new OperatorRuntimeOwner(proxy.url, () => undefined)
    let successor: OperatorRuntimeOwner | undefined
    let work: Promise<unknown> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (operation !== 'acquire') await owner.acquire()
      const readOwnerPid = async () => (await monitor.query<{ pid: number }>(`
        select pid from pg_locks where locktype='advisory' and classid=0::oid
          and objid=710014::oid and objsubid=1 and granted
          and database=(select oid from pg_database where datname=current_database())`)).rows[0]?.pid
      let ownerPid = operation === 'acquire' ? undefined : await readOwnerPid()
      work = operation === 'acquire' ? owner.acquire()
        : operation === 'epoch' ? owner.readRuntimeEpoch() : owner.close()
      const result = work.then(() => 'success', error => error)
      if (operation === 'acquire') {
        ownerPid = await readUntil(readOwnerPid, pid => pid !== undefined,
          { timeoutMs: 4000, description: 'server-side runtime ownership before lost reply' })
      }
      expect(ownerPid).toBeDefined()
      const watchdog = new Promise<string>(resolve => { timer = setTimeout(() => resolve('unbounded'), 7000) })
      expect(await Promise.race([result, watchdog])).toMatchObject({
        code: 'NATIVE_RUNTIME_DATABASE_TIMEOUT',
      })
      expect(owner.active).toBe(false)
      await readUntil(async () => (await monitor.query(
        'select pid from pg_stat_activity where pid=$1', [ownerPid])).rows.length,
      count => count === 0, { timeoutMs: 5000, description: 'closed runtime-owner backend' })
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
      await monitor.end()
    }
  }, 20_000)
})
