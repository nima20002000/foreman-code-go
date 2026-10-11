import { describe, it } from 'vitest'
import { assertRevocationRejected } from './rh01-selected-run-admission.helpers.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

const cases = (['principal', 'parent'] as const).map((revocation) => ({
  transport: 'mcp' as const,
  revocation,
  boundary: 'existing-row' as const,
}))

describe.skipIf(!postgresEnabled)('RH-01 selected-Run authority is atomic with message admission', () => {
  // Each contention case owns a database and its blocker/revoker connections.
  it.concurrent.each(cases)(
    '$transport rejects $revocation revocation committed during $boundary contention',
    assertRevocationRejected,
    90000,
  )
})
