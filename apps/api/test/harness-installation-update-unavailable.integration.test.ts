import { describe, it } from 'vitest'
import { retainsRunAcrossUnavailableInstallation } from './helpers/harnessInstallationUnavailable.js'

describe('installed harness updates', () => {
  it.each(['main', 'worker'] as const)(
    'retains a resident %s Run across unavailable inventory before a completed payload replacement',
    retainsRunAcrossUnavailableInstallation, 240_000)
})
