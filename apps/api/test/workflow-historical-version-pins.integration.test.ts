import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { assertHistoricalVersionPins } from './helpers/workflowVersionAssertions.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('immutable optional-repeat versions', () => {
  it.each(['http', 'mcp'] as const)(
    '%s retains initial ordinary, repeat and final ordinary Run pins and evidence', async transport => {
      await assertHistoricalVersionPins(transport)
    }, 240000)
})
