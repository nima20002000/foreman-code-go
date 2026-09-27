import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type OperatorConfigurationVersion } from '@graphql/contracts'
import { PostgresOperatorChatAuthority } from '../src/modules/conversations/operatorChatAuthority.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'

const endpoint = 'http://127.0.0.1:3000/mcp'
const authority = new PostgresOperatorChatAuthority({} as never, {} as never, {} as never, '/operator', endpoint)
const signal = new AbortController().signal
afterEach(() => vi.restoreAllMocks())

describe('Operator chat installation evidence', () => {
  it.each(['codex', 'opencode'] as const)('accepts a proven %s automatic launcher at any app port, while respecting disable', async (harness) => {
    for (const port of [3012, 4567]) {
      const owner = new PostgresOperatorChatAuthority({} as never, {} as never, {} as never, '/operator', `http://127.0.0.1:${port}/mcp`)
      const manager = harness === 'codex' ? new CodexAppServerSessionManager('unused')
        : Object.assign(Object.create(OpenCodeNativeSessionManager.prototype), { harness }) as OpenCodeNativeSessionManager
      if (manager instanceof CodexAppServerSessionManager) {
        const inspect = vi.spyOn(manager, 'inspectMcpConfiguration').mockResolvedValue({ serverName: 'graphql', configured: {
          enabled: true, automaticEndpoint: true, transport: 'stdio', url: null, bearerTokenEnvironmentVariable: 'GRAPHQL_MCP_TOKEN',
        } } as never)
        expect(await owner.setup(manager, signal)).toMatchObject({ status: 'configured' })
        inspect.mockResolvedValue({ serverName: 'graphql', configured: { enabled: false, automaticEndpoint: true } } as never)
      } else {
        const inspect = vi.spyOn(manager, 'inspectNativeMcp').mockResolvedValue({ serverName: 'graphql', automaticEndpoint: true,
          transport: 'stdio', endpoint: null, nativeStatus: 'status_unavailable', credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN' } as never)
        expect(await owner.setup(manager, signal)).toMatchObject({ status: 'configured' })
        inspect.mockResolvedValue({ serverName: 'graphql', automaticEndpoint: true, nativeStatus: 'disabled' } as never)
      }
      expect(await owner.setup(manager, signal)).toMatchObject({ status: 'setup_required' })
    }
  })
  it('blocks an accepted OpenCode Operator disable switch but permits disabling another server', async () => {
    const manager = Object.assign(Object.create(OpenCodeNativeSessionManager.prototype), { harness: 'opencode' }) as OpenCodeNativeSessionManager
    const inspect = vi.spyOn(manager, 'inspectNativeMcp').mockResolvedValue({ serverName: 'graphql', endpoint,
      transport: 'streamable-http', nativeStatus: 'status_unavailable', credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN' } as never)
    const base = DEFAULT_HARNESS_DEFAULTS.opencode
    const version = { id: 'configuration', operatorId: 'operator', version: 1, contentHash: `sha256:${'a'.repeat(64)}`,
      createdAt: new Date().toISOString() }
    const configuration: OperatorConfigurationVersion = { ...version, harness: { ...base, advanced: { ...base.advanced!,
      mcp: { ...base.advanced?.mcp, serverEnabled: { 'graphql': false } } } } }
    expect(await authority.setup(manager, signal, configuration)).toMatchObject({ status: 'setup_required', reason: expect.stringContaining('disable') })
    expect(inspect).not.toHaveBeenCalled()
    const unrelated: OperatorConfigurationVersion = { ...version, harness: { ...base, advanced: { ...base.advanced!,
      mcp: { serverEnabled: { linear: false } } } } }
    expect(await authority.setup(manager, signal, unrelated)).toMatchObject({ status: 'configured' })
  })
  const evidence = { cwd: '/operator', providerVersion: 'test', serverName: 'graphql',
    transport: 'streamable-http', endpoint, credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN',
    nativeStatus: 'status_unavailable', endpointMatches: true, baseConfigurationFilters: [], policyScope: 'base_configuration_only' } as const
  it.each([
    { nativeStatus: 'not_detected' }, { nativeStatus: 'disabled' }, { endpoint: 'http://other/mcp' },
    { credentialEnvironmentVariable: null }, { credentialEnvironmentVariable: 'GRAPHQL_OPERATOR_MCP_TOKEN' },
    { transport: 'stdio' }, { serverName: 'graphql-operator' },
  ])('blocks missing or invalid OpenCode setup: %j', async (change) => {
    const manager = Object.assign(Object.create(OpenCodeNativeSessionManager.prototype), { harness: 'opencode' }) as OpenCodeNativeSessionManager
    vi.spyOn(manager, 'inspectNativeMcp').mockResolvedValue({ ...evidence, ...change } as never)
    expect(await authority.setup(manager, signal)).toMatchObject({ harness: 'opencode', status: 'setup_required', endpoint })
  })
  it('accepts correct configuration without claiming pre-token connectivity', async () => {
    const manager = Object.assign(Object.create(OpenCodeNativeSessionManager.prototype), { harness: 'opencode' }) as OpenCodeNativeSessionManager
    const inspect = vi.spyOn(manager, 'inspectNativeMcp').mockResolvedValue(evidence as never)
    expect(await authority.setup(manager, signal)).toMatchObject({ status: 'configured' })
    expect(inspect).toHaveBeenCalledWith('/operator', signal, 'configuration')
  })
  it('reports absent Codex MCP as setup required and preserves inspection failures', async () => {
    const manager = new CodexAppServerSessionManager('unused')
    const inspect = vi.spyOn(manager, 'inspectMcpConfiguration').mockRejectedValue(new HarnessExecutionError('CODEX_MCP_NOT_CONFIGURED', 'Absent'))
    expect(await authority.setup(manager, signal)).toMatchObject({ harness: 'codex', status: 'setup_required' })
    inspect.mockRejectedValue(new Error('Inspection failed'))
    await expect(authority.setup(manager, signal)).rejects.toThrow('Inspection failed')
  })
})
