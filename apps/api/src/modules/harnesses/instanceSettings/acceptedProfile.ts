import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@graphql/contracts/harness-registry'
import { ClaudeQualificationPinSchema, type ClaudeQualificationPin } from '@graphql/contracts/claude-qualification'
import type { RegistryHarnessSelection } from '../installationRegistry.js'
import type { HarnessInstanceSettingsRepository } from './repository.js'
import type { HostHarnessProfileEvidenceRepository } from './profileRepository.js'
import { DomainError } from '../../errors.js'

export interface AcceptedProfileSelector {
  instanceId: string
  instanceRevision: string
  target: HostHarnessOverride['target']
}
export type CurrentHarnessProfileBinding = Pick<HostHarnessProfileEvidence,
  'target' | 'instanceRevision' | 'configurationFingerprint' | 'driverId' | 'driverRevision' |
  'protocolRevision' | 'suiteRevision' | 'environmentGeneration' | 'connectionGeneration'> & {
    instanceId: string
    pin?: ClaudeQualificationPin
  }
export type CurrentClaudeProfileBinding = CurrentHarnessProfileBinding & { pin: ClaudeQualificationPin }
export interface AcceptedHarnessProfile {
  override: HostHarnessOverride
  persistedProof: HostHarnessProfileEvidence
  currentBinding: CurrentHarnessProfileBinding
}
export interface AcceptedClaudeProfile {
  override: HostHarnessOverride
  persistedProof: HostHarnessProfileEvidence
  currentBinding: CurrentClaudeProfileBinding
}
/** The caller supplies its actual execution/conversation/turn owner authority, never a management grant surrogate. */
export interface AcceptedProfileAuthority<Owner> {
  authorize(owner: Owner, selector: AcceptedProfileSelector, client: pg.PoolClient): Promise<void>
  current(owner: Owner, value: HostHarnessOverride, client: pg.PoolClient): Promise<{
    registry: RegistryHarnessSelection
    applicationInstallationId: string
    suiteRevision: string
    pin?: ClaudeQualificationPin
  }>
  assertCurrent(binding: RegistryHarnessSelection): void
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const unavailable = (): never => { throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The exact accepted native profile is unavailable or its proof is stale.', 409) }

/** Reads existing immutable settings and real native proof. No manager, native probe or default-profile synthesis. */
export class AcceptedHarnessProfileAdmission<Owner> {
  constructor(
    private readonly settings: HarnessInstanceSettingsRepository,
    private readonly proofs: HostHarnessProfileEvidenceRepository,
    private readonly authority: AcceptedProfileAuthority<Owner>,
  ) {}
  async admit(owner: Owner, selector: AcceptedProfileSelector): Promise<AcceptedHarnessProfile> {
    // Snapshot before any await so a mutable caller cannot change the authorized selector.
    const selected = freeze(structuredClone(selector))
    return this.settings.readAuthorized(async client => {
      await this.authority.authorize(owner, selected, client)
      await this.settings.lockRevision(client, selected.instanceId)
      const value = await this.settings.latest(client, selected.instanceId)
      if (!value || !value.enabled || value.driverId !== value.configuration.harness
        || value.instanceRevision !== selected.instanceRevision || !isDeepStrictEqual(value.target, selected.target)) return unavailable()
      const proof = await this.proofs.latest(value.instanceId, value.revision, client)
      if (!proof || !proof.qualified || proof.authenticated !== true || proof.compatible !== true ) return unavailable()
      const current = await this.authority.current(owner, value, client)
      this.authority.assertCurrent(current.registry)
      const { selection, installation, instance } = current.registry
      if (current.applicationInstallationId !== value.target.applicationInstallationId
        || selection.instanceId !== value.instanceId || selection.instanceRevision !== value.instanceRevision
        || selection.driverId !== value.driverId || !isDeepStrictEqual(selection.hostRef, value.target.hostRef)
        || selection.harnessInstallationId !== value.target.harnessInstallationId
        || selection.installationFingerprint !== value.target.installationFingerprint
        || !isDeepStrictEqual(instance.configuration, value.configuration)) return unavailable()
      const binding: CurrentHarnessProfileBinding = {
        instanceId: value.instanceId, target: value.target, instanceRevision: value.instanceRevision,
        configurationFingerprint: value.configurationFingerprint, driverId: value.driverId,
        driverRevision: installation.driverRevision, protocolRevision: installation.protocolRevision,
        suiteRevision: current.suiteRevision, environmentGeneration: installation.environmentGeneration,
        connectionGeneration: installation.connectionGeneration,
        ...(value.driverId === 'claude' ? { pin: ClaudeQualificationPinSchema.parse(current.pin) } : {}),
      }
      for (const key of ['target', 'instanceRevision', 'configurationFingerprint', 'driverId', 'driverRevision',
        'protocolRevision', 'suiteRevision', 'environmentGeneration', 'connectionGeneration'] as const) {
        if (!isDeepStrictEqual(proof[key], binding[key])) return unavailable()
      }
      if (value.configuration.harness === 'claude' && (!proof.claudeProof || !binding.pin
        || !isDeepStrictEqual(proof.claudeProof.pin, binding.pin) || binding.pin.profilePath !== value.configuration.configDirectory)) return unavailable()
      await this.authority.authorize(owner, selected, client)
      this.authority.assertCurrent(current.registry)
      return freeze(structuredClone({ override: value, persistedProof: proof, currentBinding: binding }))
    })
  }
  /** Invoke in the existing async native-effect guard; the synchronous factory consumes only the frozen snapshot. */
  async revalidate(owner: Owner, accepted: AcceptedHarnessProfile): Promise<void> {
    const current = await this.admit(owner, {
      instanceId: accepted.override.instanceId, instanceRevision: accepted.override.instanceRevision, target: accepted.override.target,
    })
    if (!isDeepStrictEqual(current, accepted)) unavailable()
  }
}


/** Claude admission adds its mandatory genuine current SDK/CLI/profile pin. */
export class AcceptedClaudeProfileAdmission<Owner> extends AcceptedHarnessProfileAdmission<Owner> {
  override async admit(owner: Owner, selector: AcceptedProfileSelector): Promise<AcceptedClaudeProfile> {
    const accepted = await super.admit(owner, selector)
    if (accepted.override.driverId !== 'claude' || accepted.override.configuration.harness !== 'claude' || !accepted.currentBinding.pin) return unavailable()
    return freeze({ ...accepted, currentBinding: { ...accepted.currentBinding, pin: accepted.currentBinding.pin } })
  }
}
