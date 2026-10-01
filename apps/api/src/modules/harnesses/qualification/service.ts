import { runAsQualificationCandidate } from './gate.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompatibilityHarness } from '@graphql/contracts'
import type { HarnessQualification } from '@graphql/contracts/harness-qualification'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { requireAuthorization } from '../../access/policy.js'
import type { PostgresCommandCoordinator } from '../../commands/postgres.js'
import { DomainError } from '../../errors.js'
import type { PostgresSettingsRepository } from '../../settings/postgres.js'
import { runCommand } from '../process.js'
import { QUALIFICATION_TARGET_PROFILE } from './profiles.js'
import { parseInstalledVersion } from '../compatibility/probe.js'
import { nativeCompatibilityProbe } from '../compatibility/probe.js'
import type { HarnessQualificationRepository } from './repository.js'
import type { HarnessQualificationRegistry } from './registry.js'
import type { QualificationSuite } from './types.js'

export class HarnessQualificationService {
  private readonly flights = new Map<CompatibilityHarness, Promise<void>>()
  constructor(private readonly repository: HarnessQualificationRepository, private readonly registry: HarnessQualificationRegistry,
    private readonly suites: Record<CompatibilityHarness, QualificationSuite>, private readonly binaries: Record<CompatibilityHarness, string>,
    private readonly commands: PostgresCommandCoordinator,
    private readonly settings: Pick<PostgresSettingsRepository, 'getManagedHarnessDefaults'>,
    private readonly staticCheck: (harness: CompatibilityHarness, binary: string, version: string, signal: AbortSignal, attempt?: number) => Promise<string> = checkStaticCompatibility,
    private readonly onFinished?: (harness: CompatibilityHarness) => void) {}

  async list(principal: ManagementPrincipal): Promise<{ qualifications: HarnessQualification[] }> {
    requireAuthorization(principal, 'harnesses:read')
    return { qualifications: await this.repository.list() }
  }

  async run(principal: ManagementPrincipal, source: 'http' | 'mcp', harness: CompatibilityHarness): Promise<{ qualification: HarnessQualification }> {
    requireAuthorization(principal, 'harnesses:update')
    try {
      const qualification = await this.begin(harness, true)
      await this.commands.recordAudit(principal.id, source, 'harness.qualification.run', harness, 'succeeded')
      return { qualification }
    } catch (error) {
      await this.commands.recordAudit(principal.id, source, 'harness.qualification.run', harness, 'failed')
      throw error
    }
  }

  async begin(harness: CompatibilityHarness, force = false): Promise<HarnessQualification> {
    const suite = this.suites[harness]
    const { binary, sha256 } = await this.registry.inspectBinary(this.binaries[harness])
    const output = await runCommand(binary, ['--version'], process.cwd(), AbortSignal.timeout(5000))
    if (output.exitCode !== 0) throw new DomainError('HARNESS_VERSION_UNAVAILABLE', 'The harness version could not be read.', 409)
    const version = parseInstalledVersion(harness, output.stdout, output.stderr)
    const previous = await this.repository.find(harness, version, sha256, suite.revision)
    if (!force && (previous?.status === 'qualified' || previous?.status === 'failed')) return previous
    if (!this.flights.has(harness)) {
      const task = this.execute(harness, suite, binary, sha256, version)
      this.flights.set(harness, task)
      void task.finally(() => { this.flights.delete(harness); this.onFinished?.(harness) }).catch(() => undefined)
    }
    return {
      harness, version, binarySha256: sha256, suiteRevision: suite.revision, profile: QUALIFICATION_TARGET_PROFILE[harness],
      status: 'qualifying', checks: [], failureReason: null, startedAt: new Date().toISOString(), checkedAt: null,
    }
  }

  private async execute(harness: CompatibilityHarness, suite: QualificationSuite, binary: string, sha256: string, version: string): Promise<void> {
    const startedAt = new Date().toISOString()
    const profile = QUALIFICATION_TARGET_PROFILE[harness]
    const base = { harness, version, binarySha256: sha256, suiteRevision: suite.revision, profile, startedAt }
    await this.repository.save({ ...base, status: 'qualifying', checks: [], failureReason: null, checkedAt: null })
    const checks: HarnessQualification['checks'] = []
    try {
      let schemaSha256: string
      let attempts = 1
      try {
        schemaSha256 = await this.staticCheck(harness, binary, version, AbortSignal.timeout(120_000), 1)
      } catch (error) {
        if (!(error instanceof Error && (error.name === 'TimeoutError' || ('code' in error && error.code === 'CHECK_TIMEOUT')))) throw error
        attempts = 2
        schemaSha256 = await this.staticCheck(harness, binary, version, AbortSignal.timeout(240_000), 2)
      }
      checks.push({ id: 'static-compatibility', passed: true, detail: `${schemaSha256} (${attempts} attempt${attempts === 1 ? '' : 's'})` })
    } catch (error) {
      checks.push({ id: 'static-compatibility', passed: false, detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) })
      await this.repository.save({ ...base, status: 'failed', checks, failureReason: 'The installed CLI failed static compatibility.', checkedAt: new Date().toISOString() })
      return
    }
    const signal = AbortSignal.timeout(240_000)
    const workDirectory = await mkdtemp(join(tmpdir(), `graphql-${harness}-qualification-`))
    try {
      const saved = await this.settings.getManagedHarnessDefaults()
      const model = saved.revision > 0 ? saved.defaults[harness].model : null
      const result = await runAsQualificationCandidate(harness, sha256,
        () => suite.run({ binary, version, binarySha256: sha256, profile, model, workDirectory, signal }))
      checks.push(...result.checks)
      const unchanged = (await this.registry.inspectBinary(binary)).sha256 === sha256
      const passed = unchanged && result.checks.length > 0 && result.checks.every((check) => check.passed)
      await this.repository.save({ ...base, status: passed ? 'qualified' : 'failed', checks,
        failureReason: passed ? null : 'The local qualification checks did not pass against the same binary.',
        checkedAt: new Date().toISOString() }, result.evidence)
      if (passed) await this.registry.trusted(harness, version, sha256)
    } catch {
      await this.repository.save({ ...base, status: 'failed', checks, failureReason: 'The local qualification suite did not pass.', checkedAt: new Date().toISOString() })
    } finally { await rm(workDirectory, { recursive: true, force: true }) }
  }
}

async function checkStaticCompatibility(harness: CompatibilityHarness, binary: string, version: string, signal: AbortSignal, attempt = 1): Promise<string> {
  const probe = nativeCompatibilityProbe({ codex: binary, opencode: binary }, process.cwd(), process.env, attempt === 1 ? 2000 : 10_000)
  try {
    const installation = await probe.inspect(harness, signal)
    if (installation.version !== version) throw new Error('The installed CLI version changed during qualification.')
    const schemaSha256 = await probe.probe(harness, installation, signal)
    await probe.assertUnchanged(installation, signal)
    return schemaSha256
  } finally { await probe.close?.() }
}
