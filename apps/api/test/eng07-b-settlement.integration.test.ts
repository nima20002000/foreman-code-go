import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunRecordDetailSchema, RUN_INSPECTION_TOOLS } from '@graphql/contracts/wave25'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { scenarioFixture } from './helpers/eng07BScenarios.js'
import { runPath, scenarioHarness } from './helpers/eng07BHarness.js'
import { waitForSuccessfulRunCleanup } from './helpers/runSettlement.testSupport.js'

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('ENG07-B real terminal-before-cleanup commit gap', () => {
  it.each(['S3-01', 'S3-05-early'] as const)('%s waits for the original cleanup writer, without driving the engine', async (id) => {
    const f = await scenarioHarness(scenarioFixture(id, randomUUID()))
    const cleanupEntered = latch(), releaseCleanup = latch(), readOnce = latch()
    const requestCleanup = f.base.runs.requestCleanup.bind(f.base.runs)
    // Timing gate only: the ORIGINAL writer still runs with the same arguments,
    // owner, locks and proof checks. No Run, intent or receipt row is fabricated.
    const gate = vi.spyOn(f.base.runs, 'requestCleanup').mockImplementation(async (...args) => {
      cleanupEntered.release()
      await releaseCleanup.promise
      return requestCleanup(...args)
    })
    let pending: Promise<unknown> | undefined
    try {
      const { saved } = await f.save('http'), started = await f.start('http', saved)
      let entered = false
      void cleanupEntered.promise.then(() => { entered = true })
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 25000 })
      const read = async () => RunRecordDetailSchema.parse(await f.http('GET', `${runPath(started.scope)}/record`))
      const before = await read()
      expect(before).toMatchObject({ run: { executionState: 'completed', outcome: 'succeeded' }, cleanupPending: false })
      expect((await f.base.db.pool.query('select pending,attempts from run_cleanup_intents where run_id=$1',
        [started.scope.runId])).rows).toEqual([])
      const counts = { ...f.base.provider.counts }
      let returned = false
      pending = waitForSuccessfulRunCleanup({ pool: f.base.db.pool, runId: started.scope.runId,
        readRecord: async () => { const value = await read(); readOnce.release(); return value } })
        .then((value) => { returned = true; return value })
      void pending.catch(() => undefined) // The awaited promise below retains failure.
      await Promise.race([readOnce.promise, pending])
      // Drain promise reactions; the cleanup gate, not a wall-clock sleep, keeps
      // the real Run at the formerly false-positive public cut.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(returned, 'A terminal Run with no cleanup intent must not pass the barrier').toBe(false)
      releaseCleanup.release()
      const after = await pending
      expect(after).toEqual(await f.readParity(`${runPath(started.scope)}/record`, RUN_INSPECTION_TOOLS.record,
        { workspaceId: started.scope.workspaceId, runId: started.scope.runId }))
      expect((await f.base.db.pool.query<{ pending: boolean; attempts: number }>(
        'select pending,attempts from run_cleanup_intents where run_id=$1', [started.scope.runId])).rows[0])
        .toMatchObject({ pending: false, attempts: expect.any(Number) })
      await f.settled(started.scope)
      expect(f.base.provider.counts).toEqual(counts)
      expect(f.base.dispatchErrors).toEqual([])
    } finally {
      releaseCleanup.release()
      await pending?.catch(() => undefined)
      gate.mockRestore()
      await f.close()
    }
  }, 90000)
})
