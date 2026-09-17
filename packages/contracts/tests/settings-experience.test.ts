import { describe, expect, it } from 'vitest'
import { AgentSettingsSearchSchema, HarnessSettingsSearchSchema, WorkspaceDefaultsSchema, WorkspaceDefaultsUpdateInputSchema,
  BrowserCredentialSetupSchema, BrowserAccessSessionSchema } from '../src/management/index.js'

describe('Settings experience contracts', () => {
  it('parses direct links and rejects unsupported agent section selections', () => {
    expect(AgentSettingsSearchSchema.parse({ role: 'coder', section: 'tools' })).toEqual({ role: 'coder', section: 'tools' })
    expect(AgentSettingsSearchSchema.parse({ role: 'unknown', section: 'connections' })).toEqual({ role: undefined, section: undefined })
    expect(HarnessSettingsSearchSchema.parse({ harness: 'opencode', section: 'workspace' })).toEqual({ harness: 'opencode', section: 'workspace' })
  })
  it('workspace suggestions cannot carry runner or filesystem authority', () => {
    expect(WorkspaceDefaultsSchema.safeParse({ suggestedName: 'Workspace', description: '', rootPath: '/tmp' }).success).toBe(false)
    expect(WorkspaceDefaultsSchema.safeParse({ suggestedName: ' ', description: '' }).success).toBe(false)
    expect(WorkspaceDefaultsSchema.safeParse({ suggestedName: 'Workspace', description: 'x'.repeat(10_001) }).success).toBe(false)
  })
  it('keeps explicit empty descriptions and validates revision/command identity', () => {
    expect(WorkspaceDefaultsUpdateInputSchema.parse({ value: { suggestedName: 'Project', description: '' }, commandId: 'command-1', expectedRevision: 0 }).value.description).toBe('')
    expect(WorkspaceDefaultsUpdateInputSchema.safeParse({ value: { suggestedName: 'Project', description: '' }, commandId: 'x', expectedRevision: -1 }).success).toBe(false)
  })
  it('allows quoted browser names but not shell flags or control characters', () => {
    const valid = { name: "Sam's browser", days: 30, access: 'read-only' }
    expect(BrowserCredentialSetupSchema.parse(valid)).toEqual(valid)
    for (const name of ['--access', 'a\nb', 'a\0b']) expect(BrowserCredentialSetupSchema.safeParse({ ...valid, name }).success).toBe(false)
    expect(BrowserCredentialSetupSchema.safeParse({ ...valid, days: 0 }).success).toBe(false)
    expect(BrowserCredentialSetupSchema.safeParse({ ...valid, access: 'root' }).success).toBe(false)
  })
  it('session readback excludes credentials', () => {
    const value = { principal: { id: 'principal-x', name: 'Browser', expiresAt: '2099-01-01T00:00:00Z', grants: [] } }
    expect(BrowserAccessSessionSchema.safeParse(value).success).toBe(true)
    expect(BrowserAccessSessionSchema.safeParse({ ...value, token: 'secret' }).success).toBe(false)
    expect(BrowserAccessSessionSchema.safeParse({ principal: { ...value.principal, tokenHash: 'secret' } }).success).toBe(false)
  })
})
