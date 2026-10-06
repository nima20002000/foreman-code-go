import { expect, it } from 'vitest'
import { acceptsClaudePreCredentialEntry } from './appMcpPreflight.js'

const endpoint = 'http://127.0.0.1:3150/mcp'
const entry = (status: 'connected' | 'disabled' | 'authentication_required' | 'broken' | 'status_unavailable', rest = {}) =>
  ({ name: 'foreman-code', transport: 'streamable-http' as const, endpoint, enabled: true, status, ...rest })

it('accepts the unauthenticated app endpoint Claude reports as failed before its scoped credential exists', () => {
  expect(acceptsClaudePreCredentialEntry(entry('broken'), endpoint)).toBe(true)
  for (const status of ['connected', 'authentication_required', 'status_unavailable'] as const) {
    expect(acceptsClaudePreCredentialEntry(entry(status), endpoint)).toBe(true)
  }
})

it('rejects a disabled, missing, foreign or non-HTTP app endpoint', () => {
  expect(acceptsClaudePreCredentialEntry(undefined, endpoint)).toBe(false)
  expect(acceptsClaudePreCredentialEntry(entry('disabled', { enabled: false }), endpoint)).toBe(false)
  expect(acceptsClaudePreCredentialEntry(entry('broken', { endpoint: 'http://127.0.0.1:9999/mcp' }), endpoint)).toBe(false)
  expect(acceptsClaudePreCredentialEntry(entry('broken', { transport: 'stdio' }), endpoint)).toBe(false)
  expect(acceptsClaudePreCredentialEntry(entry('broken', { name: 'other' }), endpoint)).toBe(false)
})
