import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import type { RegistryHarnessSelection } from '../src/modules/harnesses/installationRegistry.js'
import { AcceptedHarnessProfileAdmission, AcceptedClaudeProfileAdmission, type AcceptedProfileAuthority } from '../src/modules/harnesses/instanceSettings/acceptedProfile.js'
import type { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import type { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../src/modules/harnesses/instanceRegistry.js'
import { claudeDiscoveryDeclaration } from '../src/modules/harnesses/claudeDiscovery.js'

function fixture() {
  const target = { hostRef: { kind: 'main' as const, mainId: 'main' }, applicationInstallationId: 'main', harnessInstallationId: 'cli', installationFingerprint: 'hash' }
  const configuration = { harness: 'claude' as const, model: 'model', authMode: 'subscription' as const, configDirectory: '/profile', permissionMode: 'default' as const,
    sandbox: 'read-only' as const, tools: [], permissionRules: [], instructions: '', mcpServers: {} }
  const value: HostHarnessOverride = { instanceId: 'instance', instanceRevision: '1', revision: 1, target, presetId: 'preset', enabled: true,
    driverId: 'claude', configuration, configurationFingerprint: 'config', qualification: 'unqualified' }
  const pin = { sdkVersion: 'sdk', sdkIntegrity: 'integrity', cliVersion: 'cli', executableSha256: 'a'.repeat(64), profilePath: '/profile', configRevision: 'config' }
  const proof: HostHarnessProfileEvidence = { target, instanceRevision: '1', configurationFingerprint: 'config', driverId: 'claude', driverRevision: '1',
    protocolRevision: 'p', suiteRevision: 's', environmentGeneration: 'e', connectionGeneration: 'c', authenticated: true, compatible: true,
    qualified: true, checkedAt: '2026-10-01T00:00:00Z', claudeProof: { pin, checks: {} } }
  const client = {} as pg.PoolClient
  const settings = { readAuthorized: async <T>(fn: (client: pg.PoolClient) => Promise<T>) => fn(client),
    latest: vi.fn(async () => value), savedRevision: vi.fn(async () => value), lockRevision: vi.fn(async () => {}) }
  const proofs = { latest: vi.fn(async () => proof) }
  const registry = { selection: { instanceId: value.instanceId, instanceRevision: '1', driverId: 'claude', hostRef: target.hostRef,
    harnessInstallationId: 'cli', installationFingerprint: 'hash' }, instance: { configuration }, installation: {
    driverRevision: '1', protocolRevision: 'p', environmentGeneration: 'e', connectionGeneration: 'c' } } as RegistryHarnessSelection
  const authority: AcceptedProfileAuthority<string> = { authorize: vi.fn(async () => {}), assertCurrent: vi.fn(),
    current: vi.fn(async () => ({ registry, applicationInstallationId: 'main', suiteRevision: 's', pin })) }
  const admission = new AcceptedClaudeProfileAdmission(settings as unknown as HarnessInstanceSettingsRepository, proofs as unknown as HostHarnessProfileEvidenceRepository, authority)
  return { value, proof, client, settings, proofs, authority, registry, admission, selector: { instanceId: value.instanceId, instanceRevision: '1', target } }
}
describe('exact accepted Claude profile admission', () => {
  it('reads existing same-client proof and freezes independent snapshots without inferring qualification from settings', async () => {
    const f = fixture(); const result = await f.admission.admit('actual-owner', f.selector)
    expect(f.proofs.latest).toHaveBeenCalledWith('instance', 1, f.client)
    expect(Object.isFrozen(result.currentBinding.pin)).toBe(true)
    f.proof.claudeProof!.pin.sdkVersion = 'changed'
    expect(result.persistedProof.claudeProof!.pin.sdkVersion).toBe('sdk')
    expect(f.authority.authorize).toHaveBeenCalledTimes(2)
  })
  it('denies the owner before reading a profile', async () => {
    const f = fixture(); vi.mocked(f.authority.authorize).mockRejectedValue(new Error('revoked owner'))
    await expect(f.admission.admit('denied', f.selector)).rejects.toThrow('revoked owner')
    expect(f.settings.latest).not.toHaveBeenCalled()
  })
  it('uses the requalified installation for a saved selector while retaining the configuration revision', async () => {
    const f = fixture()
    const original = structuredClone(f.value)
    f.value.revision = 2
    f.value.target = { ...f.value.target, installationFingerprint: 'updated' }
    f.proof.target = f.value.target
    Object.assign(f.registry, { selection: { ...f.registry.selection, installationFingerprint: 'updated' } })
    f.settings.savedRevision.mockResolvedValue(original)
    const accepted = await f.admission.admit('owner', f.selector)
    expect(accepted.override.revision).toBe(2)
    expect(accepted.override.instanceRevision).toBe(original.instanceRevision)
    expect(accepted.override.target.installationFingerprint).toBe('updated')
    expect(f.settings.savedRevision).toHaveBeenCalledWith(f.client, original.instanceId,
      original.instanceRevision, { target: original.target })
    f.settings.savedRevision.mockResolvedValue({ ...original, configurationFingerprint: 'another-config' })
    await expect(f.admission.admit('owner', f.selector)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
  })
  it('reports the pending automatic check before trying to consume old native proof', async () => {
    const f = fixture()
    f.authority.assertReady = () => { throw Object.assign(new Error('Harness profile checks are pending'),
      { code: 'HARNESS_PROFILE_CHECK_PENDING' }) }
    await expect(f.admission.admit('owner', f.selector)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_CHECK_PENDING' })
    expect(f.proofs.latest).not.toHaveBeenCalled()
  })
  it.each(['instanceRevision', 'configurationFingerprint', 'driverRevision', 'protocolRevision', 'suiteRevision', 'environmentGeneration', 'connectionGeneration'] as const)('rejects stale %s proof', async key => {
    const f = fixture(); f.proof[key] = 'stale'
    await expect(f.admission.admit('owner', f.selector)).rejects.toThrow('stale')
  })
  it('rejects changed instance head, target and configuration instead of matching another profile', async () => {
    for (const mutate of [(f: ReturnType<typeof fixture>) => { f.value.instanceRevision = '2' },
      (f: ReturnType<typeof fixture>) => { Object.assign(f.registry, { selection: { ...f.registry.selection, installationFingerprint: 'new' } }) },
      (f: ReturnType<typeof fixture>) => { Object.assign(f.registry, { instance: { ...f.registry.instance, configuration: {} } }) }]) {
      const f = fixture(); mutate(f)
      await expect(f.admission.admit('owner', f.selector)).rejects.toThrow('stale')
    }
  })
  it('rejects owner revocation during profile admission', async () => {
    const f = fixture(); vi.mocked(f.authority.authorize).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'))
    await expect(f.admission.admit('owner', f.selector)).rejects.toThrow('revoked')
  })
  it('rejects old SDK pin and revalidates revocation before native effect', async () => {
    const f = fixture(); const accepted = await f.admission.admit('owner', f.selector)
    f.proof.claudeProof!.pin.sdkIntegrity = 'different'
    await expect(f.admission.revalidate('owner', accepted)).rejects.toThrow('stale')
    vi.mocked(f.authority.authorize).mockRejectedValue(new Error('revoked'))
    await expect(f.admission.revalidate('owner', accepted)).rejects.toThrow('revoked')
  })
  it('registers Claude configuration without a manager or default profile', () => {
    const f = fixture(); const registry = new HarnessInstanceRegistry(localHarnessDrivers)
    registry.reload([{ instanceId: 'explicit', instanceRevision: '1', driverId: 'claude', enabled: true, configuration: f.value.configuration }])
    expect(registry.select('explicit').driverId).toBe('claude')
    expect(claudeDiscoveryDeclaration({ harnessInstallationId: 'cli', requestedLauncher: '/cli', payloadPaths: ['/sdk'], protocolRevision: 'p' }).driverId).toBe('claude')
    expect(() => claudeDiscoveryDeclaration({ harnessInstallationId: 'cli', requestedLauncher: '/cli', payloadPaths: [], protocolRevision: 'p' })).toThrow('payload')
  })
})

it.each(['codex'] as const)('admits the exact selected %s profile without manufacturing a Claude pin', async driver => {
  const { DEFAULT_HARNESS_DEFAULTS } = await import('@foreman-code/contracts')
  const f = fixture()
  const configuration = DEFAULT_HARNESS_DEFAULTS[driver]
  f.value.driverId = driver; f.value.configuration = configuration
  f.proof.driverId = driver; delete f.proof.claudeProof
  Object.assign(f.registry, { selection: { ...f.registry.selection, driverId: driver }, instance: { ...f.registry.instance, configuration } })
  const admission = new AcceptedHarnessProfileAdmission(f.settings as unknown as HarnessInstanceSettingsRepository,
    f.proofs as unknown as HostHarnessProfileEvidenceRepository, f.authority)
  const accepted = await admission.admit('actual-owner', f.selector)
  expect(accepted.override.driverId).toBe(driver)
  expect(accepted.currentBinding.pin).toBeUndefined()
  expect(Object.isFrozen(accepted.override.configuration)).toBe(true)
  f.proof.connectionGeneration = 'previous-process'
  await expect(admission.admit('actual-owner', f.selector)).rejects.toThrow('stale')
  expect((await admission.admitObservation('saved-session-owner', f.selector)).override).toEqual(accepted.override)
  f.value.instanceRevision = 'new-profile-revision'
  await expect(admission.revalidate('actual-owner', accepted)).rejects.toThrow('stale')
})
