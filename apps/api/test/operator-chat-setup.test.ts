import { afterEach, describe, expect, it, vi } from 'vitest'
import { PostgresOperatorChatAuthority } from '../src/modules/conversations/operatorChatAuthority.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'

const endpoint = 'http://127.0.0.1:3000/mcp/operator'
const authority = new PostgresOperatorChatAuthority({} as never, {} as never, {} as never, '/operator', endpoint)
const signal = new AbortController().signal
afterEach(() => vi.restoreAllMocks())

describe('Operator chat installation evidence', () => {
  const evidence = { cwd: '/operator', providerVersion: 'test', serverName: 'graphql-operator',
    transport: 'streamable-http', endpoint, credentialEnvironmentVariable: 'GRAPHQL_OPERATOR_MCP_TOKEN',
    nativeStatus: 'status_unavailable', endpointMatches: true, baseConfigurationFilters: [], policyScope: 'base_configuration_only' } as const
  it.each([
    { nativeStatus: 'not_detected' }, { nativeStatus: 'disabled' }, { endpoint: 'http://other/mcp/operator' },
    { credentialEnvironmentVariable: null }, { credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN' },
    { transport: 'stdio' }, { serverName: 'graphql-app' },
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
