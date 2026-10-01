import type { CanonicalMachineReference } from '@graphql/contracts/device-identity'
import type { HarnessInstanceProjection, HarnessInstanceRegistry } from './instanceRegistry.js'
import type { LauncherEvidence } from './hostDiscovery.js'

export interface HarnessInstallationRecord {
  readonly hostRef: CanonicalMachineReference
  /** Provider executable installation, never the W07 application installationId. */
  readonly harnessInstallationId: string
  readonly installationFingerprint: string | null
  readonly driverId: string
  readonly driverRevision: string
  readonly protocolRevision: string
  readonly environmentGeneration: string
  readonly connectionGeneration: string
  readonly launcher: LauncherEvidence
  readonly observedVersion: string | null
  readonly installed: boolean
  readonly authenticated: boolean | null
  readonly compatible: boolean | null
  readonly qualified: boolean | null
}
export interface PinnedHarnessSelection {
  readonly driverId: string
  readonly instanceId: string
  readonly instanceRevision: string
  readonly hostRef: CanonicalMachineReference
  readonly harnessInstallationId: string
  readonly installationFingerprint: string
}
export interface RegistryHarnessSelection {
  readonly inventoryRevision: number
  readonly selection: PinnedHarnessSelection
  readonly instance: HarnessInstanceProjection
  readonly installation: HarnessInstallationRecord
}
const hostKey = (host: CanonicalMachineReference) => host.kind === 'main' ? `main:${host.mainId}` : `device:${host.mainId}:${host.deviceId}`

/** A projection of canonical authorized-host inventory; no native managers or IO. */
export class HarnessInstallationRegistry {
  private readonly installations = new Map<string, HarnessInstallationRecord>()
  private readonly cache = new Map<string, { epoch: number; value: Promise<unknown> }>()
  private epoch = 0
  constructor(private readonly instances: HarnessInstanceRegistry) {}
  refresh(records: readonly HarnessInstallationRecord[]): void {
    const next = new Map<string, HarnessInstallationRecord>()
    for (const record of records) {
      const key = `${hostKey(record.hostRef)}:${record.harnessInstallationId}`
      if (next.has(key)) throw new Error('Duplicate host harness installation.')
      next.set(key, structuredClone(record))
    }
    this.installations.clear()
    for (const [key, record] of next) this.installations.set(key, record)
    this.invalidate()
  }
  list(): readonly HarnessInstallationRecord[] { return [...this.installations.values()].map((record) => structuredClone(record)) }
  invalidate(): void { this.epoch++; this.cache.clear() }
  pin(input: { instanceId: string; hostRef: CanonicalMachineReference; harnessInstallationId: string; connectionGeneration: string; environmentGeneration: string }): RegistryHarnessSelection {
    const instance = this.instances.select(input.instanceId)
    const record = this.installations.get(`${hostKey(input.hostRef)}:${input.harnessInstallationId}`)
    if (!record || !record.installationFingerprint || !record.installed || record.launcher.status !== 'installed' || record.launcher.fingerprint !== record.installationFingerprint
      || record.driverId !== instance.driverId || record.driverRevision !== instance.driverRevision
      || record.connectionGeneration !== input.connectionGeneration || record.environmentGeneration !== input.environmentGeneration) {
      throw new Error('Harness installation unavailable or stale on selected host.')
    }
    // Return independent serializable snapshots; no process/session/token state is shared.
    return { inventoryRevision: this.epoch, instance, installation: structuredClone(record), selection: Object.freeze({ driverId: instance.driverId, instanceId: instance.instanceId, instanceRevision: instance.instanceRevision, hostRef: Object.freeze({ ...input.hostRef }), harnessInstallationId: record.harnessInstallationId, installationFingerprint: record.installationFingerprint }) }
  }
  assertCurrent(binding: RegistryHarnessSelection): void {
    if (binding.inventoryRevision !== this.epoch || this.instances.select(binding.instance.instanceId).instanceRevision !== binding.instance.instanceRevision) throw new Error('Harness metadata binding is stale.')
  }
  async metadata<T>(binding: RegistryHarnessSelection, suiteRevision: string, load: () => Promise<T>): Promise<T> {
    this.assertCurrent(binding)
    const { instance, installation } = binding
    const key = JSON.stringify([hostKey(installation.hostRef), installation.harnessInstallationId, installation.installationFingerprint,
      instance.instanceId, instance.instanceRevision, instance.driverRevision, installation.protocolRevision, suiteRevision, installation.environmentGeneration, installation.connectionGeneration])
    let entry = this.cache.get(key)
    if (!entry) {
      if (this.cache.size >= 128) throw new Error('Harness metadata cache is full; refresh inventory.')
      entry = { epoch: this.epoch, value: Promise.resolve().then(load) }
      this.cache.set(key, entry)
      const selected = entry
      void entry.value.catch(() => { if (this.cache.get(key) === selected) this.cache.delete(key) })
    }
    const value = await entry.value
    if (entry.epoch !== this.epoch) throw new Error('Harness metadata result is stale.')
    this.assertCurrent(binding)
    return structuredClone(value) as T
  }
}
