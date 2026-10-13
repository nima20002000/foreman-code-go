import { describe, it } from 'vitest'
import { assertActiveTurnRestart } from './helpers/workflowActiveTurnRestart.js'

describe('main workflow turns after abrupt API owner loss', () => {
  for (const completion of ['after reconnect', 'while API is down'] as const) {
    it(`recovers the original turn and its result ${completion}`, async () => {
      await assertActiveTurnRestart({ executionHost: 'main', mode: 'crash', completion })
    }, 240_000)
  }
})
