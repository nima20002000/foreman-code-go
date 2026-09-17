import { describe, expect, it } from 'vitest'

import { openCodeMcpInspectorAdapter } from '../src/modules/harnesses/opencodeMcpInspectorAdapter.js'

describe('OpenCode HAP-03 MCP inspection adapter', () => {
  it('normalizes resolved config/runtime evidence and preserves filters as diagnostics', async () => {
    const inspector = openCodeMcpInspectorAdapter({
      inspectNativeMcp: async (cwd) => ({
        cwd, providerVersion: '1.18.31', serverName: 'graphql-app', nativeStatus: 'connected',
        transport: 'streamable-http', endpoint: 'http://127.0.0.1:3000/mcp/tools',
        endpointMatches: true,
        credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN',
        baseConfigurationFilters: [{ permission: 'tool', pattern: 'graphql-app_*', effect: 'allow' }],
        policyScope: 'base_configuration_only',
      }),
    })
    await expect(inspector.inspect({
      harness: 'opencode', runnerId: 'runner-local', workingDirectory: '/workspace', serverName: 'graphql-app',
    })).resolves.toMatchObject({
      providerVersion: '1.18.31',
      entry: { status: 'connected', transport: 'streamable-http', nativeFilterDiagnostics: ['Native base-configuration permission filters are configured.'] },
    })
  })

  it.each([
    ['needs_auth', 'authentication_required'],
    ['needs_client_registration', 'authentication_required'],
    ['failed', 'broken'],
    ['disabled', 'disabled'],
  ] as const)('maps %s to %s', async (nativeStatus, expected) => {
    const inspector = openCodeMcpInspectorAdapter({
      inspectNativeMcp: async (cwd) => ({
        cwd, providerVersion: '1.18.31', serverName: 'graphql-app', nativeStatus,
        transport: 'streamable-http', endpoint: 'http://127.0.0.1:3000/mcp/tools',
        endpointMatches: true,
        credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN', baseConfigurationFilters: [],
        policyScope: 'base_configuration_only',
      }),
    })
    const result = await inspector.inspect({
      harness: 'opencode', runnerId: 'runner-local', workingDirectory: '/workspace', serverName: 'graphql-app',
    })
    expect(result.entry?.status).toBe(expected)
  })

  it('reports successful absence without inventing an entry', async () => {
    const inspector = openCodeMcpInspectorAdapter({
      inspectNativeMcp: async (cwd) => ({
        cwd, providerVersion: '1.18.31', serverName: 'graphql-app', nativeStatus: 'not_detected',
        endpoint: null, endpointMatches: null, credentialEnvironmentVariable: null,
        baseConfigurationFilters: [], policyScope: 'base_configuration_only',
      }),
    })
    await expect(inspector.inspect({
      harness: 'opencode', runnerId: 'runner-local', workingDirectory: '/workspace', serverName: 'graphql-app',
    })).resolves.not.toHaveProperty('entry')
  })
})
