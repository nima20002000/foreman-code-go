import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { recoverTerminalBeforeClosure, useCrashCutDatabase } from './helpers/restartCrashCuts.js'

/** PostgreSQL, source captures, checkpoint, approval ACK and acceptance services
 * are real. Only provider transport and filesystem qualification are synthetic. */
describe.skipIf(!postgresEnabled)('ENG06 exact restart crash cuts, semantics 3', () => {
  const database = useCrashCutDatabase()
  describe('repeat', () => {
    it.each(['success', 'approval'] as const)(
      'recovers a durable terminal before its closure receipt: %s', async (kind) => {
        await recoverTerminalBeforeClosure(database(), 'repeat', kind)
      }, 60_000)
  })
})
