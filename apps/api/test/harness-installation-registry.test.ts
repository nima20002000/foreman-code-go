import { describe, expect, it } from 'vitest'
import { HarnessInstanceRegistry } from '../src/modules/harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry, type HarnessInstallationRecord } from '../src/modules/harnesses/installationRegistry.js'

function fixture() {
  const instances = new HarnessInstanceRegistry([{ driverId: 'test', driverRevision: '1', decodeConfiguration: (value) => value }])
  instances.reload([{ instanceId: 'a', instanceRevision: '1', driverId: 'test', enabled: true, configuration: { model: 'one' } }])
  const hostRef = { kind: 'device' as const, mainId: 'main', deviceId: 'device' }
  const record: HarnessInstallationRecord = {
    hostRef, harnessInstallationId: 'provider-install', installationFingerprint: 'sha', driverId: 'test', driverRevision: '1', protocolRevision: '1',
    environmentGeneration: 'env', connectionGeneration: 'connection', observedVersion: null, installed: true, authenticated: null, compatible: null, qualified: null,
    launcher: { requested: '/tool', resolvedLauncher: '/tool', fingerprint: 'sha', status: 'installed', interpreter: null, diagnostics: [], checkedAt: 'now', environment: { generation: 'env', provenance: 'worker', cwd: '/', path: '/bin' } },
  }
  const registry = new HarnessInstallationRegistry(instances); registry.refresh([record])
  const input = { hostRef, instanceId: 'a', harnessInstallationId: 'provider-install', environmentGeneration: 'env', connectionGeneration: 'connection' }
  return { registry, instances, record, input }
}

describe('canonical host harness inventory', () => {
  it('fails closed on wrong host, missing installation and stale generations with no local fallback', () => {
    const { registry, input } = fixture()
    expect(registry.pin(input).selection.hostRef).toEqual(input.hostRef)
    for (const changes of [{ hostRef: { ...input.hostRef, deviceId: 'another' } }, { harnessInstallationId: 'unknown' }, { connectionGeneration: 'old' }, { environmentGeneration: 'old' }, { instanceId: 'unknown' }]) {
      expect(() => registry.pin({ ...input, ...changes })).toThrow()
    }
  })
  it('keeps installation/authentication/compatibility/qualification independent', () => {
    const { registry, input } = fixture()
    expect(registry.pin(input).installation).toMatchObject({ installed: true, authenticated: null, compatible: null, qualified: null })
  })
  it('ignores stale async evidence after refresh or instance edits', async () => {
    const { registry, input, record, instances } = fixture()
    let finish!: (value: string) => void
    const pending = registry.metadata(registry.pin(input), 'suite', () => new Promise<string>((resolve) => { finish = resolve }))
    await Promise.resolve()
    registry.refresh([record]); finish('old')
    await expect(pending).rejects.toThrow('stale')
    const binding = registry.pin(input)
    instances.reload([{ instanceId: 'a', instanceRevision: '2', driverId: 'test', enabled: true, configuration: { model: 'two' } }])
    await expect(registry.metadata(binding, 'suite', async () => 'old')).rejects.toThrow('stale')
    expect(binding.instance.configuration).toEqual({ model: 'one' })
  })
  it('shares only metadata single flights and keys suite revisions independently', async () => {
    const { registry, input } = fixture(); const binding = registry.pin(input)
    let loads = 0
    const load = async () => { loads++; return { result: 'value' } }
    const [a, b] = await Promise.all([registry.metadata(binding, '1', load), registry.metadata(binding, '1', load)])
    expect(loads).toBe(1); expect(a).not.toBe(b)
    await registry.metadata(binding, '2', load); expect(loads).toBe(2)
  })
})
