import { describe, expect, it } from 'vitest'
import { OwnerSetupRequestSchema, safeAuthReturnTo } from './browserAuth.js'

describe('browser auth contracts', () => {
  it('rejects caller-supplied authority and normalizes owner email', () => {
    const input = { email: ' OWNER@EXAMPLE.TEST ', password: 'long-test-password' }
    expect(OwnerSetupRequestSchema.parse(input).email).toBe('owner@example.test')
    for (const field of ['name', 'setupSecret', 'grants', 'role', 'principalId', 'callbackURL']) {
      expect(OwnerSetupRequestSchema.safeParse({ ...input, [field]: 'admin' }).success).toBe(false)
    }
  })
  it('keeps redirect destinations local and does not loop back into auth', () => {
    expect(safeAuthReturnTo('/settings/workspaces?view=defaults')).toBe('/settings/workspaces?view=defaults')
    for (const path of [undefined, 'https://evil.test', '//evil.test', '/%2f%2fevil.test', '/%5cevil.test', '/sign-in', '/setup', '/api/auth/session']) {
      expect(safeAuthReturnTo(path)).toBe('/workspaces')
    }
  })
})
