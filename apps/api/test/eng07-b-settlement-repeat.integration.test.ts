import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { assertCleanupWaitsForOriginalWriter } from './helpers/settlementScenario.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('ENG07-B real terminal-before-cleanup-check gap', () => {
  it.each(['S3-05-early'] as const)('%s waits for the original cleanup writer, without driving the engine',
    assertCleanupWaitsForOriginalWriter, 90000)
})
