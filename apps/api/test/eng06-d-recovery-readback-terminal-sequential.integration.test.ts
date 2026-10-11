import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { terminalRecoveryReadback } from './helpers/terminalRecoveryReadback.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('ENG06-D recovery readback over real HTTP and authenticated Operator MCP', () => {
  it.each(['sequential'] as const)('%s: terminal state, exact results, inputs and version pins survive two API rebuilds without native work', terminalRecoveryReadback, 90000)
})
