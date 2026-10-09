import { describe, expect, it } from 'vitest'
import { SourceApproveInputSchema } from './sourceAdmission.js'

const input = {
  workspaceId: 'workspace-owned',
  commandId: 'approve-source-command',
  expectedLocationRevision: 1,
  commit: 'a'.repeat(40),
  executablePolicy: 'strip',
}

describe('source approval choice', () => {
  it('accepts an explicit inventory or explicit approval of the tracked commit tree', () => {
    expect(SourceApproveInputSchema.parse({ ...input, approvedPaths: ['src/app.ts'] }))
      .toEqual({ ...input, approvedPaths: ['src/app.ts'] })
    expect(SourceApproveInputSchema.parse({ ...input, approveTrackedTree: true }))
      .toEqual({ ...input, approveTrackedTree: true })
  })

  it.each([
    {},
    { approvedPaths: [] },
    { approveTrackedTree: false },
    { approvedPaths: ['src/app.ts'], approveTrackedTree: true },
    { approvedPaths: ['src/app.ts'], approveTrackedTree: false },
  ])('rejects missing, empty or conflicting approval choices: %j', choice => {
    expect(SourceApproveInputSchema.safeParse({ ...input, ...choice }).success).toBe(false)
  })
})
