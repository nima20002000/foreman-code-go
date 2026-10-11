import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { assertHistoricalVersionPins } from './helpers/workflowVersionAssertions.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('immutable optional-repeat versions over MCP', () => {
  it('mcp: ordinary → repeat → ordinary retains all historical Run pins and initial ordinary Run evidence', async () => {
    await assertHistoricalVersionPins('mcp', 0)
  }, 240000)
})
