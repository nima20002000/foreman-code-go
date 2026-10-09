import { runAsQualificationCandidate } from './gate.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { CompatibilityHarness } from '@foreman-code/contracts'
import type { HarnessQualification } from '@foreman-code/contracts/harness-qualification'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../../access/policy.js'
import type { PostgresCommandCoordinator } from '../../commands/postgres.js'
import { DomainError } from '../../errors.js'
import type { PostgresSettingsRepository } from '../../settings/postgres.js'
import { QUALIFICATION_TARGET_PROFILE } from './profiles.js'
import { nativeCompatibilityProbe, type CompatibilityProbe } from '../compatibility/probe.js'
import { qualificationError } from '../qualificationErrors.js'
import type { HarnessQualificationRepository } from './repository.js'
import type { HarnessQualificationRegistry } from './registry.js'
import type { QualificationSuite } from './types.js'

class QualificationCleanupError extends AggregateError {}

export class HarnessQualificationService {
  private readonly cancellation = new AbortController()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly blocked = new Set<CompatibilityHarness>()
  private readonly failures = new Set<unknown>()
  private readonly cleanups = new Set<() => Promise<void>>()
  private readonly probes = new Set<CompatibilityProbe>()
  private readonly directories = new Set<string>()
  private joining: Promise<void> | undefined
  private readonly flights = new Map<CompatibilityHarness, { identity: string; task: Promise<void> }>()
  constructor(private readonly repository: HarnessQualificationRepository, private readonly registry: HarnessQualificationRegistry,
    private readonly suites: Record<CompatibilityHarness, QualificationSuite>, private readonly binaries: Record<CompatibilityHarness, string>,
    private readonly commands: PostgresCommandCoordinator,
    private readonly settings: Pick<PostgresSettingsRepository, 'getManagedHarnessDefaults'>,
    private readonly staticCheck?: (harness: CompatibilityHarness, binary: string, version: string, signal: AbortSignal, attempt?: number) => Promise<string>,
    private readonly onFinished?: (harness: CompatibilityHarness) => void,
    private readonly probeFactory?: (harness: CompatibilityHarness, binary: string, timeoutMs: number) => CompatibilityProbe,
    private readonly refreshInstalled?: (harness: CompatibilityHarness, signal: AbortSignal) => Promise<void>,
    private readonly installationIdentity?: (harness: CompatibilityHarness) => string) {}

  async list(principal: ManagementPrincipal): Promise<{ qualifications: HarnessQualification[] }> {
    requireAuthorization(principal, 'harnesses:read')
    return { qualifications: await this.repository.list() }
  }

  async run(principal: ManagementPrincipal, source: 'http' | 'mcp', harness: CompatibilityHarness): Promise<{ qualification: HarnessQualification }> {
    requireAuthorization(principal, 'harnesses:update')
    this.assertRunning()
    return this.track(this.runAudited(principal, source, harness))
  }

  private async runAudited(principal: ManagementPrincipal, source: 'http' | 'mcp', harness: CompatibilityHarness): Promise<{ qualification: HarnessQualification }> {
    try {
      const qualification = await this.begin(harness, true)
      await this.commands.recordAudit(principal.id, source, 'harness.qualification.run', harness, 'succeeded')
      return { qualification }
    } catch (error) {
      await this.commands.recordAudit(principal.id, source, 'harness.qualification.run', harness, 'failed')
      throw error
    }
  }

  begin(harness: CompatibilityHarness, force = false): Promise<HarnessQualification> {
    try { this.assertRunning(harness) } catch (error) { return Promise.reject(error) }
    return this.track(this.prepare(harness, force).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'TimeoutError') throw qualificationError(error)
      throw error
    }))
  }

  /** Main's live evidence is fenced to its process, so a restart leaves Main-hosted Agents without admission.
   * Re-run the live suite in the background for a binary this Main had already qualified; a binary without a
   * qualified record still waits for an explicit run. Resolves with the restarted run, or null when none applies. */
  restore(harness: CompatibilityHarness): Promise<HarnessQualification | null> {
    try { this.assertRunning(harness) } catch (error) { return Promise.reject(error) }
    return this.track(this.prepare(harness, true, true).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'TimeoutError') throw qualificationError(error)
      throw error
    }))
  }

  async verify(harness: CompatibilityHarness, options?: { force: true }): Promise<HarnessQualification> {
    const state = await this.begin(harness, options?.force)
    await this.flights.get(harness)?.task
    if (!state.binarySha256 || !state.suiteRevision) return state
    return await this.repository.find(harness, state.version, state.binarySha256, state.suiteRevision) ?? state
  }

  /** Fence admission synchronously; subscriber disconnect never signals this controller. */
  stop(): void { this.cancellation.abort(new DOMException('Qualification is shutting down.', 'AbortError')) }

  join(): Promise<void> {
    this.joining ??= Promise.resolve().then(async () => {
      // Admitted preparation/audit tasks may enqueue a suite before they settle.
      while (this.tasks.size) await Promise.allSettled([...this.tasks])
      const cleanup = await Promise.allSettled([
        ...[...this.cleanups].map(async (close) => { await close(); this.cleanups.delete(close) }),
        ...[...this.probes].map(async (probe) => { await probe.close?.(); this.probes.delete(probe) }),
      ])
      if (!this.failures.size && !cleanup.some((result) => result.status === 'rejected')) {
        cleanup.push(...await Promise.allSettled([...this.directories].map((directory) => this.removeDirectory(directory))))
      }
      const errors = [...this.failures, ...cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])]
      if (errors.length) throw new AggregateError(errors, 'Qualification shutdown cleanup was incomplete.')
    })
    const attempt = this.joining
    void attempt.then(() => {
      if (!this.cancellation.signal.aborted && this.joining === attempt) this.joining = undefined
    }, () => { if (this.joining === attempt) this.joining = undefined })
    return attempt
  }

  shutdown(): Promise<void> { this.stop(); return this.join() }

  private assertRunning(harness?: CompatibilityHarness): void {
    this.cancellation.signal.throwIfAborted()
    if (harness && this.blocked.has(harness)) throw new DomainError('HARNESS_QUALIFICATION_CLEANUP_PENDING',
      'The previous qualification still has unconfirmed cleanup.', 409)
  }

  private async timed<T>(milliseconds: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new DOMException('Qualification timed out.', 'TimeoutError')), milliseconds)
    timer.unref()
    try { return await operation(AbortSignal.any([this.cancellation.signal, deadline.signal])) }
    finally { clearTimeout(timer) }
  }

  private track<T>(task: Promise<T>, retainFailure = false): Promise<T> {
    this.tasks.add(task)
    void task.then(() => { this.tasks.delete(task) }, (error: unknown) => {
      this.tasks.delete(task)
      if (retainFailure && !(error instanceof QualificationCleanupError) && !(error instanceof Error && error.name === 'AbortError')) this.failures.add(error)
    })
    return task
  }

  private checkStatic(harness: CompatibilityHarness, binary: string, version: string, signal: AbortSignal, attempt: number): Promise<string> {
    if (this.staticCheck) return this.staticCheck(harness, binary, version, signal, attempt)
    return checkStaticCompatibility(harness, binary, version, signal, attempt, this.probes, this.probeFactory)
  }

  private async removeDirectory(directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true })
    this.directories.delete(directory)
  }

  private async prepare(harness: CompatibilityHarness, force: boolean, onlyQualified: true): Promise<HarnessQualification | null>
  private async prepare(harness: CompatibilityHarness, force: boolean, onlyQualified?: false): Promise<HarnessQualification>
  private async prepare(harness: CompatibilityHarness, force: boolean, onlyQualified = false): Promise<HarnessQualification | null> {
    const suite = this.suites[harness]
    await this.refreshInstalled?.(harness, this.cancellation.signal)
    this.assertRunning(harness)
    const { binary, sha256 } = await this.registry.inspectBinary(this.binaries[harness])
    const installationIdentity = this.installationIdentity?.(harness)
    this.assertRunning()
    const probe = this.probeFactory?.(harness, binary, 30_000)
      ?? nativeCompatibilityProbe({ codex: binary }, process.cwd(), process.env, 30_000)
    this.probes.add(probe)
    let version: string
    // The probe bounds the CLI command; installation checks and closure have separate ownership.
    try { version = (await probe.inspect(harness, this.cancellation.signal)).version }
    finally { await closeQualificationProbe(probe, this.probes, () => { this.blocked.add(harness) }) }
    const identity = JSON.stringify([binary, sha256, version, suite.revision, installationIdentity])
    const previous = await this.repository.find(harness, version, sha256, suite.revision)
    this.assertRunning()
    this.assertRunning(harness)
    const flight = this.flights.get(harness)
    if (flight && flight.identity !== identity) {
      await flight.task
      this.assertRunning(harness)
      return onlyQualified ? this.prepare(harness, force, true) : this.prepare(harness, force)
    }
    if (onlyQualified && previous?.status !== 'qualified') return null
    if (!force && (previous?.status === 'qualified' || previous?.status === 'failed')) return previous
    if (!this.flights.has(harness)) {
      const task = this.track(Promise.resolve().then(() => this.execute(harness, suite, binary, sha256, version)), true)
      const entry = { identity, task }
      this.flights.set(harness, entry)
      void task.finally(() => {
        if (this.flights.get(harness) === entry) this.flights.delete(harness)
        this.onFinished?.(harness)
      }).catch(() => undefined)
    }
    return {
      harness, version, binarySha256: sha256, suiteRevision: suite.revision, profile: QUALIFICATION_TARGET_PROFILE[harness],
      status: 'qualifying', checks: [], failureReason: null, startedAt: new Date().toISOString(), checkedAt: null,
    }
  }

  private async execute(harness: CompatibilityHarness, suite: QualificationSuite, binary: string, sha256: string, version: string): Promise<void> {
    this.assertRunning()
    const startedAt = new Date().toISOString()
    const profile = QUALIFICATION_TARGET_PROFILE[harness]
    const base = { harness, version, binarySha256: sha256, suiteRevision: suite.revision, profile, startedAt }
    await this.repository.save({ ...base, status: 'qualifying', checks: [], failureReason: null, checkedAt: null })
    const checks: HarnessQualification['checks'] = []
    try {
      let schemaSha256: string
      let attempts = 1
      try {
        schemaSha256 = await this.timed(120_000, (signal) => this.checkStatic(harness, binary, version, signal, 1))
      } catch (error) {
        if (error instanceof AggregateError) throw error
        this.assertRunning()
        if (!(error instanceof Error && (error.name === 'TimeoutError' || ('code' in error && error.code === 'CHECK_TIMEOUT')))) throw error
        attempts = 2
        schemaSha256 = await this.timed(240_000, (signal) => this.checkStatic(harness, binary, version, signal, 2))
      }
      checks.push({ id: 'static-compatibility', passed: true, detail: `${schemaSha256} (${attempts} attempt${attempts === 1 ? '' : 's'})` })
    } catch (error) {
      if (error instanceof AggregateError) this.blocked.add(harness)
      checks.push({ id: 'static-compatibility', passed: false, detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) })
      await this.repository.save({ ...base, status: 'failed', checks, failureReason: `${harness} ${version}: ${checks.at(-1)?.detail ?? 'static protocol contract failed'}`, checkedAt: new Date().toISOString() })
      if (error instanceof AggregateError) throw error
      return
    }
    let workDirectory: string | undefined
    let uncertain = false
    const owned = new Set<() => Promise<void>>()
    const ownCleanup = (close: () => Promise<void>) => {
      this.cleanups.add(close); owned.add(close)
      return () => { this.cleanups.delete(close); owned.delete(close) }
    }
    try {
      this.assertRunning()
      const directory = await mkdtemp(join(tmpdir(), `graphql-${harness}-qualification-`))
      workDirectory = directory
      this.directories.add(workDirectory)
      this.assertRunning()
      const saved = structuredClone(await this.settings.getManagedHarnessDefaults())
      this.assertRunning()
      const model = saved.revision > 0 && !saved.unavailable?.includes(harness) ? saved.defaults[harness].model : null
      const result = await this.timed(240_000, (signal) => runAsQualificationCandidate(harness, sha256, binary,
        () => suite.run({ binary, version, binarySha256: sha256, profile, model, ...(harness === 'codex' ? { reasoningEffort: saved.defaults.codex.reasoningEffort } : {}), workDirectory: directory, signal, ownCleanup })))
      if (owned.size) throw new QualificationCleanupError([], 'Qualification resources are still owned.')
      this.assertRunning()
      checks.push(...result.checks)
      const unchanged = (await this.registry.inspectBinary(binary)).sha256 === sha256
      const sameConfiguration = async () => {
        const current = await this.settings.getManagedHarnessDefaults()
        return current.revision === saved.revision && isDeepStrictEqual(current.defaults[harness], saved.defaults[harness])
      }
      const configurationUnchanged = await sameConfiguration()
      this.assertRunning()
      const passed = unchanged && configurationUnchanged && result.checks.length > 0 && result.checks.every((check) => check.passed)
      await this.repository.save({ ...base, status: passed ? 'qualified' : 'failed', checks,
        failureReason: passed ? null : !configurationUnchanged ? 'The harness configuration changed during qualification.'
          : 'The local qualification checks did not pass against the same binary.',
        checkedAt: new Date().toISOString() }, { ...result.evidence, settingsRevision: saved.revision, model })
      if (passed) {
        if (!await sameConfiguration()) {
          await this.repository.save({ ...base, status: 'failed', checks,
            failureReason: 'The harness configuration changed during qualification.', checkedAt: new Date().toISOString() })
          return
        }
        this.assertRunning()
        await this.registry.trusted(harness, version, sha256)
      }
    } catch (error) {
      uncertain = owned.size > 0 || error instanceof AggregateError
      if (uncertain) this.blocked.add(harness)
      await this.repository.save({ ...base, status: 'failed', checks, failureReason: `${harness} ${version}: ${error instanceof Error ? error.message.slice(0, 400) : 'native lifecycle contract failed'}`, checkedAt: new Date().toISOString() })
      if (owned.size) throw new QualificationCleanupError([error], 'Qualification cleanup is unconfirmed.')
      if (error instanceof AggregateError) throw error
    } finally {
      // A failed removal remains owned and is retried by join().
      if (workDirectory && !uncertain && !owned.size) await this.removeDirectory(workDirectory).catch(() => undefined)
    }
  }
}

async function checkStaticCompatibility(harness: CompatibilityHarness, binary: string, version: string, signal: AbortSignal, attempt: number, probes: Set<CompatibilityProbe>,
  probeFactory?: (harness: CompatibilityHarness, binary: string, timeoutMs: number) => CompatibilityProbe): Promise<string> {
  const timeout = attempt === 1 ? 30_000 : 60_000
  const probe = probeFactory?.(harness, binary, timeout)
    ?? nativeCompatibilityProbe({ codex: binary }, process.cwd(), process.env, timeout)
  probes.add(probe)
  try {
    const installation = await probe.inspect(harness, signal)
    if (installation.version !== version) throw new Error('The installed CLI version changed during qualification.')
    const schemaSha256 = await probe.probe(harness, installation, signal)
    await probe.assertUnchanged(installation, signal)
    return schemaSha256
  } finally { await closeQualificationProbe(probe, probes) }
}

async function closeQualificationProbe(probe: CompatibilityProbe, probes: Set<CompatibilityProbe>, onFailure?: () => void): Promise<void> {
  try { await probe.close?.(); probes.delete(probe) }
  catch (error) { onFailure?.(); throw new QualificationCleanupError([error], 'Static qualification cleanup is unconfirmed.') }
}
