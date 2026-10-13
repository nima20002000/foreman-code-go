import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { assertHistoricalVersionPins } from './helpers/workflowVersionAssertions.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('immutable optional-repeat versions', () => {
  describe.each(['http', 'mcp'] as const)('over %s', transport => {
    it.each([
      { evidence: 'initial ordinary', index: 0 },
      { evidence: 'repeat', index: 1 },
      { evidence: 'final ordinary', index: 2 },
    ])('retains all historical Run pins and $evidence Run evidence', async ({ index }) => {
      await assertHistoricalVersionPins(transport, index)
    }, 240000)
  })
})
