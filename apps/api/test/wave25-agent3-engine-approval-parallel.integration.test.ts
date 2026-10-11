import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { executeApprovalBranches } from './helpers/engineProviderCases.js'

/** Actual engine, SQL owners, coordinator, capture and approval services.
 * Only external provider transport and filesystem qualification are synthetic. */
describe.skipIf(!postgresEnabled)('Current production engine provider wiring', () => {
  afterEach(() => vi.restoreAllMocks())
  it('executes 2 approval branches through exact native claims and terminal receipts', async () => {
    await executeApprovalBranches(2)
  }, 60000)
})
