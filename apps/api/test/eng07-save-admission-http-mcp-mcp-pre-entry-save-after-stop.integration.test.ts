import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { nativeSavePreEntryFixtures } from './helpers/nativeSavePreEntryFixture.js'
import { assertSettled, meaningfulInput, parkBeforeNativeEntry,
  saveThrough, versionCount, type Transport } from './helpers/eng07SaveAdmission.testSupport.js'
import { assertNewVersionOnly, nativeFacts } from './helpers/saveAdmissionTransport.js'

const transport = 'mcp' as Transport

describe.skipIf(!postgresEnabled)(`ENG07 native Save admission over ${transport}`, () => {
  const createFixture = nativeSavePreEntryFixtures()

  for (const form of ['single', 'repeat'] as const) {
    it(`${form}: meaningful Save after Stop-before-native-entry uses the canonical seal`, async () => {
      const f = await createFixture(form)
      const gate = parkBeforeNativeEntry(f)
      try {
        const execution = await gate.parked
        const before = (await f.db.pool.query('select phase from workflow_native_entries where execution_id=$1', [execution.id])).rows[0]!
        expect(['reserved', 'prepared']).toContain(before.phase)
        await f.stop() // Real authorized durable Stop; the engine owns negative settlement.
        await f.engine.cancel(f.f.run.id)
        await gate.drive
        await assertSettled(f)
        const entries = (await f.db.pool.query('select phase from workflow_native_entries where execution_id=$1', [execution.id])).rows
        expect(entries).toEqual([{ phase: 'not_submitted' }])
        expect((await f.runs.getExecution(execution.id))?.nativeSessionId).toBeUndefined()
        expect(f.provider.counts).toEqual({ sessions: 0, starts: 0, responses: 0, attaches: 0 })
        const input = await meaningfulInput(f), count = await versionCount(f), facts = await nativeFacts(f)
        const saved = await saveThrough(f, transport, input)
        expect(agentWorkflowNode(saved.value.version.definition.nodes[0]).initialPrompt).toBe(agentWorkflowNode(input.graph.nodes[0]).initialPrompt)
        await assertNewVersionOnly(f, count, input.expectedWorkflowVersionId!)
        expect(await nativeFacts(f)).toEqual(facts)
      } finally { gate.release(); await gate.drive; gate.restore(); await f.close() }
    }, 60000)
  }
})
