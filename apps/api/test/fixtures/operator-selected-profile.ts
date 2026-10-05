import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { DEFAULT_HARNESS_DEFAULTS, withAdvancedDefaults, type OpenCodeHarnessConfiguration } from '@graphql/contracts'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@graphql/contracts/harness-registry'
import { commandInputHash } from '../../src/modules/commands/postgres.js'
import { DomainError } from '../../src/modules/errors.js'
import { ProductionHarnessRegistry } from '../../src/modules/harnesses/productionRegistry.js'
import { AcceptedHarnessProfileAdmission } from '../../src/modules/harnesses/instanceSettings/acceptedProfile.js'
import { HarnessInstanceSettingsRepository } from '../../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../../src/modules/harnesses/instanceSettings/profileRepository.js'
import type { ClaudeProfileOwner } from '../../src/modules/harnesses/claudeSdk/production.js'
import { PostgresClaudeInteractionAuthority } from '../../src/modules/harnesses/claudeSdk/domainAuthority.js'
import { authorizeOperatorProfileObservation } from '../../src/modules/harnesses/operatorProfileObservation.js'
import type { discoverLauncher } from '../../src/modules/harnesses/hostDiscovery.js'

// Only installed-provider metadata is recorded. Profile and owner admission use PostgreSQL.
export async function operatorSelectedProfile(pool: pg.Pool, principalId: string,
  configuration: OpenCodeHarnessConfiguration) {
  const mainId = randomUUID()
  const settings = new HarnessInstanceSettingsRepository(pool)
  const proofs = new HostHarnessProfileEvidenceRepository(pool)
  const launcher: typeof discoverLauncher = async (requested, environment, paths = []) => ({
    requested, resolvedLauncher: `/recorded/${requested}`, fingerprint: 'recorded-provider', status: 'installed',
    payloadFingerprints: paths.map(path => ({ path, fingerprint: 'recorded-provider' })),
    interpreter: null, diagnostics: [], environment, checkedAt: '2026-10-05T00:00:00.000Z',
  })
  const loadRegistry = async () => {
    const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'codex', openCodeBinary: 'opencode' },
      async () => ({ revision: 1, defaults: { ...DEFAULT_HARNESS_DEFAULTS, opencode: configuration } }),
      proofs, () => null, process.env, { launcher, payloads: async () => ({ complete: true, paths: [] }) })
    await registry.initialize(mainId)
    return registry
  }
  const registry = await loadRegistry()
  const installed = registry.pinDefault('opencode').installation
  const target = { hostRef: installed.hostRef, applicationInstallationId: mainId,
    harnessInstallationId: installed.harnessInstallationId, installationFingerprint: installed.installationFingerprint! }
  const value: HostHarnessOverride = { instanceId: randomUUID(), instanceRevision: 'selected-profile-1', revision: 1,
    target, presetId: 'recorded-opencode', enabled: true, driverId: 'opencode', configuration,
    configurationFingerprint: commandInputHash(withAdvancedDefaults(configuration)), qualification: 'qualified' }
  const proof: HostHarnessProfileEvidence = { target, instanceRevision: value.instanceRevision,
    configurationFingerprint: value.configurationFingerprint, driverId: 'opencode', driverRevision: installed.driverRevision,
    protocolRevision: installed.protocolRevision, suiteRevision: 'opencode-profile-check-v1',
    environmentGeneration: installed.environmentGeneration, connectionGeneration: installed.connectionGeneration,
    authenticated: true, compatible: true, qualified: true, checkedAt: '2026-10-05T00:00:00.000Z' }
  const client = await pool.connect()
  try {
    await client.query('begin')
    await settings.append(client, principalId, 0, value)
    await proofs.append(client, randomUUID(), value, proof)
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally { client.release() }
  const admission = (currentRegistry: ProductionHarnessRegistry) => new AcceptedHarnessProfileAdmission<ClaudeProfileOwner>(
    settings, proofs, {
      async authorize(owner, selector, sql) {
        owner.admissionSignal?.throwIfAborted()
        if (owner.kind === 'operator-observation') await authorizeOperatorProfileObservation(sql, owner, selector)
        else if (owner.kind === 'operator') {
          await new PostgresClaudeInteractionAuthority(sql, owner, { nativeCallbackContext: () => undefined }).callbackAdmission()
        } else throw new Error('Expected an Operator owner')
      },
      async current(owner, override, sql) {
        if (owner.kind !== 'operator-observation' && !await currentRegistry.profileEvidence(override, sql)) {
          throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The native profile is stale.', 409)
        }
        return { registry: currentRegistry.pinOverride(override), applicationInstallationId: mainId,
          suiteRevision: 'opencode-profile-check-v1' }
      },
      assertCurrent: binding => currentRegistry.installations.assertCurrent(binding),
    })
  return { registry, profiles: admission(registry), launcher,
    selector: { instanceId: value.instanceId, instanceRevision: value.instanceRevision, target },
    async restart() {
      registry.stop()
      const restarted = await loadRegistry()
      return { registry: restarted, profiles: admission(restarted) }
    } }
}
