import { describe, expect, it } from 'vitest'
import { assertChange, assertManagedChange, fingerprint, LINEAR_MCP_ENDPOINT, managedChange, managedStatus,
  publicMcpList, replacement, type NativeMcpSnapshot } from '../src/modules/harnesses/nativeMcpCommon.js'
import { codexMcpOwnership } from '../src/modules/harnesses/codexMcpConnections.js'
import { NativeMcpNotSubmittedError, withNativeMcpDelivery } from '../src/modules/harnesses/nativeMcpDelivery.js'

const endpoint = 'http://127.0.0.1:3000/mcp/operator'
function snapshot(harness: NativeMcpSnapshot['harness'], name = 'graphql-operator', url = endpoint): NativeMcpSnapshot {
  const entry = harness === 'codex' ? { url, enabled: true, bearer_token_env_var: 'GRAPHQL_OPERATOR_MCP_TOKEN' }
    : { type: 'remote', url, enabled: true, oauth: false, headers: { Authorization: 'Bearer {env:GRAPHQL_OPERATOR_MCP_TOKEN}' } }
  return { harness, revision: fingerprint(entry), user: { [name]: entry }, effective: { [name]: structuredClone(entry) },
    userConfig: {}, version: '1', file: '/private/native-config', credentialReferences: { [name]: 'GRAPHQL_OPERATOR_MCP_TOKEN' } }
}

describe('PR18 native MCP policy and provenance', () => {
  it.each(['codex', 'opencode'] as const)('repairs wrong endpoints and disabled %s entries without dropping any restriction', (harness) => {
    for (const enabled of [true, false]) {
      const current = snapshot(harness, 'graphql-operator', enabled ? 'http://127.0.0.1:9999/mcp/operator' : endpoint)
      const policy = { enabled_tools: ['read'], disabled_tools: ['write'], default_tools_approval_mode: 'prompt',
        tools: { delete: { approval_mode: 'prompt', enabled: false } } }
      const entry = { ...current.user['graphql-operator'] as object, enabled, ...policy }
      current.user['graphql-operator'] = entry; current.effective['graphql-operator'] = structuredClone(entry)
      expect(managedStatus(current, 'operator', endpoint)).toBe('mismatch')
      const next = replacement(current, managedChange('operator', true, endpoint), { preset: 'operator', endpoint })
      expect(next).toEqual({ ...entry, url: endpoint, enabled: true })
      expect(next).toMatchObject(policy)
    }
  })
  it.each(['codex', 'opencode'] as const)('rejects customized %s credentials rather than replacing their policies', (harness) => {
    const current = snapshot(harness)
    const entry = harness === 'codex' ? { url: endpoint, bearer_token_env_var: 'OTHER_TOKEN' }
      : { type: 'remote', url: endpoint, oauth: false, headers: { Authorization: 'Bearer {env:OTHER_TOKEN}' } }
    current.user['graphql-operator'] = entry; current.effective['graphql-operator'] = entry
    expect(() => replacement(current, managedChange('operator', true, endpoint), { preset: 'operator', endpoint })).toThrow()
  })
  it.each(['codex', 'opencode'] as const)('requires explicit conversion of a full-access %s Linear endpoint', (harness) => {
    const current = snapshot(harness, 'linear', 'https://mcp.linear.app/mcp')
    const entry = harness === 'codex' ? { url: 'https://mcp.linear.app/mcp', enabled: true, bearer_token_env_var: 'LINEAR_TOKEN', disabled_tools: ['delete'] }
      : { type: 'remote', url: 'https://mcp.linear.app/mcp', enabled: true, oauth: { scope: 'read write' } }
    current.user.linear = entry; current.effective.linear = structuredClone(entry)
    expect(managedStatus(current, 'linear', endpoint)).toBe('mismatch')
    const converted = replacement(current, managedChange('linear', true, endpoint), { preset: 'linear', endpoint })!
    expect(converted).toEqual({ ...entry, url: LINEAR_MCP_ENDPOINT, enabled: true })
    current.user.linear = converted; current.effective.linear = converted
    expect(managedStatus(current, 'linear', endpoint)).toBe('installed')
    expect(() => assertManagedChange(current, managedChange('linear', false, endpoint), 'linear', endpoint)).not.toThrow()
  })
  it.each(['codex', 'opencode'] as const)('refuses protected Linear removal through both %s paths', (harness) => {
    const current = snapshot(harness, 'linear', LINEAR_MCP_ENDPOINT)
    const entry = harness === 'codex' ? { url: LINEAR_MCP_ENDPOINT, bearer_token_env_var: 'GRAPHQL_APP_MCP_TOKEN' }
      : { type: 'remote', url: LINEAR_MCP_ENDPOINT, oauth: false, headers: { Authorization: 'Bearer {env:GRAPHQL_APP_MCP_TOKEN}' } }
    current.user.linear = entry; current.effective.linear = entry
    expect(publicMcpList(current).servers[0]?.protected).toBe(true)
    expect(managedStatus(current, 'linear', endpoint)).not.toBe('installed')
    expect(() => assertChange(current, { kind: 'remove', name: 'linear' })).toThrow()
    expect(() => assertManagedChange(current, managedChange('linear', false, endpoint), 'linear', endpoint)).toThrow()
  })
  it.each(['codex', 'opencode'] as const)('detects same-URL %s transport, enable and ownership overrides', (harness) => {
    for (const change of [{ enabled: false }, { type: 'local', command: ['/untrusted'] }]) {
      const current = snapshot(harness)
      current.effective['graphql-operator'] = { ...current.effective['graphql-operator'] as object, ...change }
      expect(managedStatus(current, 'operator', endpoint)).toBe('inherited')
      expect(publicMcpList(current).servers[0]?.origin).toBe('inherited')
      expect(() => assertManagedChange(current, managedChange('operator', false, endpoint), 'operator', endpoint)).toThrow()
    }
    const current = snapshot(harness)
    current.ownership = { 'graphql-operator': false }
    expect(managedStatus(current, 'operator', endpoint)).toBe('inherited')
  })
  it('does not classify a same-URL Codex credential override as installed', () => {
    const current = snapshot('codex')
    current.effective['graphql-operator'] = { url: endpoint, type: 'streamable_http', enabled: true, bearer_token_env_var: 'OTHER_TOKEN' }
    expect(managedStatus(current, 'operator', endpoint)).toBe('inherited')
  })
  it('uses proven OpenCode references, never expanded secret equality', () => {
    const current = snapshot('opencode')
    current.effective['graphql-operator'] = { type: 'remote', url: endpoint, enabled: true, oauth: false,
      headers: { Authorization: 'Bearer never-return-this-secret' } }
    expect(managedStatus(current, 'operator', endpoint)).toBe('installed')
    current.credentialReferences = {}
    expect(managedStatus(current, 'operator', endpoint)).toBe('inherited')
    expect(JSON.stringify(publicMcpList(current))).not.toContain('never-return-this-secret')
  })
  it('detects identical Codex entries with a second configuration source', () => {
    const current = snapshot('codex')
    const user = { name: { type: 'user' }, config: { mcp_servers: current.user } }
    const project = { name: { type: 'project' }, config: { mcp_servers: current.user } }
    expect(codexMcpOwnership([project, user], user, current.user)['graphql-operator']).toBe(false)
    expect(codexMcpOwnership([{ ...project, disabledReason: 'untrusted' }, user], user, current.user)['graphql-operator']).toBe(true)
  })
  it('provides explicit no-delivery evidence for an abort before the native write', async () => {
    const controller = new AbortController(); controller.abort()
    let writes = 0
    await expect(withNativeMcpDelivery(async (writing) => { controller.signal.throwIfAborted(); writing(); writes++ }))
      .rejects.toBeInstanceOf(NativeMcpNotSubmittedError)
    expect(writes).toBe(0)
    const lost = new Error('Lost acknowledgement')
    await expect(withNativeMcpDelivery(async (writing) => { writing(); throw lost })).rejects.toBe(lost)
  })
})
