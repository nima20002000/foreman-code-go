import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { inspectRepeatRun } from './helpers/runInspectionScenario.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('ENG05-D production Start and bounded inspection parity', () => {
  it.each([
    { exit: 'limit', maxOccurrences: 14, expectedOccurrences: 14 },
  ] as const)('reads $exit exit through bounded pages, keeps the old pin, and removes repeat for a later ordinary Run',
    inspectRepeatRun, 720000)
})
