import { appLauncherConnection } from '../src/modules/harnesses/appMcpLauncher.js'
import { describe, expect, it, vi } from 'vitest'
import { ManagementActionSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import { HarnessMcpSettingsService } from '../src/modules/harnesses/mcpSettings.js'
import type { NativeMcpSnapshot } from '../src/modules/harnesses/nativeMcpCommon.js'
import { assertManagedChange, LINEAR_MCP_ENDPOINT, managedChange, managedEnableChange, managedStatus, nativeConnection, publicMcpList, replacement } from '../src/modules/harnesses/nativeMcpCommon.js'

const principal: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] }

describe('native MCP settings reads', () => {
  it('shows safe remote endpoint paths in details without exposing URL credentials', () => {
    const snapshot: NativeMcpSnapshot = { harness: 'codex', revision: 'revision', file: '/tmp/native', version: 'v', userConfig: {}, user: {},
      effective: { linear: { url: 'https://mcp.linear.app/mcp/readonly', enabled: true },
        safe: { url: 'https://example.com/mcp', enabled: true },
        unsafe: { url: 'https://user:password@example.com/mcp?token=secret', enabled: true } } }
    const list = publicMcpList(snapshot)
    expect(list.servers.find((server) => server.name === 'linear')?.endpoint).toBe('https://mcp.linear.app/mcp/readonly')
    expect(list.servers.find((server) => server.name === 'safe')?.endpoint).toBeUndefined()
    expect(list.servers.find((server) => server.name === 'unsafe')?.endpoint).toBeUndefined()
    expect(JSON.stringify(list)).not.toContain('password')
    expect(JSON.stringify(list)).not.toContain('secret')
  })
  it.each(['codex', 'opencode'] as const)('limits %s one-click GraphQL writes to the managed automatic launcher and credential reference', (harness) => {
    const endpoint = 'http://127.0.0.1:3000/mcp'
    const snapshot: NativeMcpSnapshot = { harness, revision: 'revision', effective: {}, user: {}, userConfig: {}, file: '/tmp/native', version: 'v' }
    const add = managedChange('graphql', true, endpoint)
    expect(replacement(snapshot, add, { preset: 'graphql', endpoint })).toEqual(nativeConnection(harness,
      appLauncherConnection()))
    expect(() => replacement(snapshot, add)).toThrow('Application MCP connections are managed')
    expect(() => assertManagedChange(snapshot, { kind: 'add', name: 'graphql', connection: { transport: 'remote', url: 'https://other.test/mcp' } },
      'graphql', endpoint)).toThrow('does not match')
    const installed = replacement(snapshot, add, { preset: 'graphql', endpoint })!
    const current = { ...snapshot, user: { 'graphql': installed }, effective: { 'graphql': installed },
      credentialReferences: { 'graphql': 'GRAPHQL_MCP_TOKEN' } }
    expect(managedStatus(current, 'graphql', endpoint)).toBe('installed')
    expect(() => replacement(current, managedEnableChange('graphql', false))).toThrow('Application MCP connections are managed')
    expect(managedStatus({ ...current, effective: { 'graphql': { url: 'https://override.test/mcp' } } },
      'graphql', endpoint)).toBe('inherited')
    expect(managedStatus({ ...current, user: { 'graphql': { ...installed,
      ...(harness === 'codex' ? { http_headers_helper: '/local/helper' } : { timeout: 5000 }), enabled: undefined } } },
    'graphql', endpoint)).toBe('installed')
    expect(replacement(current, managedChange('graphql', false, endpoint), { preset: 'graphql', endpoint })).toBeUndefined()
    expect(() => replacement({ ...current, user: { 'graphql': { ...installed, url: 'https://other.test/mcp' } } },
      managedChange('graphql', false, endpoint), { preset: 'graphql', endpoint })).toThrow('matching user-owned preset')
    const legacy = nativeConnection(harness, { transport: 'remote', url: 'http://127.0.0.1:3012/mcp', bearerTokenEnvironmentVariable: 'GRAPHQL_MCP_TOKEN' })
    expect(replacement({ ...current, user: { 'graphql': legacy }, effective: { 'graphql': legacy } },
      add, { preset: 'graphql', endpoint })).toEqual(installed)
    expect(managedStatus(current, 'graphql', 'http://127.0.0.1:4567/mcp')).toBe('installed')
    const disabled = { ...installed, enabled: false }
    const inactive = { ...current, user: { 'graphql': disabled }, effective: { 'graphql': disabled } }
    expect(managedStatus(inactive, 'graphql', endpoint)).toBe('disabled')
    expect(() => replacement(inactive, add, { preset: 'graphql', endpoint })).toThrow('already has a native configuration')
    expect(replacement(current, managedEnableChange('graphql', false), { preset: 'graphql', endpoint })).toEqual(disabled)
    expect(replacement(inactive, managedEnableChange('graphql', true), { preset: 'graphql', endpoint })).toEqual(installed)
    expect(replacement(inactive, managedChange('graphql', false, endpoint), { preset: 'graphql', endpoint })).toBeUndefined()
    expect(() => replacement(current, managedEnableChange('graphql', true), { preset: 'graphql', endpoint })).toThrow('matching user-owned preset')
    expect(() => replacement({ ...inactive, effective: { 'graphql': { ...disabled, url: 'https://override.test/mcp' } } },
      managedEnableChange('graphql', true), { preset: 'graphql', endpoint })).toThrow('matching user-owned preset')
    expect(managedChange('linear', true, endpoint)).toMatchObject({ kind: 'add', connection: { url: LINEAR_MCP_ENDPOINT } })
    expect(managedStatus({ ...snapshot, effective: { linear: harness === 'codex' ? { url: 'https://mcp.linear.app/mcp' }
      : { type: 'remote', url: 'https://mcp.linear.app/mcp' } },
      user: { linear: harness === 'codex' ? { url: 'https://mcp.linear.app/mcp' }
        : { type: 'remote', url: 'https://mcp.linear.app/mcp' } } }, 'linear', endpoint)).toBe('mismatch')
  })
  it.each(['codex', 'opencode'] as const)('shares simultaneous %s reads instead of starting competing native processes', async (harness) => {
    const snapshot: NativeMcpSnapshot = { harness, revision: 'revision', effective: {}, user: {},
      userConfig: {}, file: '/tmp/native-user-config', version: 'version' }
    let finish!: (value: NativeMcpSnapshot) => void
    const read = vi.fn(() => new Promise<NativeMcpSnapshot>((resolve) => { finish = resolve }))
    const adapter = { read, apply: vi.fn() }
    const service = new HarnessMcpSettingsService({} as never, {} as never,
      { codex: adapter, opencode: adapter }, () => undefined)

    const first = service.list(principal, harness)
    const second = service.list(principal, harness)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    finish(snapshot)
    const [one, two] = await Promise.all([first, second])
    expect(one).toEqual(two)
    expect(one.servers).toEqual([])
    expect(read).toHaveBeenCalledTimes(1)
    await service.shutdown()
  })

  it('allows a fresh read after a failed check', async () => {
    const snapshot: NativeMcpSnapshot = { harness: 'codex', revision: 'revision', effective: {}, user: {},
      userConfig: {}, file: '/tmp/native-user-config', version: 'version' }
    const read = vi.fn().mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue(snapshot)
    const adapter = { read, apply: vi.fn() }
    const service = new HarnessMcpSettingsService({} as never, {} as never,
      { codex: adapter, opencode: adapter }, () => undefined)
    await expect(service.list(principal, 'codex')).rejects.toThrow('The native check could not complete')
    await expect(service.list(principal, 'codex')).resolves.toMatchObject({ harness: 'codex', servers: [] })
    expect(read).toHaveBeenCalledTimes(2)
    await service.shutdown()
  })
})
