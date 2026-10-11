import { describe, it } from 'vitest'
import { installApprovalCleanup, stopApprovalWithActiveSibling } from './helpers/approvalInterruptPublication.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

installApprovalCleanup()

describe.skipIf(!postgresEnabled)('approval interrupt publication Stop with pending approval', () => {
  it.each(['pending'] as const)(
    'keeps the first Stop and late sibling output fenced after a %s approval', async (status) => {
      await stopApprovalWithActiveSibling(status)
    }, 60_000)
})
