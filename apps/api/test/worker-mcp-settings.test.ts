import { describe, expect, it } from 'vitest'
import { managedChange, managedStatus, nativeConnection, replacement, type NativeMcpSnapshot } from '../src/modules/harnesses/nativeMcpCommon.js'
import { workerLauncherConnection } from '../src/modules/harnesses/workerMcpLauncher.js'

describe.each(['codex', 'opencode'] as const)('%s worker preset', (harness) => {
  const endpoint = 'http://127.0.0.1:3002/mcp/operator'
  const snapshot = (entry: Record<string, unknown>): NativeMcpSnapshot => ({ harness, revision: 'revision', file: '/tmp/config', version: '1',
    userConfig: {}, user: { 'graphql-app': entry }, effective: { 'graphql-app': entry },
    credentialReferences: { 'graphql-app': 'GRAPHQL_APP_MCP_TOKEN' } })
  const change = managedChange('worker', true, endpoint)
  it('migrates the standard fixed route while retaining disabled and native tool policies', () => {
    const legacy = { ...nativeConnection(harness, { transport: 'remote', url: 'http://127.0.0.1:3012/mcp/tools',
      bearerTokenEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN' }), enabled: false, disabled_tools: ['interaction_respond'] }
    const migrated = replacement(snapshot(legacy), change, { preset: 'worker', endpoint })!
    expect(migrated).toEqual({ ...nativeConnection(harness, workerLauncherConnection()), enabled: false, disabled_tools: ['interaction_respond'] })
    expect(managedStatus(snapshot(migrated), 'worker', endpoint)).toBe('disabled')
    expect(managedStatus(snapshot({ ...migrated, enabled: true }), 'worker', 'http://127.0.0.1:9999/mcp/operator')).toBe('installed')
  })
  it('refuses custom or inherited connections instead of overwriting them', () => {
    for (const url of ['https://example.com/mcp/tools', 'http://127.0.0.1:3012/custom']) {
      const existing = nativeConnection(harness, { transport: 'remote', url, bearerTokenEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN' })
      expect(() => replacement(snapshot(existing), change, { preset: 'worker', endpoint })).toThrow('custom')
    }
    const entry = nativeConnection(harness, workerLauncherConnection())
    const inherited = { ...snapshot(entry), ownership: { 'graphql-app': false } }
    expect(managedStatus(inherited, 'worker', endpoint)).toBe('inherited')
    expect(() => replacement(inherited, change, { preset: 'worker', endpoint })).toThrow('already has')
  })
})
