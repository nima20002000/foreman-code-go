import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUN_INSPECTION_TOOLS, RunVersionDetailSchema } from '@foreman-code/contracts/wave25'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { readback, readParity, recoveryFixture, scope } from './helpers/eng06DRecovery.js'
import { forms } from './helpers/recoveryReadback.js'

afterEach(() => vi.restoreAllMocks())

// These are normal positive assertions, not expected-failure tests. In particular
// d32a361 cold cleanup requires a scoped physical-disposal callback. The helper
// simulates that external boundary, never SQL receipts, native ACKs or results.
describe.skipIf(!postgresEnabled)('ENG06-D recovery readback over real HTTP and authenticated Operator MCP', () => {
  it.each(forms)('%s: terminal state, exact results, inputs and version pins survive two API rebuilds without native work', async (form) => {
    const f = await recoveryFixture(form)
    try {
      f.launch(); await f.settled()
      const before = await readback(f)
      expect(before.record.run.outcome).toBe('succeeded')
      expect(before.record.run.result).toBeDefined()
      const version = RunVersionDetailSchema.parse(await readParity(f, RUN_INSPECTION_TOOLS.version, scope(f)))
      const counts = { ...f.provider.counts }
      for (let restart = 0; restart < 2; restart++) {
        const oldApp = f.transport.app, oldRuns = f.runtime.runs, oldEngine = f.runtime.engine, oldSaver = f.runtime.checkpointer
        await f.restart()
        expect(f.transport.app).not.toBe(oldApp)
        expect(f.runtime.runs).not.toBe(oldRuns); expect(f.runtime.engine).not.toBe(oldEngine)
        expect(f.runtime.checkpointer).not.toBe(oldSaver)
        expect(await readback(f)).toEqual(before)
        expect(await readParity(f, RUN_INSPECTION_TOOLS.version, scope(f))).toEqual(version)
        expect(f.provider.counts.starts).toBe(counts.starts)
        expect(f.provider.counts.sessions).toBe(counts.sessions)
        expect(f.provider.counts.attaches).toBe(counts.attaches)
      }
      if (form === 'sequential') {
        expect(version.version.definition).not.toHaveProperty('repeat')
        for (const item of before.page.items) expect(item).not.toHaveProperty('occurrence')
      } else expect(new Set(before.page.items.map((item) => item.occurrence!.occurrenceIndex))).toEqual(new Set([1, 2, 3]))
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
