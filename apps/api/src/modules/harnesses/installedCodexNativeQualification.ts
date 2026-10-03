import { mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { withAdvancedDefaults, type HarnessQualification as ConfigurationQualification } from '@graphql/contracts'
import { commandInputHash } from '@graphql/contracts/command-identity-node'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@graphql/contracts/device-connection'
import { CompletedNativeQualificationSchema, HostHarnessProfileEvidenceSchema, HostHarnessOverrideSchema,
  type HostHarnessOverride, type HostHarnessProfileEvidence } from '@graphql/contracts/harness-registry'
import { HarnessQualificationSchema, type HarnessQualification } from '@graphql/contracts/harness-qualification'
import { HarnessExecutionError } from './errors.js'
import { DomainError } from '../errors.js'
import { harnessConnectionGeneration } from './hostConnectionGeneration.js'
import type { InstalledCodexInspection, CurrentInstalledCodexTarget } from './installedCodexInspection.js'
import { nativeCompatibilityProbe, type CompatibilityProbe, type CompatibilityProbeOwnership } from './compatibility/probe.js'
import { runAsQualificationCandidate } from './qualification/gate.js'
import { withNativeQualificationOwnership, type NativeQualificationSuiteInput } from './qualification/nativeOwnership.js'
import { codexQualificationSuite } from './qualification/suites/codex.js'
import { qualificationRevisionWithIdentity } from './qualification/identity.js'
import { QUALIFICATION_TARGET_PROFILE, normalizeHarnessVersion } from './qualification/profiles.js'
import type { QualificationSuite } from './qualification/types.js'
import type { NativeProcessRecovery, NativeProcessRegistry } from './recovery/processRegistry.js'

export const CODEX_COMPLETED_QUALIFICATION_CHECKS = Object.freeze(['static-compatibility', 'binary-sha256', 'version', 'schema',
  'thread-start', 'text-turn', 'file-tools', 'thread-resume', 'selected-profile', 'owned-resource-closure'])
const denied = (): never => { throw new DomainError('HARNESS_QUALIFICATION_TARGET_CHANGED', 'Explicit qualification requires the exact current installed host and selected profile.', 409) }
const same = (a: unknown, b: unknown) => commandInputHash(a) === commandInputHash(b)

/** This is only the existing authenticated profile-check handler's native
 * qualifier. It never allocates a workflow manager or accepts incoming proof. */
export function createInstalledCodexNativeQualifier(input: {
  binding: Readonly<DeviceSessionBinding>
  trustedCurrentBinding(): Readonly<DeviceSessionBinding> | null
  inspect(binding: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<InstalledCodexInspection>
  registry: Pick<NativeProcessRegistry, 'reserveLaunch' | 'abandonReservedLaunch' | 'closeOwner'>
  workingRoot: string
  environment: NodeJS.ProcessEnv
  /** C supplies the actual role=qualification/appMcpAccess=none manager and closes it positively. */
  checkConfiguration(value: HostHarnessOverride, directory: string, signal: AbortSignal,
    recovery: NativeProcessRecovery, assertInstallation: (signal?: AbortSignal) => Promise<void>): Promise<ConfigurationQualification>
  suite?: QualificationSuite
  probe?: (target: CurrentInstalledCodexTarget, ownership: CompatibilityProbeOwnership) => CompatibilityProbe
}) {
  const binding = DeviceSessionBindingSchema.parse(input.binding)
  const suite = input.suite ?? codexQualificationSuite
  // The adapter performs the same actual installation guards as identity-v1.
  const suiteRevision = qualificationRevisionWithIdentity(suite.revision)
  if (!isAbsolute(input.workingRoot) || suite.harness !== 'codex') denied()
  const stopping = new AbortController(), flights = new Set<Promise<HostHarnessProfileEvidence>>()
  const cleanups = new Set<() => Promise<void>>(), directories = new Set<string>()
  const current = async (signal: AbortSignal, expected?: CurrentInstalledCodexTarget) => {
    signal.throwIfAborted()
    const live = input.trustedCurrentBinding()
    if (!live || !same(live, binding)) return denied()
    const target = (await input.inspect(binding, signal)).currentTarget
    signal.throwIfAborted()
    const after = input.trustedCurrentBinding()
    if (!after || !same(after, binding) || !target || !same(target.binding, binding)) return denied()
    if (expected && (!same(target.target, expected.target) || target.binarySha256 !== expected.binarySha256
      || target.expectedVersion !== expected.expectedVersion || target.installation.environmentGeneration !== expected.installation.environmentGeneration
      || target.installation.connectionGeneration !== expected.installation.connectionGeneration
      || !same(target.installation.launcher.payloadFingerprints, expected.installation.launcher.payloadFingerprints))) return denied()
    return target
  }
  const perform = async (raw: HostHarnessOverride, checkId: string, callerSignal: AbortSignal): Promise<HostHarnessProfileEvidence> => {
    const owned = new Set<() => Promise<void>>(), localDirectories = new Set<string>()
    const ownCleanup = (close: () => Promise<void>) => { cleanups.add(close); owned.add(close); return () => { cleanups.delete(close); owned.delete(close) } }
    const value = HostHarnessOverrideSchema.parse(raw)
    const signal = AbortSignal.any([callerSignal, stopping.signal])
    const target = await current(signal)
    if (value.driverId !== 'codex' || value.configuration.harness !== 'codex' || !value.enabled || !same(value.target, target.target)
      || value.configurationFingerprint !== commandInputHash(withAdvancedDefaults(value.configuration))) denied()
    // Validate the explicit Main check identity before any native acquisition.
    CompletedNativeQualificationSchema.shape.checkId.parse(checkId)
    const assertInstallation = async (guardSignal = signal) => { await current(guardSignal, target) }
    const startedAt = new Date().toISOString(), checks: HarnessQualification['checks'] = []
    let version: string | undefined, profileResult: ConfigurationQualification | undefined
    let failureReason: string | null = null
    const diagnostic = input.registry.reserveLaunch(`qualification:codex:${checkId}:static`)
    let probe: CompatibilityProbe | undefined
    const closeProbe = async () => {
      await probe?.close?.()
      await input.registry.abandonReservedLaunch(diagnostic)
      if (!await input.registry.closeOwner(diagnostic.owner)) throw new Error('Native qualification diagnostic closure is unconfirmed.')
    }
    const releaseProbe = ownCleanup(closeProbe)
    try {
      probe = input.probe?.(target, { recovery: diagnostic, beforeCommand: async (_binary, commandSignal) => { await assertInstallation(commandSignal) } })
      ?? nativeCompatibilityProbe({ codex: target.installation.launcher.resolvedLauncher!, opencode: target.installation.launcher.resolvedLauncher! },
        input.workingRoot, input.environment, 5000, { recovery: diagnostic, beforeCommand: async (_binary, commandSignal) => { await assertInstallation(commandSignal) } })
      try {
        const installed = await probe.inspect('codex', signal)
        version = normalizeHarnessVersion('codex', installed.version)
        if (installed.executable !== target.installation.launcher.resolvedLauncher || version !== target.expectedVersion) denied()
        const schemaHash = await probe.probe('codex', installed, signal)
        await probe.assertUnchanged(installed, signal)
        await assertInstallation(signal)
        checks.push({ id: 'static-compatibility', passed: true, detail: schemaHash })
      } catch (error) {
        signal.throwIfAborted()
        if (!version || error instanceof DomainError || error instanceof AggregateError) throw error
        checks.push({ id: 'static-compatibility', passed: false, detail: null })
        failureReason = 'The exact installed CLI failed static compatibility.'
      } finally {
        await closeProbe().catch(error => { throw new AggregateError([error], 'Native qualification diagnostic cleanup is unconfirmed.') })
        releaseProbe()
      }
      if (!failureReason) {
        const directory = await mkdtemp(join(input.workingRoot, 'codex-qualification-'))
        directories.add(directory); localDirectories.add(directory)
        const selectedSuite: QualificationSuite = { harness: 'codex', revision: suite.revision,
          async run(scope: NativeQualificationSuiteInput) {
            const result = await suite.run(scope)
            if (result.checks.length && result.checks.every(check => check.passed)) {
              if (!scope.processRecovery || !scope.assertInstallation) return denied()
              await scope.assertInstallation(signal)
              try { profileResult = await input.checkConfiguration(value, directory, signal, scope.processRecovery, scope.assertInstallation) }
              catch (error) {
                signal.throwIfAborted()
                const code = error instanceof DomainError ? error.code
                  : error instanceof HarnessExecutionError && error.result.outcome === 'failed' ? error.result.error?.code : undefined
                if (!code || !/^CODEX_(?:SETTING|MODEL|MCP|REQUIRED_MCP|APP_SERVER_AUTH)/.test(code)) throw error
                failureReason = 'The selected host profile did not pass its native configuration checks.'
              }
              await scope.assertInstallation(signal)
              const selected = Boolean(profileResult && profileResult.harness === 'codex' && normalizeHarnessVersion('codex', profileResult.version) === version
                && profileResult.ready && profileResult.authenticated && profileResult.structuredEvents)
              result.checks.push({ id: 'selected-profile', passed: selected, detail: null })
            }
            return result
          } }
        const ownedSuite = withNativeQualificationOwnership(selectedSuite, input.registry, () => assertInstallation)
        // Candidate authority exists only while this actual owned suite runs.
        const result = await runAsQualificationCandidate('codex', target.binarySha256, () => ownedSuite.run({
          binary: target.installation.launcher.resolvedLauncher!, version: version!, binarySha256: target.binarySha256,
          profile: QUALIFICATION_TARGET_PROFILE.codex, model: value.configuration.model, workDirectory: directory, signal, ownCleanup,
        }))
        checks.push(...result.checks)
        await assertInstallation(signal)
        if (owned.size) throw new AggregateError([], 'Native qualification resources retain ownership.')
      }
      await assertInstallation(signal)
      checks.push({ id: 'owned-resource-closure', passed: true, detail: null })
      const passed = CODEX_COMPLETED_QUALIFICATION_CHECKS.every(id => checks.some(check => check.id === id && check.passed))
        && checks.every(check => check.passed)
      const checkedAt = new Date().toISOString()
      const record = HarnessQualificationSchema.parse({ harness: 'codex', version, binarySha256: target.binarySha256,
        suiteRevision, profile: QUALIFICATION_TARGET_PROFILE.codex, status: passed ? 'qualified' : 'failed', checks,
        failureReason: passed ? null : failureReason ?? 'The actual native suite or selected profile did not pass.', startedAt, checkedAt })
      return HostHarnessProfileEvidenceSchema.parse({ target: value.target, instanceRevision: value.instanceRevision,
        configurationFingerprint: value.configurationFingerprint, driverId: 'codex', driverRevision: target.installation.driverRevision,
        protocolRevision: target.installation.protocolRevision, suiteRevision: 'codex-profile-check-v1',
        environmentGeneration: target.installation.environmentGeneration, connectionGeneration: harnessConnectionGeneration(binding),
        authenticated: profileResult?.authenticated ?? null, compatible: checks.some(check => check.id === 'static-compatibility' && !check.passed) ? false : profileResult?.structuredEvents ?? null,
        qualified: passed, checkedAt, ...(passed ? {} : { failure: { code: 'HARNESS_UNQUALIFIED', message: record.failureReason! } }), completedNativeQualification: { purpose: 'explicit-host-qualification', checkId,
          binding, target: value.target, binarySha256: target.binarySha256, record } })
    } finally {
      if (!owned.size) for (const directory of localDirectories) { await rm(directory, { recursive: true, force: true }); directories.delete(directory) }
    }
  }
  return {
    qualify(value: HostHarnessOverride, request: { checkId: string; signal: AbortSignal }) {
      if (stopping.signal.aborted || cleanups.size && !flights.size) return Promise.reject(new DomainError('HARNESS_QUALIFICATION_CLEANUP_PENDING', 'Native qualification cleanup must finish before another check.', 409))
      const task = perform(value, request.checkId, request.signal)
      flights.add(task); void task.finally(() => flights.delete(task)).catch(() => undefined)
      return task
    },
    async close() {
      stopping.abort(new Error('Native qualification is stopping.'))
      await Promise.allSettled([...flights])
      const result = await Promise.allSettled([...cleanups].map(async close => { await close(); cleanups.delete(close) }))
      const errors = result.flatMap(row => row.status === 'rejected' ? [row.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Native qualification cleanup remains unconfirmed.')
      for (const directory of directories) { await rm(directory, { recursive: true, force: true }); directories.delete(directory) }
    },
  }
}
