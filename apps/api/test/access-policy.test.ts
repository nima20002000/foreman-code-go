import { describe, expect, it } from 'vitest'

import { isAuthorized } from '../src/modules/access/policy.js'

const principal = {
  id: 'principal-1', name: 'Worker named Operator', audience: 'operator' as const,
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['workflows:read' as const], scope: { workspaceIds: ['workspace-1'] } }],
}

describe('management access policy', () => {
  it('is deny-by-default and scopes resources', () => {
    expect(isAuthorized(principal, 'workflows:read', { workspaceId: 'workspace-1' })).toBe(true)
    expect(isAuthorized(principal, 'workflows:read', { workspaceId: 'workspace-2' })).toBe(false)
    expect(isAuthorized(principal, 'workflows:update', { workspaceId: 'workspace-1' })).toBe(false)
  })

  it('does not derive authority from a display name or worker audience', () => {
    expect(isAuthorized({ ...principal, audience: 'worker' }, 'workflows:read', { workspaceId: 'workspace-1' })).toBe(false)
    expect(isAuthorized({ ...principal, revokedAt: '2026-09-15T00:00:00.000Z' }, 'workflows:read', { workspaceId: 'workspace-1' })).toBe(false)
  })
})
