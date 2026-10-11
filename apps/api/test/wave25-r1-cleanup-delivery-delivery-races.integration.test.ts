import { describe, expect, it } from 'vitest'
import { deferred, postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { cleanupDeliveryFixtures, within } from './helpers/cleanupDelivery.js'

describe.skipIf(!postgresEnabled)('PostgreSQL approval delivery races', () => {
  const { fixture } = cleanupDeliveryFixtures()

  it('Stop commits independently while the actual provider response remains unresolved', async () => {
    const f = await fixture(), entered = deferred(), release = deferred()
    f.provider.beforeRespond = async () => { entered.resolve(); await release.promise }
    const operation = f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(f.interaction))
    const observed = operation.then((value) => ({ value }), (error: unknown) => ({ error }))
    try {
      await within(entered.promise)
      await within(f.stop())
      expect(await f.runs.hasRequestedStop(f.f.run.id)).toBe(true)
      release.resolve(); await observed
      expect(await f.receipts()).toEqual([])
      const row = (await f.db.pool.query('select state from interaction_graph_resumes where interaction_id=$1', [f.interaction.id])).rows[0]
      expect(row?.state).not.toBe('resumed')
    } finally { release.resolve(); await observed; await f.engine.cancel(f.f.run.id) }
  }, 60000)

  it('a changed native generation cannot consume the old provider response', async () => {
    const f = await fixture(), entered = deferred(), release = deferred()
    f.provider.beforeRespond = async () => { entered.resolve(); await release.promise }
    const operation = f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(f.interaction))
    const observed = operation.then(() => undefined, (error: unknown) => error)
    try {
      await within(entered.promise)
      await f.db.pool.query("update native_session_lanes set record=jsonb_set(record,'{connectionGeneration}','1'::jsonb) where native_session_id=$1", [f.interaction.nativeSessionId])
      release.resolve(); await observed
      expect(await f.receipts()).toEqual([])
      expect((await f.runs.get(f.f.run.id))?.outcome).not.toBe('succeeded')
      expect(f.provider.counts.responses).toBe(1)
    } finally { release.resolve(); await observed }
  }, 60000)
})
