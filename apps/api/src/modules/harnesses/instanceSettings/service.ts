import type pg from 'pg'
import { withAdvancedDefaults } from '@graphql/contracts'
import { HostHarnessOverrideListInputSchema, HostHarnessOverrideSaveSchema, type HostHarnessOverride, type HostHarnessOverrideListInput, type HostHarnessOverrideSave } from '@graphql/contracts/harness-registry'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { CanonicalMachineReference } from '@graphql/contracts/device-identity'
import { DomainError } from '../../errors.js'
import { requireAuthorization } from '../../access/policy.js'
import { commandInputHash, type PostgresCommandCoordinator } from '../../commands/postgres.js'
import { harnessHostKey, type HarnessInstanceSettingsRepository } from './repository.js'

export interface HostHarnessOverrideAuthority {
  authorize(principal: ManagementPrincipal, action: 'harnesses:read' | 'harnesses:update', hostRef: CanonicalMachineReference, applicationInstallationId: string, client?: pg.PoolClient): Promise<void>
}
export interface HostHarnessOverrideEvidence {
  /** Resolver must match current driver/protocol/suite and authorized connection generations. */
  target: HostHarnessOverride['target']
  configurationFingerprint: string
  qualified: boolean
}

/** Shared HTTP/MCP domain authority. No watcher, native spawn or credential storage. */
export class HostHarnessOverrideService {
  constructor(private readonly repository: HarnessInstanceSettingsRepository,
    private readonly commands: PostgresCommandCoordinator,
    private readonly authority: HostHarnessOverrideAuthority,
    private readonly evidence: (value: HostHarnessOverride) => Promise<HostHarnessOverrideEvidence | null> = async () => null,
  ) {}
  private async describe(value: HostHarnessOverride): Promise<HostHarnessOverride> {
    if (!value.enabled) return { ...value, qualification: 'disabled' }
    // Missing/remote failed evidence remains unavailable, never substitutes local discovery.
    const evidence = await this.evidence(value).catch(() => null)
    const qualification = !evidence ? 'unqualified' : harnessHostKey(evidence.target.hostRef) !== harnessHostKey(value.target.hostRef)
      || evidence.target.applicationInstallationId !== value.target.applicationInstallationId
      || evidence.target.harnessInstallationId !== value.target.harnessInstallationId
      || evidence.target.installationFingerprint !== value.target.installationFingerprint
      ? 'installation-changed' : evidence.configurationFingerprint === value.configurationFingerprint && evidence.qualified ? 'qualified' : 'unqualified'
    return { ...value, qualification }
  }
  async list(principal: ManagementPrincipal, raw: HostHarnessOverrideListInput, source: 'http' | 'mcp' = 'http'): Promise<{ overrides: HostHarnessOverride[] }> {
    try { return await this.read(principal, raw) } catch (error) {
      if (error instanceof DomainError && error.status === 403) await this.commands.recordDenied(principal.id, source, 'harness_instances_list', 'harness-instances')
      throw error
    }
  }
  private async read(principal: ManagementPrincipal, raw: HostHarnessOverrideListInput): Promise<{ overrides: HostHarnessOverride[] }> {
    requireAuthorization(principal, 'harnesses:read')
    const input = HostHarnessOverrideListInputSchema.parse(raw)
    return this.repository.readAuthorized(async client => {
      await this.authority.authorize(principal, 'harnesses:read', input.hostRef, input.applicationInstallationId, client)
      const overrides = await this.repository.list(input.hostRef, input.applicationInstallationId, client)
      return { overrides: await Promise.all(overrides.map(value => this.describe(value))) }
    })
  }
  async save(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: HostHarnessOverrideSave) {
    try { return await this.saveAuthorized(principal, source, raw) } catch (error) {
      if (error instanceof DomainError && error.status === 403) await this.commands.recordDenied(principal.id, source, 'harness_instance_save', `harness-instance:${raw.instanceId}`)
      throw error
    }
  }
  private async saveAuthorized(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: HostHarnessOverrideSave) {
    requireAuthorization(principal, 'harnesses:update')
    const input = HostHarnessOverrideSaveSchema.parse(raw)
    // Existing validators retain sandbox/model/advanced controls; no credentials are accepted.
    const configuration = withAdvancedDefaults(input.configuration)
    const configurationFingerprint = commandInputHash(configuration)
    const result = await this.commands.execute({ principal, source, operation: 'harness.instance.save', commandId: input.commandId,
      targetKey: `harness-instance:${input.instanceId}`, payload: input,
      authorize: client => this.authority.authorize(principal, 'harnesses:update', input.target.hostRef, input.target.applicationInstallationId, client),
      perform: async client => {
        const revision = input.expectedRevision + 1
        const value: HostHarnessOverride = { instanceId: input.instanceId, revision, instanceRevision: String(revision),
          target: input.target, presetId: input.presetId, enabled: input.enabled, driverId: configuration.harness,
          configuration, configurationFingerprint, qualification: input.enabled ? 'unqualified' : 'disabled' }
        return this.repository.append(client, principal.id, input.expectedRevision, value)
      },
    })
    // Receipts remain immutable; readback rechecks current exact-target qualification.
    return { value: await this.describe(result.value), replayed: result.replayed }
  }
}

/** Admission consumes the exact readback snapshot; saved settings alone grant no execution trust. */
export function requireQualifiedHostOverride(value: HostHarnessOverride, expected: { instanceRevision: string; target: HostHarnessOverride['target'] }): HostHarnessOverride {
  if (!value.enabled || value.qualification !== 'qualified' || value.instanceRevision !== expected.instanceRevision
    || value.target.installationFingerprint !== expected.target.installationFingerprint
    || value.target.harnessInstallationId !== expected.target.harnessInstallationId
    || value.target.applicationInstallationId !== expected.target.applicationInstallationId
    || harnessHostKey(value.target.hostRef) !== harnessHostKey(expected.target.hostRef)) {
    throw new DomainError('HARNESS_INSTANCE_UNQUALIFIED', 'The exact host instance revision and installation require qualification.', 409)
  }
  return structuredClone(value)
}
