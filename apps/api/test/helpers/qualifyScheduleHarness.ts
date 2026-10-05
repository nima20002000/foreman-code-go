import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { NativeHarnessFactories } from '../../src/modules/harnesses/runtimeFactory.js'
import { NativeProcessRegistry } from '../../src/modules/harnesses/recovery/processRegistry.js'
import { ProductionHostHarnessProfileQualifier } from '../../src/modules/harnesses/productionProfileQualifier.js'
import type { ProductionHarnessRegistry } from '../../src/modules/harnesses/productionRegistry.js'
import { HarnessInstanceSettingsRepository } from '../../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessInstanceProfileChecks } from '../../src/modules/harnesses/instanceSettings/profileChecks.js'
import type { HostHarnessOverrideAuthority } from '../../src/modules/harnesses/instanceSettings/service.js'
import { HarnessQualificationRepository } from '../../src/modules/harnesses/qualification/repository.js'
import { HarnessQualificationRegistry } from '../../src/modules/harnesses/qualification/registry.js'
import { HarnessQualificationService } from '../../src/modules/harnesses/qualification/service.js'
import { codexQualificationSuite } from '../../src/modules/harnesses/qualification/suites/codex.js'
import { opencodeQualificationSuite } from '../../src/modules/harnesses/qualification/suites/opencode.js'
import { withNativeQualificationOwnership } from '../../src/modules/harnesses/qualification/nativeOwnership.js'
import { withQualificationIdentity } from '../../src/modules/harnesses/qualification/identity.js'
import { runWithReadOnlyQualification } from '../../src/modules/harnesses/qualification/gate.js'
import { scopedCompatibilityProbe } from '../../src/modules/harnesses/compatibility/scopedProbe.js'
import { PostgresSettingsRepository } from '../../src/modules/settings/postgres.js'
import type { Sch11Fixture } from './sch11Fixture.js'

/** Native acceptance only: the same qualifiers, owner guards and persistence as production. */
export async function qualifyScheduleHarness(f: Sch11Fixture, principal: ManagementPrincipal,
  registry: ProductionHarnessRegistry, settings: HostHarnessOverride[], authority: HostHarnessOverrideAuthority) {
  const configuration = settings[0]?.configuration
  if (!configuration || configuration.harness !== 'codex') {
    throw new Error('The native schedule fixture requires its configured Codex model.')
  }
  const defaults = new PostgresSettingsRepository(f.database.pool)
  const savedDefaults = await defaults.getHarnessDefaults()
  await defaults.saveHarnessDefaults({ ...savedDefaults,
    codex: { ...savedDefaults.codex, model: configuration.model } })
  const processes = new NativeProcessRegistry(join(f.runtimeRoot, `qualification-${randomUUID()}`))
  const factories = new NativeHarnessFactories({
    codexBinary: registry.pinDefault('codex').installation.launcher.resolvedLauncher!, openCodeBinary: 'opencode',
    instances: registry.instances, installations: registry.installations,
    selectDefault: harness => registry.pinDefault(harness),
    auxiliaryRecovery: role => processes.scope(`${role}:${randomUUID()}`),
    admitRecovery: recovery => { Object.assign(recovery, processes.reserveLaunch(recovery.owner)) },
    abandonRecovery: async recovery => { await processes.abandonReservedLaunch(recovery) },
    closeRecovery: async recovery => {
      if (!await processes.closeOwner(recovery.owner)) throw new Error('Native qualification process closure is unconfirmed.')
    },
  })
  const assertInstallation = factories.assertInstallationUnchanged.bind(factories)
  const wrap = (suite: typeof codexQualificationSuite) => withQualificationIdentity(
    withNativeQualificationOwnership(suite, processes, () => {
      const binding = registry.pinDefault(suite.harness)
      return signal => assertInstallation(binding, signal)
    }), registry.installations, () => registry.pinDefault(suite.harness))
  const suites = { codex: wrap(codexQualificationSuite), opencode: wrap(opencodeQualificationSuite) }
  const repository = new HarnessQualificationRepository(f.database.pool)
  const qualifications = new HarnessQualificationRegistry(repository,
    { codex: suites.codex.revision, opencode: suites.opencode.revision })
  const service = new HarnessQualificationService(repository, qualifications, suites,
    { codex: registry.pinDefault('codex').installation.launcher.resolvedLauncher!, opencode: 'opencode' },
    f.commands, defaults, undefined, undefined,
    (_harness, _binary, timeoutMs) => scopedCompatibilityProbe({ registry: processes,
      pin: harness => registry.pinDefault(harness),
      assertInstallation,
      workingDirectory: f.runtimeRoot, timeoutMs }),
    (_harness, signal) => registry.refreshMain(signal))
  const checks = new HostHarnessInstanceProfileChecks(new HarnessInstanceSettingsRepository(f.database.pool),
    new HostHarnessProfileEvidenceRepository(f.database.pool), f.commands, authority,
    new ProductionHostHarnessProfileQualifier(registry, factories, () => {
      throw new Error('Main-local qualification does not request a worker.')
    }, f.runtimeRoot))
  const failures: unknown[] = []
  try {
    const submitted = (await service.run(principal, 'http', 'codex')).qualification
    await service.join()
    const result = await repository.find('codex', submitted.version, submitted.binarySha256!, submitted.suiteRevision)
    if (result?.status !== 'qualified') {
      const evidenceDirectory = process.env.ENG03_A_EVIDENCE_DIR
      if (evidenceDirectory && result) {
        await writeFile(join(evidenceDirectory, `schedule-qualification-${randomUUID()}.json`),
          JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
      }
      const failedChecks = result?.checks.filter(check => !check.passed).map(check => check.id).join(', ')
      throw new Error(`Native qualification did not pass (${failedChecks || 'no completed checks'}): ${result?.failureReason}`)
    }
    for (const value of settings) {
      const checked = await runWithReadOnlyQualification(qualifications, () => checks.check(principal, 'http', {
        commandId: randomUUID(), instanceId: value.instanceId, expectedRevision: value.revision, target: value.target,
      }))
      if (!checked.value.proof.qualified) throw new Error('The saved native profile did not qualify.')
    }
  } catch (error) {
    failures.push(error)
  } finally {
    factories.stopAuxiliaries()
    const closed = await Promise.allSettled([checks.close(), service.shutdown(), factories.disposeAuxiliaries()])
    for (const result of closed) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Native schedule qualification or cleanup failed.')
}
