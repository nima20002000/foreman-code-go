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

  it('retains failed diagnostic recovery closure and retries the same owner after admission stops', async () => {
    const recovery = { root: '/unused-registry', owner: 'diagnostics:recorded' }
    const closeRecovery = vi.fn<(scope: typeof recovery) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Closure is unconfirmed.')).mockResolvedValue(undefined)
    const server = { expectedVersion: '1.18.31', ownerAgentId: 'diagnostics',
      ensure: vi.fn(), request: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) }
    const factories = new NativeHarnessFactories({ codexBinary: 'unused', openCodeBinary: 'unused',
      auxiliaryRecovery: () => recovery, closeRecovery }, { mode: 'native', openCodeServer: () => server })
    const allocation = factories.allocate({ harness: 'opencode', role: 'diagnostics',
      ownerAgentId: 'diagnostics', workingDirectory: '/project', appMcpAccess: 'none' })
    factories.admitAuxiliary(allocation.manager)
    await expect(factories.disposeAuxiliary(allocation.manager)).rejects.toThrow('unconfirmed')
    factories.stopAuxiliaries()
    expect(() => factories.allocate({ harness: 'codex', role: 'qualification', ownerAgentId: 'qualification',
      workingDirectory: '/project', appMcpAccess: 'none' })).toThrow('shutting down')
    await factories.disposeAuxiliaries()
    expect(closeRecovery).toHaveBeenCalledTimes(2)
    expect(closeRecovery.mock.calls.every(([scope]) => scope === recovery)).toBe(true)
    expect(server.dispose).toHaveBeenCalledTimes(1)
    await factories.disposeAuxiliaries()
    expect(closeRecovery).toHaveBeenCalledTimes(2)
  })

  it('retains a partially failed reservation and fences native work until cleanup succeeds', async () => {
    const recovery = { root: '/unused-registry', owner: 'diagnostics:partial' }
    const admitRecovery = vi.fn(() => { throw new Error('Reservation failed partway through.') })
    const closeRecovery = vi.fn<(scope: typeof recovery) => Promise<void>>().mockResolvedValue(undefined)
    const factories = new NativeHarnessFactories({ codexBinary: 'unused', openCodeBinary: 'unused',
      auxiliaryRecovery: () => recovery, admitRecovery, closeRecovery })
    const allocation = factories.allocate({ harness: 'codex', role: 'diagnostics', ownerAgentId: 'diagnostics',
      workingDirectory: '/project', appMcpAccess: 'none' })
    expect(() => factories.admitAuxiliary(allocation.manager)).toThrow('Reservation failed')
    expect(() => factories.admitAuxiliary(allocation.manager)).toThrow('Reservation failed')
    expect(admitRecovery).toHaveBeenCalledTimes(1)
    await factories.disposeAuxiliary(allocation.manager)
    expect(closeRecovery).toHaveBeenCalledExactlyOnceWith(recovery)
    await factories.disposeAuxiliary(allocation.manager)
    expect(closeRecovery).toHaveBeenCalledTimes(1)
  })
})
