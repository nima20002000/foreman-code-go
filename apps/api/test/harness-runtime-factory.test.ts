import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import { describe, expect, it, vi } from 'vitest'
import { NativeHarnessFactories, type NativeFactoryInfrastructure } from '../src/modules/harnesses/runtimeFactory.js'
import type { ManagedOpenCodeServerOptions, OpenCodeServerController } from '../src/modules/harnesses/opencodeTransport.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../src/modules/harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry, type HarnessInstallationRecord } from '../src/modules/harnesses/installationRegistry.js'

describe('native runtime construction', () => {
  it('allocates diagnostics against the canonical default and fences changed payload bytes before native startup', async () => {
    const instances = new HarnessInstanceRegistry(localHarnessDrivers)
    instances.reload([{ instanceId: 'local-default:opencode', instanceRevision: '8', driverId: 'opencode',
      enabled: true, configuration: DEFAULT_HARNESS_DEFAULTS.opencode }])
    const installations = new HarnessInstallationRegistry(instances)
    const installation: HarnessInstallationRecord = { hostRef: { kind: 'main', mainId: 'recorded-main' },
      harnessInstallationId: 'recorded-installation', installationFingerprint: 'original-payload', driverId: 'opencode',
      driverRevision: '1', protocolRevision: 'recorded-protocol', environmentGeneration: 'env', connectionGeneration: 'connection',
      launcher: { requested: 'opencode', resolvedLauncher: '/recorded/selected-opencode', fingerprint: 'original-payload',
        status: 'installed', interpreter: null, diagnostics: [], checkedAt: '2026-10-01T00:00:00.000Z',
        environment: { generation: 'env', provenance: 'worker', cwd: '/recorded', path: '/recorded' },
        payloadFingerprints: [{ path: '/recorded/selected-opencode', fingerprint: 'original-payload' }] },
      installed: true, observedVersion: null, authenticated: null, compatible: null, qualified: null }
    installations.refresh([installation])
    const discovery = vi.fn(async () => ({ ...installation.launcher, fingerprint: 'changed-payload' }))
    let options!: ManagedOpenCodeServerOptions
    const factories = new NativeHarnessFactories({ codexBinary: '/unused', openCodeBinary: '/forbidden-path-fallback',
      instances, installations, installationDiscovery: discovery,
      selectDefault: () => installations.pin({ instanceId: 'local-default:opencode', hostRef: installation.hostRef,
        harnessInstallationId: installation.harnessInstallationId, connectionGeneration: 'connection', environmentGeneration: 'env' }),
    }, { mode: 'native', openCodeServer: (input) => {
      options = input
      return { expectedVersion: '1.18.31', ownerAgentId: input.ownerAgentId,
        ensure: vi.fn(), request: vi.fn(), dispose: vi.fn(async () => undefined) }
    } })
    const allocation = factories.allocate({ harness: 'opencode', role: 'diagnostics',
      workingDirectory: '/recorded', ownerAgentId: 'diagnostic-owner', appMcpAccess: 'none' })
    expect(options.binary).toBe('/recorded/selected-opencode')
    expect(discovery).not.toHaveBeenCalled()
    await expect(options.assertInstallation!()).rejects.toThrow('payload changed')
    await factories.disposeAuxiliary(allocation.manager)
  })
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
