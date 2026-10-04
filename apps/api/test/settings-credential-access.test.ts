import { describe, expect, it } from 'vitest'
import { DEFAULT_MANAGEMENT_ACTIONS } from '@foreman-code/contracts/management'
import { credentialActions } from '../src/cli/credentialAccess.js'
import { parseCredentialArguments } from '../src/cli/operatorCredentialArguments.js'

describe('Browser credential CLI', () => {
  it('read-only actions are an exact read-only subset of the shared catalog', () => {
    expect(credentialActions('read-only')).toEqual(DEFAULT_MANAGEMENT_ACTIONS.filter((action) => action.endsWith(':read')))
    expect(credentialActions('read-only')).not.toContain('harnesses:update')
    expect(credentialActions('read-only')).not.toContain('interactions:respond')
    expect(credentialActions()).toEqual(DEFAULT_MANAGEMENT_ACTIONS)
    expect(credentialActions()).not.toContain('devices:metrics:read')
    expect(credentialActions('read-only')).not.toContain('devices:metrics:read')
  })
  it('requires explicit operator audience for access presets', () => {
    expect(parseCredentialArguments(['issue', '--name', 'Browser', '--access', 'read-only'])).toMatchObject({ audience: 'operator', access: 'read-only' })
    expect(() => parseCredentialArguments(['issue', '--name', 'Worker', '--audience', 'worker', '--access', 'manage'])).toThrow()
    expect(() => parseCredentialArguments(['issue', '--name', 'User', '--audience', 'user', '--access', 'manage'])).toThrow()
  })
})
