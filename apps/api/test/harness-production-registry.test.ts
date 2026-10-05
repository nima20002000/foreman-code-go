import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import type { HostHarnessOverride } from '@graphql/contracts/harness-registry'
import { expect, it, vi } from 'vitest'
import { ProductionHarnessRegistry } from '../src/modules/harnesses/productionRegistry.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { passiveDriverPayloads } from '../src/modules/harnesses/payloadDiscovery.js'
import { discoverLauncher } from '../src/modules/harnesses/hostDiscovery.js'
import { inspectInstalledCodex } from '../src/modules/harnesses/installedCodexInspection.js'

it('distinguishes unavailable and stale remote snapshots from a current empty installation inventory', async () => {
  const pool = new pg.Pool({ connectionString: 'postgresql://unused@127.0.0.1:1/unused' })
  let binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(),
    workerInstallationId: randomUUID(), bootId: randomUUID(), connectionEpoch: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
  const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'codex', openCodeBinary: 'opencode' },
    async () => ({ revision: 1, defaults: DEFAULT_HARNESS_DEFAULTS }),
    new HostHarnessProfileEvidenceRepository(pool), () => binding)
  const profile: HostHarnessOverride = { instanceId: randomUUID(), instanceRevision: '1', revision: 1,
    driverId: 'codex', presetId: 'local-default:codex', enabled: true, qualification: 'unqualified',
    configuration: DEFAULT_HARNESS_DEFAULTS.codex, configurationFingerprint: 'saved-configuration', target: {
      hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
      applicationInstallationId: binding.workerInstallationId,
      harnessInstallationId: 'saved-installation', installationFingerprint: 'saved-payload',
    } }
  const collect = async () => {
    const inspected = await inspectInstalledCodex({ binding, configuration: null, environment: process.env,
      cwd: process.cwd(), signal: new AbortController().signal })
    registry.acceptRemoteSnapshot(binding, inspected.inventory)
  }
  try {
    expect(() => registry.pinOverride(profile))
      .toThrow(expect.objectContaining({ code: 'HARNESS_INVENTORY_UNAVAILABLE' }))
    await collect()
    binding = { ...binding, connectionEpoch: randomUUID(), connectionGeneration: 2 }
    expect(() => registry.pinOverride(profile))
      .toThrow(expect.objectContaining({ code: 'HARNESS_INVENTORY_STALE' }))
    await collect()
    expect(() => registry.pinOverride(profile))
      .toThrow(expect.objectContaining({ code: 'HARNESS_INSTALLATION_CHANGED' }))
  } finally { registry.stop(); await pool.end() }
})

it('pins actual main installation payloads and invalidates selections after passive refresh', async () => {
  const pool = new pg.Pool({ connectionString: 'postgresql://unused@127.0.0.1:1/unused' })
  let payload = 'payload-A'
  let reads = 0
  const launcher: typeof discoverLauncher = async (requested, environment, paths = []) => {
    reads++
    return { requested, resolvedLauncher: `/recorded/${requested}`, fingerprint: payload,
      payloadFingerprints: paths.map((path) => ({ path, fingerprint: payload })), status: 'installed',
      interpreter: null, diagnostics: [], environment, checkedAt: '2026-10-01T00:00:00.000Z' }
  }
  const payloads: typeof passiveDriverPayloads = async () => ({ complete: true, paths: ['/recorded/provider-payload'] })
  const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'codex', openCodeBinary: 'opencode' },
    async () => ({ revision: 8, defaults: {
      codex: { harness: 'codex', model: 'recorded-model', reasoningEffort: 'medium', serviceTier: 'standard', sandbox: 'read-only' },
      opencode: { harness: 'opencode', model: 'recorded/model', variant: '', nativeAgent: 'build', thinking: false, autoApprove: false },
    } }), new HostHarnessProfileEvidenceRepository(pool), () => null, { PATH: '/recorded' }, { launcher, payloads })
  try {
    await registry.initialize('d46e2a2b-130f-46de-a93b-78a2352b9c9d')
    const selection = registry.pinDefault('codex')
    expect(selection.selection.hostRef).toEqual({ kind: 'main', mainId: 'd46e2a2b-130f-46de-a93b-78a2352b9c9d' })
    expect(selection.installation.installationFingerprint).toBe('payload-A')
    expect(selection.installation.qualified).toBeNull()
    expect(reads).toBe(4)
    expect(registry.installations.list().find(value => value.driverId === 'claude')).toMatchObject({
      installed: false, installationFingerprint: null, authenticated: null, qualified: null,
    })
    await registry.refreshMain()
    expect(() => registry.installations.assertCurrent(selection)).not.toThrow()
    payload = 'payload-B'
    await registry.refreshMain()
    expect(() => registry.installations.assertCurrent(selection)).toThrow()
    expect(registry.pinDefault('codex').installation.installationFingerprint).toBe('payload-B')
    registry.stop()
    expect(() => registry.pinDefault('codex')).toThrow('shutting down')
  } finally { await pool.end() }
})


it('consumes the explicit passive Claude SDK declaration without default profiles or OpenCode launcher fallback', async () => {
  const { DEFAULT_HARNESS_DEFAULTS } = await import('@graphql/contracts')
  const pool = new pg.Pool({ connectionString: 'postgresql://unused@127.0.0.1:1/unused' })
  const launcher: typeof discoverLauncher = vi.fn<typeof discoverLauncher>(async (requested, environment) => ({ requested,
    resolvedLauncher: `/recorded/${requested}`, fingerprint: 'generic', status: 'installed', interpreter: null,
    diagnostics: [], environment, checkedAt: '2026-10-01T00:00:00.000Z' }))
  const claude = vi.fn<NonNullable<NonNullable<ConstructorParameters<typeof ProductionHarnessRegistry>[6]>['claude']>>(async (_host, environment) => ({ sdkVersion: '0.3.284', sdkIntegrity: 'recorded-installed-integrity',
    launcher: { requested: '/recorded/sdk-native', resolvedLauncher: '/recorded/sdk-native', fingerprint: 'sdk-and-cli-payloads',
      status: 'installed' as const, interpreter: null, diagnostics: [], environment, checkedAt: '2026-10-01T00:00:00.000Z' },
    declaration: { harnessInstallationId: 'sdk-installation', requestedLauncher: '/recorded/sdk-native',
      payloadPaths: ['/recorded/sdk.mjs'], driverId: 'claude', driverRevision: '1', protocolRevision: 'claude-sdk-0.3.284' },
  }))
  const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'codex', openCodeBinary: 'opencode' },
    async () => ({ revision: 1, defaults: DEFAULT_HARNESS_DEFAULTS }), new HostHarnessProfileEvidenceRepository(pool), () => null,
    { PATH: '/recorded' }, { launcher, payloads: async () => ({ complete: true, paths: [] }), claude })
  try {
    await registry.initialize('d46e2a2b-130f-46de-a93b-78a2352b9c9d')
    expect(registry.installations.list().find(value => value.driverId === 'claude')).toMatchObject({
      harnessInstallationId: 'sdk-installation', installationFingerprint: 'sdk-and-cli-payloads', installed: true,
      observedVersion: null, authenticated: null, compatible: null, qualified: null, protocolRevision: 'claude-sdk-0.3.284',
    })
    expect(claude).toHaveBeenCalledOnce()
    expect(vi.mocked(launcher).mock.calls.map(([requested]) => requested)).toEqual(['codex', 'codex', 'opencode', 'opencode'])
    expect(registry.instances.list().some(value => value.driverId === 'claude')).toBe(false)
  } finally { registry.stop(); await pool.end() }
})
