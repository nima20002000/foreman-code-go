import { createFixtureDatabase, dropFixtureDatabase } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { OperatorRuntimeOwner } from '../src/infrastructure/operatorRuntimeOwner.js'
import { RuntimeShutdown } from '../src/infrastructure/runtimeShutdown.js'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

// Runtime-owner advisory locks are DATABASE scoped, not schema scoped. Use a
// disposable database so parallel production integration files cannot collide.
// The test role needs CREATEDB; never alter its privileges or skip on failure.
const connectionString = process.env.TEST_DATABASE_URL!
const databaseName = `runtime_owner_${randomUUID().replaceAll('-', '')}`
const admin = new pg.Client({ connectionString })
const isolatedUrl = new URL(connectionString)
isolatedUrl.pathname = `/${databaseName}`
const owners: OperatorRuntimeOwner[] = []
let created = false

beforeAll(async () => {
  await admin.connect()
  await createFixtureDatabase(admin, databaseName, "template template0")
  created = true
}, 15_000)
afterEach(async () => {
  // These fixtures own no native processes. Tests settle their artificial gates
  // before this deliberate teardown of even a retained-on-failure owner.
  const results = await Promise.allSettled(owners.splice(0).map((owner) => owner.close()))
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Runtime-owner database fixture cleanup failed.')
})
afterAll(async () => {
  try { if (created) await dropFixtureDatabase(admin, databaseName) } finally { await admin.end() }
})

function owner() {
  const value = new OperatorRuntimeOwner(isolatedUrl.toString(), vi.fn())
  owners.push(value)
  return value
}

describe('PR17 F7 PostgreSQL runtime ownership', () => {
  for (const pendingStage of ['runtime', 'reconciliation', 'manager'] as const) {
    it(`rejects a second real owner while ${pendingStage} cleanup is pending, then allows handoff`, async () => {
      const first = owner()
      await first.acquire()
      const pending = gate(); const entered = gate()
      const hold = () => { entered.resolve(); return pending.promise }
      const released = vi.fn(() => first.close())
      const shutdown = new RuntimeShutdown({
        stop: [{ name: 'runtime', run: pendingStage === 'runtime' ? hold : async () => undefined }],
        drain: [{ name: 'reconciliation', run: pendingStage === 'reconciliation' ? hold : async () => undefined }],
        dispose: [{ name: 'native manager', run: pendingStage === 'manager' ? hold : async () => undefined }],
        releaseOwnership: released,
      })
      const app = Fastify()
      app.addHook('preClose', async () => { shutdown.begin() })
      app.addHook('onClose', async () => { await shutdown.finish() })
      // Match server.ts's second hook without ever re-entering app.close().
      app.addHook('onClose', async () => { await shutdown.finish() })
      await app.ready()
      const closing = app.close()
      try {
        await entered.promise
        await expect(owner().acquire()).rejects.toMatchObject({ code: 'OPERATOR_API_ALREADY_OWNED' })
        expect(released).not.toHaveBeenCalled()
        pending.resolve()
        await closing
        expect(released).toHaveBeenCalledTimes(1)
        await expect(owner().acquire()).resolves.toBeUndefined()
      } finally {
        pending.resolve()
        await closing
      }
    }, 15_000)
  }

  it('keeps the real owner connection held when protected cleanup reports uncertainty', async () => {
    const first = owner()
    await first.acquire()
    const dispose = vi.fn(async () => undefined)
    const release = vi.fn(() => first.close())
    const shutdown = new RuntimeShutdown({
      stop: [{ name: 'runtime', run: async () => { throw new Error('native closure is not confirmed') } }],
      drain: [], dispose: [{ name: 'remaining cleanup', run: dispose }], releaseOwnership: release,
    })
    await expect(shutdown.finish()).rejects.toThrow('runtime ownership was not released')
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
    await expect(owner().acquire()).rejects.toMatchObject({ code: 'OPERATOR_API_ALREADY_OWNED' })
    await expect(shutdown.finish()).rejects.toThrow('runtime ownership was not released')
    expect(release).not.toHaveBeenCalled()
  })

  it('coalesces owner acquisition and close without taking stacked advisory locks', async () => {
    const first = owner()
    const acquiring = first.acquire()
    expect(first.acquire()).toBe(acquiring)
    await acquiring
    const closing = first.close()
    expect(first.close()).toBe(closing)
    await closing
    await expect(owner().acquire()).resolves.toBeUndefined()
  })
})
