import { it } from 'vitest'
import { assertWaitingApprovalCredential } from './helpers/waitingApprovalCredentials.js'

it('retains the same requester credential across two lifetimes and resumes through mcp', async () => {
  await assertWaitingApprovalCredential('mcp')
}, 180_000)
