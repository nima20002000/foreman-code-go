import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import { describe, expect, it, vi } from 'vitest'
import { NativeHarnessFactories, type NativeFactoryInfrastructure } from '../src/modules/harnesses/runtimeFactory.js'
import type { ManagedOpenCodeServerOptions, OpenCodeServerController } from '../src/modules/harnesses/opencodeTransport.js'

describe('native runtime construction', () => {
  it('allocates real role-isolated managers without starting infrastructure and disposes only its own child', async () => {
    const servers: OpenCodeServerController[] = []
    const serverFactory = vi.fn((options: ManagedOpenCodeServerOptions) => {
      const server = { expectedVersion: '1.18.31', ownerAgentId: options.ownerAgentId,
        ensure: vi.fn(), request: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) }
      servers.push(server)
      return server
    })
    const factories = new NativeHarnessFactories({ codexBinary: 'unused-codex', openCodeBinary: 'unused-opencode' },
      { mode: 'native', openCodeServer: serverFactory })
    const configured = { instanceId: 'agent-1', instanceRevision: 'configuration-1', driverId: 'opencode', enabled: true,
      configuration: DEFAULT_HARNESS_DEFAULTS.opencode }
    const roles = ['workflow', 'operator', 'agent-chat'] as const
    const bindings = roles.map((role) => factories.allocate({ harness: 'opencode', role, configured,
      workingDirectory: '/project', ownerAgentId: role, appMcpAccess: role === 'agent-chat' ? 'none' : 'scoped',
      processRecovery: { root: '/unused-registry', owner: `${role}:owner` },
    }))
    expect(new Set(bindings.map(({ manager }) => manager)).size).toBe(3)
    expect(serverFactory.mock.calls.map(([options]) => options.processRecovery?.owner)).toEqual(roles.map((role) => `${role}:owner`))
    expect(servers.every((server) => vi.mocked(server.ensure).mock.calls.length === 0
      && vi.mocked(server.request).mock.calls.length === 0)).toBe(true)
    expect(factories.instances.select('agent-1').instanceRevision).toBe('configuration-1')
    expect(factories.inspector(bindings[0]!.manager)).toBe(bindings[0]!.inspector)
    await bindings[2]!.manager.dispose()
    expect(servers[2]!.dispose).toHaveBeenCalledTimes(1)
    expect(servers[0]!.dispose).not.toHaveBeenCalled()
    expect(servers[1]!.dispose).not.toHaveBeenCalled()
  })

  it.each(['agent-chat', 'diagnostics', 'qualification'] as const)('rejects scoped application authority for %s before allocation', (role) => {
    const server = vi.fn()
    const factories = new NativeHarnessFactories({ codexBinary: 'unused', openCodeBinary: 'unused' },
      { mode: 'native', openCodeServer: server })
    expect(() => factories.allocate({ harness: 'opencode', role, workingDirectory: '/project',
      ownerAgentId: role, appMcpAccess: 'scoped' })).toThrow('no application MCP credentials')
    expect(server).not.toHaveBeenCalled()
  })

  it('fails closed for incomplete replay infrastructure rather than constructing native clients', () => {
    expect(() => new NativeHarnessFactories({ codexBinary: 'unused', openCodeBinary: 'unused' },
      { mode: 'replay' } as NativeFactoryInfrastructure)).toThrow('every provider infrastructure port')
  })

  it('rejects mutation of a pinned configured revision', () => {
    const factories = new NativeHarnessFactories({ codexBinary: 'unused', openCodeBinary: 'unused' })
    const input = { harness: 'codex' as const, role: 'workflow' as const, workingDirectory: '/project',
      ownerAgentId: 'agent-1', appMcpAccess: 'scoped' as const,
      configured: { instanceId: 'agent-1', instanceRevision: 'configuration-1', driverId: 'codex', enabled: true,
        configuration: DEFAULT_HARNESS_DEFAULTS.codex } }
    factories.allocate(input)
    expect(() => factories.allocate({ ...input, configured: { ...input.configured,
      configuration: { ...input.configured.configuration, reasoningEffort: 'high' } } })).toThrow('immutable')
  })
})
