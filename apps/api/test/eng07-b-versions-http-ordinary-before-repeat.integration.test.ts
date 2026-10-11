import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { assertHistoricalVersionPins } from './helpers/workflowVersionAssertions.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('immutable optional-repeat versions over HTTP', () => {
  it('http: ordinary → repeat → ordinary retains ordinary before repeat Run pins and exact evidence', async () => {
    await assertHistoricalVersionPins('http', 0)
  }, 240000)
})
