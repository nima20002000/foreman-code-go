import { rejectableDeferred } from '../../../test/helpers/deferred.js'
import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { observationFixture } from './observationConcurrency.testSupport.js'

it('leaves half the shared pool available while a full fleet is being observed', async () => {
  const gate = rejectableDeferred<void>()
  const f = observationFixture({ cloud: 48, local: 8, poolSize: 8, beforeRead: () => gate.promise })
  try {
    await f.warm()
    await f.service.dispatch()
    await f.service.dispatch()
    expect(f.reads.length).toBeGreaterThan(0)
    expect(f.reads.length).toBeLessThanOrEqual(4)
    expect(new Set(f.reads).size).toBe(f.reads.length)
  } finally {
    gate.resolve()
    await f.service.close()
  }
})

it('observes every cloud and local ticket across bounded passes without starving later tickets', async () => {
  const f = observationFixture({ cloud: 6, local: 2, poolSize: 2 })
  try {
    await f.warm()
    await f.service.dispatch()
    await setImmediate()
    expect(f.reads).toHaveLength(1)
    for (let pass = 1; pass < f.records.length; pass++) {
      await f.service.dispatch()
      await setImmediate()
    }
    expect(new Set(f.reads)).toEqual(new Set(f.records.map(record => record.id)))
    for (const record of f.records) {
      expect((await f.service.get(f.caller, { ticketId: record.id })).run)
        .toMatchObject({ step: 'checking', observation: { status: 'available' } })
    }
  } finally {
    await f.service.close()
  }
})
