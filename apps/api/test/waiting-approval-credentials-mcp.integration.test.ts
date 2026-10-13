import { it } from 'vitest'
import { assertWaitingApprovalCredential } from './helpers/waitingApprovalCredential.js'

it('retains the same requester credential across two lifetimes and resumes through mcp', async () => {
  await assertWaitingApprovalCredential('mcp')
}, 180_000)
