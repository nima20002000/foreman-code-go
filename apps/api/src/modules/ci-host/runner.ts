import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { sanitizeCiText, serializeCiJson } from './text.js'
import { availableParallelism, freemem, homedir, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, matchesGlob } from 'node:path'
import { CiWatchdogFailureSchema, CiDurationsSchema, CiHostReplySchema, CiHostRequestSchema, CiTestResultsSchema, integrationPartition,
  CiScopeSchema, CiSelectedFilesSchema, validCiSelection,
  CI_HOST_START_PROTOCOL_VERSION,
  type CiDurations, type CiHostReply, type CiHostRun, type CiSuite, type CiPart, type CiPartition, type CiScope } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { ciRepositoryCapabilities } from './repository.js'
import { allowedCiResources, gateIntegrationShards, hostCiCapacity } from './capacity.js'
import { fallbackOnError } from '../diagnostics/ignoredError.js'
import { pnpmInstall } from './warmSetup.js'
import { ciLogPage } from './logPage.js'
import { readCiReport } from './reports.js'
import { withHostCiRunLock } from './runnerLock.js'

type Command = { code: number; stdout: string; stderr: string }
export interface HostCiPorts {
  run(file: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<Command>
  now(): Date
  cpus: number
  memoryBytes: number
  availableMemoryBytes?(): number
}

/** The CircleCI CLI otherwise spawns a telemetry process for every call, and CI polling calls it constantly. */
function withoutCliTelemetry(file: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return file === 'circleci' ? { ...environment, CIRCLECI_CLI_TELEMETRY_OPTOUT: '1' } : environment
}

export function systemHostCiPorts(environment: NodeJS.ProcessEnv = process.env): HostCiPorts {
  return {
    run: (file, args, options = {}) => new Promise(resolve => {
      execFile(file, [...args], { cwd: options.cwd, env: withoutCliTelemetry(file, options.env ?? environment), timeout: options.timeoutMs ?? 600_000,
        maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
        resolve({ code, stdout, stderr })
      })
    }),
    now: () => new Date(),
    cpus: availableParallelism(),
    memoryBytes: totalmem(),
    availableMemoryBytes: () => {
      if (process.platform !== 'linux') return freemem()
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1]
      return available === undefined ? freemem() : Number(available) * 1024
    },
  }
}

interface RunMeta {
  runId: string; repository: string; commit: string; suite: CiSuite; partition: CiPartition | null
  startedAt: string; state: CiHostRun['state']; finishedAt: string | null; exitCode: number | null
  message: string | null; cleaned: boolean; durations?: CiDurations
  scope?: CiScope; files?: string[]; part?: CiPart; defaultBranch?: string; baseCommit?: string; deriveFiles?: boolean
  resources?: { cpuCount: number; memoryBytes: number; memoryBudget?: number }
  /** The persistent checkout this run holds; absent when it uses a fresh checkout in its run directory. */
  slot?: number
  expectedDurationMs?: number
  isolatedDatabase?: boolean
  gate?: boolean; integrationShards?: number
  serviceUnit?: string
  cancellationRequested?: boolean
  testResultsExpected?: boolean
  notice?: string
}

type StartRequest = { runId: string; repository: string; commit: string; suite: CiSuite
  part?: CiPart | undefined; partition?: CiPartition | undefined; durations?: CiDurations | undefined;
  scope?: CiScope | undefined; files?: string[] | undefined; defaultBranch?: string | undefined;
  expectedDurationMs?: number | undefined; baseCommit?: string | undefined; gate?: boolean | undefined;
  integrationShards?: number | undefined; buildAllowancePercent?: number | undefined; notice?: string | undefined }

const unitName = (runId: string) => `foreman-ci-${runId}`
// GitHub CLI's own credential helper: a computer that is logged in to gh fetches without any app setup.
const gitAuth = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']

export function hostCiDirectory() {
  return join(homedir(), '.local/share/foreman-code/ci-host')
}

/** Runs CI suites directly on this computer, like a self-hosted runner. Each run is a transient
 * systemd user service, so it outlives a Worker restart, and its CPU and memory stay below the host reserve. */
export class HostCiRunner {
  private readonly preparing = new Map<string, Promise<void>>()
  private startQueue = Promise.resolve()
  private startingRun: CiHostRun | null = null
  private readonly repositoryQueues = new Map<string, Promise<void>>()
  private githubChecked: { at: number; ready: boolean; reason: string | null } | undefined
  private draining = false

  constructor(private readonly root = hostCiDirectory(),
    private readonly ports: HostCiPorts = systemHostCiPorts(),
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly startupSmokePending: () => boolean | Promise<boolean> = () => false) {}

  async handle(raw: unknown): Promise<CiHostReply> {
    const request = CiHostRequestSchema.parse(raw)
    if (request.operation === 'status') return this.status()
    if (request.operation === 'start') return CiHostReplySchema.parse({ operation: 'start', run: await this.start(request) })
    if (request.operation === 'cancel') return CiHostReplySchema.parse({ operation: 'cancel', run: await this.cancel(request.runId) })
    const run = await this.refresh(request.runId)
    const path = join(this.runDirectory(request.runId), 'log')
    let text = '', nextOffset = request.afterOffset
    if (existsSync(path)) {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(request.maxBytes)
        const { bytesRead } = await handle.read(buffer, 0, request.maxBytes, request.afterOffset)
        const page = ciLogPage(buffer.subarray(0, bytesRead), 0, request.maxBytes)
        text = sanitizeCiText(page.text)
        nextOffset = request.afterOffset + page.nextOffset
      } finally { await handle.close() }
    }
    // A finished test run reports the file durations and test results it measured, so Main can learn and show them.
    const finished = !['starting', 'running'].includes(run.state)
    const reportPath = (name: string) => join(this.runDirectory(request.runId), name)
    const measured = request.durations && finished
      ? await readCiReport(reportPath('measured-durations.json'), CiDurationsSchema) : null
    const tests = request.testResults && finished
      ? await readCiReport(reportPath('test-results.json'), CiTestResultsSchema) : null
    if (tests) {
      const meta = await this.readMeta(request.runId).catch(error => {
        if (error instanceof DomainError && error.code === 'CI_RUN_UNKNOWN' && run.state === 'canceled') return null
        throw error
      })
      const expected = meta?.testResultsExpected && (run.state === 'passed' || run.step === (meta.part ?? meta.suite))
      let collection: CiHostRun['collection'] = tests.state === 'complete' ? 'complete' : 'unsupported'
      if (tests.state === 'pending' || tests.state === 'absent' && expected || measured?.state === 'pending') {
        collection = 'pending'
      }
      run.collection = collection
    }
    return CiHostReplySchema.parse({ operation: 'read', run, text, nextOffset,
      ...(measured?.state === 'complete' ? { durations: measured.data } : {}),
      ...(tests?.state === 'complete' ? { testResults: tests.data } : {}) })
  }

  async beginDrain(): Promise<void> {
    this.draining = true
    await this.startQueue
    await Promise.all(this.preparing.values())
  }

  resumeAdmissions() { this.draining = false }

  isUpdateIdle() { return this.preparing.size === 0 && this.startingRun === null }

  private runDirectory(runId: string) { return join(this.root, 'runs', runId) }

  /** A persistent checkout keeps its installed dependencies between the parts that hold its slot in turn. */
  private slotSource(repository: string, slot: number) {
    return join(this.root, 'slots', ...repository.split('/'), String(slot), 'src')
  }

  private async readMeta(runId: string): Promise<RunMeta> {
    try {
      const meta = JSON.parse(await readFile(join(this.runDirectory(runId), 'meta.json'), 'utf8')) as RunMeta
      // Cancellation survives concurrent launch metadata writes and Worker restarts.
      return { ...meta, cancellationRequested: existsSync(join(this.runDirectory(runId), 'cancel-requested')) }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DomainError('CI_RUN_UNKNOWN', 'This computer has no such CI run.', 404)
      }
      throw error
    }
  }

  private async writeMeta(meta: RunMeta) {
    const path = join(this.runDirectory(meta.runId), 'meta.json')
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      // Busy checks must see a complete record while launch updates the run state.
      await writeFile(temporary, serializeCiJson(meta), { mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private async github(): Promise<{ ready: boolean; reason: string | null }> {
    if (this.githubChecked && Date.now() - this.githubChecked.at < 60_000) return this.githubChecked
    const result = await this.ports.run('gh', ['auth', 'status', '--hostname', 'github.com'], { env: this.environment, timeoutMs: 15_000 })
      .catch(() => ({ code: 127, stdout: '', stderr: '' }))
    const ready = result.code === 0
    this.githubChecked = { at: Date.now(), ready,
      reason: ready ? null : 'Log in to GitHub on this computer (gh auth login, or computer_github_login_start).' }
    return this.githubChecked
  }

  async status(): Promise<CiHostReply> {
    const startingRun = this.startingRun
    const github = await this.github()
    const reasons = github.reason ? [github.reason] : []
    if (await this.startupSmokePending()) reasons.push('Worker update CI smoke is pending; this computer is reserved for validation.')
    if (this.draining) reasons.push('Worker runtime update is draining CI preparation.')
    for (const tool of ['git', 'corepack']) {
      if ((await this.ports.run(tool, ['--version'], { env: this.environment, timeoutMs: 15_000 })).code !== 0) {
        reasons.push(`${tool} is not installed for the Worker.`)
      }
    }
    const runs = []
    const directory = join(this.root, 'runs')
    const names = existsSync(directory) ? (await readdir(directory)).sort() : []
    for (const runId of names) runs.push(await this.refresh(runId).catch(fallbackOnError(
      null, 'jobs', 'refresh CI run', { runId }, ['ENOENT'],
    )))
    const active: RunMeta[] = []
    for (const run of runs) {
      if (run && ['starting', 'running'].includes(run.state)) active.push(await this.readMeta(run.runId))
    }
    // Repository preparation precedes metadata; status must still acknowledge the accepted start.
    const pendingStart = startingRun && !runs.some(run => run?.runId === startingRun.runId)
    if (pendingStart) runs.push(startingRun)
    const availableMemoryBytes = this.ports.availableMemoryBytes?.() ?? this.ports.memoryBytes
    const capacity = this.capacity(active, { availableMemoryBytes })
    const activeRuns = runs.filter(run => run && ['starting', 'running'].includes(run.state))
    const finishedRuns = runs.filter(run => run && !['starting', 'running'].includes(run.state))
    return CiHostReplySchema.parse({ operation: 'status', ready: !reasons.length, reasons,
      startProtocolVersion: CI_HOST_START_PROTOCOL_VERSION,
      cpuCount: this.ports.cpus, memoryBytes: this.ports.memoryBytes, availableMemoryBytes,
      slotsUsed: capacity.slotsUsed + Number(Boolean(pendingStart)), slotsTotal: capacity.slotsTotal,
      runs: [...activeRuns, ...finishedRuns.slice(-Math.max(0, 50 - activeRuns.length))].slice(0, 50) })
  }

  private capacity(active: RunMeta[], options: { availableMemoryBytes?: number; buildAllowancePercent?: number } = {}) {
    const resources = allowedCiResources({ cpuCount: this.ports.cpus, memoryBytes: this.ports.memoryBytes,
      availableMemoryBytes: options.availableMemoryBytes ?? this.ports.availableMemoryBytes?.() ?? this.ports.memoryBytes },
      options.buildAllowancePercent)
    return hostCiCapacity(resources,
      active.map(run => run.resources ?? { cpuCount: this.ports.cpus, memoryBytes: this.ports.memoryBytes }))
  }

  private async active(): Promise<RunMeta[]> {
    const directory = join(this.root, 'runs')
    if (!existsSync(directory)) return []
    const active = []
    for (const runId of await readdir(directory)) {
      const run = await this.refresh(runId).catch(fallbackOnError(null, 'jobs', 'refresh CI run', { runId }, ['ENOENT']))
      if (run && ['starting', 'running'].includes(run.state)) active.push(await this.readMeta(runId))
    }
    return active
  }

  private async start(request: StartRequest) {
    if (await this.startupSmokePending()) throw new DomainError('CI_HOST_BUSY',
      'Worker update CI smoke is pending; this computer is reserved for validation.', 409)
    if (this.draining) throw new DomainError('WORKER_RUNTIME_DRAINING',
      'This computer is waiting for CI preparation to finish before updating its runtime.', 409)
    // Keep the busy check and initial persistence together, including same-run retries.
    const previous = this.startQueue
    let release!: () => void
    this.startQueue = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await this.startRun(request)
    } finally {
      this.startingRun = null
      release()
    }
  }

  private async startRun(request: StartRequest) {
    const directory = this.runDirectory(request.runId)
    if (existsSync(join(directory, 'meta.json'))) return this.refresh(request.runId)
    if (existsSync(join(directory, 'cancel-requested'))) return this.canceledBeforeStart(request.runId)
    this.startingRun = { runId: request.runId, state: 'starting', step: 'dispatch',
      startedAt: this.ports.now().toISOString(), finishedAt: null, exitCode: null, logBytes: 0, message: null }
    let active = await this.active()
    if (active.some(run => run.gate) || request.gate && active.length) {
      throw new DomainError('CI_HOST_BUSY', 'A gate requires exclusive use of this build computer.', 409)
    }
    const allowance = { buildAllowancePercent: request.buildAllowancePercent ?? 100 }
    let capacity = this.capacity(active, allowance)
    if (capacity.slotsUsed >= capacity.slotsTotal) {
      throw new DomainError('CI_HOST_BUSY',
        `All CI slots are in use (${capacity.slotsUsed}/${capacity.slotsTotal}); waiting for CPU or memory capacity.`, 409)
    }
    const github = await this.github()
    if (!github.ready) throw new DomainError('COMPUTER_GITHUB_REQUIRED', github.reason!, 409)
    const startedAt = this.ports.now().toISOString()
    // Concurrent parts never share a checkout: take the lowest slot no active run of this repository holds.
    const held = new Set(active.filter(run => run.repository === request.repository).map(run => run.slot))
    let slot = 0
    while (held.has(slot)) slot++
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const meta: RunMeta = { runId: request.runId, repository: request.repository, commit: request.commit,
      suite: request.suite, partition: request.partition ?? null, startedAt, slot,
      state: 'starting', finishedAt: null, exitCode: null, message: null, cleaned: false,
      resources: { cpuCount: capacity.cpuCount, memoryBytes: capacity.memoryBytes, memoryBudget: capacity.memoryBudget },
      ...(request.expectedDurationMs !== undefined ? { expectedDurationMs: request.expectedDurationMs } : {}),
      ...(request.gate ? { gate: true, integrationShards: Math.min(request.integrationShards!,
        gateIntegrationShards(capacity.cpuCount, capacity.memoryBytes)) } : {}),
      ...(request.part ? { part: request.part } : {}),
      scope: request.scope ?? 'affected', ...(request.files !== undefined ? { files: request.files } : {}),
      deriveFiles: (request.scope ?? 'affected') === 'affected' && request.files === undefined,
      ...(request.defaultBranch ? { defaultBranch: request.defaultBranch } : {}),
      ...(request.baseCommit ? { baseCommit: request.baseCommit } : {}),
      ...(request.notice ? { notice: request.notice } : {}),
      ...(request.durations ? { durations: request.durations } : {}) }
    await this.writeMeta(meta)
    const ready = await withHostCiRunLock(directory, async () => {
      try {
        if (!await this.cancelPreparation(meta.runId)) await this.prepareRepository(request)
        if (await this.cancelPreparation(meta.runId)) return false
        const databaseSuite = ['unit', 'integration'].includes(request.suite)
        const isolatedDatabase = databaseSuite && await this.supportsDatabaseIsolation(request)
        active = (await this.active()).filter(run => run.runId !== request.runId)
        capacity = this.capacity(active, allowance)
        const resources = allowedCiResources({ cpuCount: this.ports.cpus, memoryBytes: this.ports.memoryBytes,
          availableMemoryBytes: this.ports.availableMemoryBytes?.() ?? this.ports.memoryBytes }, allowance.buildAllowancePercent)
        if (request.gate || databaseSuite && !isolatedDatabase) {
          capacity = { ...capacity, slotsUsed: active.length, slotsTotal: 1, cpuCount: resources.cpuCount,
            memoryBytes: Math.max(1, Math.min(capacity.memoryBudget, resources.availableMemoryBytes)) }
        }
        if (capacity.slotsUsed >= capacity.slotsTotal) {
          throw new DomainError('CI_HOST_BUSY',
            `All CI slots are in use (${capacity.slotsUsed}/${capacity.slotsTotal}); this commit needs exclusive database capacity.`, 409)
        }
        meta.resources = { cpuCount: capacity.cpuCount, memoryBytes: capacity.memoryBytes, memoryBudget: capacity.memoryBudget }
        meta.isolatedDatabase = isolatedDatabase
        if (request.gate) {
          meta.integrationShards = Math.min(request.integrationShards!,
            gateIntegrationShards(capacity.cpuCount, capacity.memoryBytes))
        }
        if (await this.cancelPreparation(meta.runId)) return false
        await this.writeMeta(meta)
        return true
      } catch (error) {
        const current = await this.readMeta(meta.runId)
        await this.finish(meta.runId, current.cancellationRequested ? 'canceled' : 'failed', null,
          error instanceof Error ? error.message : String(error))
        if (current.cancellationRequested) return false
        throw error
      }
    })
    if (!ready) return this.refresh(meta.runId)
    const preparing = this.launch(meta).catch(async error => {
      const current = await this.readMeta(meta.runId)
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
      if (current.serviceUnit) {
        // A command failure can occur after native entry; status must reconcile the persisted unit first.
        await this.writeMeta({ ...current, message })
      } else {
        await this.finish(meta.runId, current.cancellationRequested ? 'canceled' : 'failed', null, message)
      }
    }).finally(() => this.preparing.delete(meta.runId))
    this.preparing.set(meta.runId, preparing)
    return this.refresh(request.runId)
  }

  private async git(args: readonly string[], cwd?: string) {
    const result = await this.ports.run('git', [...gitAuth, ...args], { ...(cwd ? { cwd } : {}),
      env: { ...this.environment, GIT_TERMINAL_PROMPT: '0' } })
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim().split('\n').at(-1) ?? ''}`)
    return result.stdout
  }

  /** Fetch the commit with this computer's GitHub login and start the suite in a private checkout. */
  private launch(meta: RunMeta) {
    return withHostCiRunLock(this.runDirectory(meta.runId), () => this.launchRun(meta))
  }

  private async launchRun(meta: RunMeta) {
    const previous = this.repositoryQueues.get(meta.repository) ?? Promise.resolve()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    this.repositoryQueues.set(meta.repository, pending)
    await previous
    let source: string
    try {
      const current = await this.readMeta(meta.runId)
      if (current.state !== 'starting' || current.cancellationRequested) return
      source = await this.checkout(meta)
    } finally {
      release()
      if (this.repositoryQueues.get(meta.repository) === pending) this.repositoryQueues.delete(meta.repository)
    }
    await this.selectFiles(meta, source)
    const script = await this.script(meta, source)
    await writeFile(join(this.runDirectory(meta.runId), 'run.sh'), script, { mode: 0o700 })
    const current = await this.readMeta(meta.runId)
    if (current.state !== 'starting' || current.cancellationRequested) return
    const serviceUnit = `${unitName(meta.runId)}.service`
    await this.writeMeta({ ...meta, ...current, serviceUnit,
      ...(meta.scope ? { scope: meta.scope } : {}), ...(meta.files ? { files: meta.files } : {}),
      ...(meta.testResultsExpected !== undefined ? { testResultsExpected: meta.testResultsExpected } : {}),
      message: meta.message })
    const resources = this.suiteResources(meta)
    const environment = ['PATH', 'HOME', 'USER', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
      .flatMap(key => this.environment[key] ? [`--setenv=${key}=${this.environment[key]}`] : [])
    const started = await this.ports.run('systemd-run', ['--user', '--quiet', '--collect', `--unit=${unitName(meta.runId)}`,
      `--property=MemoryMax=${resources.memoryBytes}`, `--property=CPUQuota=${resources.cpuCount * 100}%`,
      '--property=UMask=0022', `--working-directory=${source}`, ...environment, '/bin/bash', join(this.runDirectory(meta.runId), 'run.sh')],
    { env: this.environment, timeoutMs: 30_000 })
    if (started.code !== 0) throw new Error(`The CI unit could not start: ${started.stderr.trim().slice(0, 500)}`)
    const launched = await this.readMeta(meta.runId)
    if (launched.state === 'starting') await this.writeMeta({ ...launched, state: 'running' })
  }

  private async prepareRepository(request: Pick<StartRequest, 'repository' | 'commit' | 'scope' | 'files'>) {
    const clone = join(this.root, 'git', ...request.repository.split('/'))
    if (!existsSync(join(clone, '.git'))) {
      await mkdir(join(clone, '..'), { recursive: true, mode: 0o700 })
      await mkdir(clone, { recursive: true, mode: 0o700 })
      await this.git(['init', '--quiet', clone])
      await this.git(['remote', 'add', 'origin', `https://github.com/${request.repository}.git`], clone)
    }
    const history = (request.scope ?? 'affected') === 'affected' && request.files === undefined
    const missing = (await this.ports.run('git', ['cat-file', '-e', `${request.commit}^{commit}`],
      { cwd: clone, env: this.environment })).code !== 0
    if (missing || history) {
      const shallow = history && (await this.git(['rev-parse', '--is-shallow-repository'], clone)).trim() === 'true'
      let depth = ['--depth=1']
      if (history) depth = shallow ? ['--unshallow'] : []
      await this.git(['fetch', '--quiet', '--no-tags', ...depth, 'origin', request.commit], clone)
    }
  }

  private async supportsDatabaseIsolation(request: Pick<StartRequest, 'repository' | 'commit'>) {
    const clone = join(this.root, 'git', ...request.repository.split('/'))
    const manifest = await this.ports.run('git', ['show', `${request.commit}:package.json`],
      { cwd: clone, env: this.environment })
    if (manifest.code !== 0) return false
    const parsed = JSON.parse(manifest.stdout) as { foremanCi?: { hostSlots?: number } }
    return parsed.foremanCi?.hostSlots === 1
  }

  /** Resets the run's slot checkout to its commit, or falls back to a fresh checkout in the run directory. */
  private async checkout(meta: RunMeta): Promise<string> {
    const clone = join(this.root, 'git', ...meta.repository.split('/'))
    if (meta.slot !== undefined) {
      const source = this.slotSource(meta.repository, meta.slot)
      try {
        if (existsSync(join(source, '.git'))) {
          await this.git(['checkout', '--quiet', '--force', '--detach', meta.commit], source)
        } else {
          await rm(source, { recursive: true, force: true })
          await mkdir(join(source, '..'), { recursive: true, mode: 0o700 })
          await this.git(['worktree', 'prune'], clone)
          await this.git(['worktree', 'add', '--quiet', '--detach', source, meta.commit], clone)
        }
        // Only installed dependencies survive: untracked files, caches and build outputs of earlier commits
        // (including outputs of sources this commit deleted) must not leak into this part.
        await this.git(['clean', '-ffdxq', '-e', 'node_modules'], source)
        return source
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await appendFile(join(this.runDirectory(meta.runId), 'log'),
          `[ci-checkout] persistent checkout unusable (${reason.slice(0, 500)}); using a fresh checkout\n`, { mode: 0o600 })
        // The next part on this slot starts from a new checkout instead of failing the same way.
        await rm(join(source, '..'), { recursive: true, force: true })
        await this.git(['worktree', 'prune'], clone)
        delete meta.slot
        const current = await this.readMeta(meta.runId)
        delete current.slot
        await this.writeMeta(current)
      }
    }
    const source = join(this.runDirectory(meta.runId), 'src')
    await this.git(['worktree', 'add', '--quiet', '--detach', source, meta.commit], clone)
    return source
  }

  private suiteResources(meta: RunMeta) {
    const resources = meta.resources!
    if (!meta.isolatedDatabase) return resources
    const database = this.databaseResources(meta)
    return { cpuCount: resources.cpuCount - database.cpuCount,
      memoryBytes: Math.max(1, resources.memoryBytes - database.memoryBytes) }
  }

  private databaseResources(meta: RunMeta) {
    const resources = meta.resources!
    const half = { cpuCount: resources.cpuCount / 2, memoryBytes: Math.floor(resources.memoryBytes / 2) }
    if (meta.suite !== 'integration') {
      return { cpuCount: Math.min(1, half.cpuCount), memoryBytes: Math.min(2 ** 30, half.memoryBytes) }
    }
    // Every integration shard migrates and queries its own databases on this one server: one CPU
    // per four shards and 256 MiB each keep setup fast; a fixed single CPU made files time out.
    const shards = Math.max(1, Math.min(meta.integrationShards ?? Infinity, Math.floor(resources.cpuCount)))
    return { cpuCount: Math.min(Math.max(1, Math.ceil(shards / 4)), half.cpuCount),
      memoryBytes: Math.min(Math.max(2 ** 30, shards * 2 ** 28), half.memoryBytes) }
  }

  private async selectFiles(meta: RunMeta, source: string) {
    if (meta.scope !== 'affected' || meta.files !== undefined) return
    const full = (reason: string) => {
      meta.scope = 'full'
      meta.message = `Running full suite: ${reason}`
    }
    const selector = join(source, 'scripts/ci-affected.mjs')
    if (!existsSync(selector)) return full('The repository has no affected selector.')
    let baseCommit = meta.baseCommit
    if (baseCommit) {
      const available = await this.ports.run('git', ['cat-file', '-e', `${baseCommit}^{commit}`],
        { cwd: source, env: this.environment })
      if (available.code !== 0) {
        const fetched = await this.ports.run('git', ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', baseCommit],
          { cwd: source, env: this.environment })
        if (fetched.code !== 0) return full('baseCommit is unavailable or is not an ancestor of the resolved commit.')
      }
      const ancestor = await this.ports.run('git', ['merge-base', '--is-ancestor', baseCommit, meta.commit],
        { cwd: source, env: this.environment })
      if (ancestor.code !== 0) return full('baseCommit is unavailable or is not an ancestor of the resolved commit.')
    } else {
      const branch = meta.defaultBranch ?? 'main'
      const ref = `refs/remotes/origin/${branch}`
      await this.git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${ref}`], source)
      if ((await this.git(['rev-parse', ref], source)).trim() === meta.commit) {
        return full('The commit is the workspace default branch head.')
      }
      const base = await this.ports.run('git', ['merge-base', meta.commit, ref], { cwd: source, env: this.environment })
      if (base.code !== 0) return full('No merge-base with the workspace default branch is available.')
      baseCommit = base.stdout.trim()
    }
    const changed = (await this.git(['diff', '--name-only', '--no-renames', '-z', baseCommit, meta.commit], source))
      .split('\0').filter(Boolean)
    const selection = await this.repositorySelection(meta, source, selector, changed)
    if (selection.scope === 'full') return full(selection.reason)
    const files = await this.partFiles(meta, source, selection.files)
    meta.files = files
    meta.message = files.length ? `Selected ${files.length} affected files for ${meta.part ?? meta.suite}.`
      : 'No affected files for this suite part.'
  }

  private async repositorySelection(meta: RunMeta, source: string, selector: string, changed: string[]) {
    // selectAffectedFiles also supports repositories whose snapshot helper assumes origin/main.
    const code = [
      "import { execFileSync } from 'node:child_process'",
      "import { readFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "import { pathToFileURL } from 'node:url'",
      'const [selector, suite, commit, changed] = process.argv.slice(1)',
      'const { selectAffectedFiles } = await import(pathToFileURL(selector).href)',
      "const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', commit], { encoding: 'utf8' })",
      "  .split('\\0').filter(Boolean)",
      'const sources = new Map(paths.map(file => [file, /\\.(?:[cm]?[jt]sx?|json|css)$/.test(file)',
      "  ? readFileSync(join(process.cwd(), file), 'utf8') : '']))",
      "const manifest = sources.get('packages/contracts/package.json')",
      'console.log(JSON.stringify(selectAffectedFiles({ suite, changedFiles: JSON.parse(changed), sources,',
      '  exports: manifest ? JSON.parse(manifest).exports : {} })))',
    ].join('\n')
    const result = await this.ports.run('node', ['--input-type=module', '-e', code, selector,
      meta.suite, meta.commit, JSON.stringify(changed)], { cwd: source, env: this.environment })
    if (result.code !== 0) throw new Error(`Affected selection failed: ${result.stderr.trim().slice(0, 500)}`)
    const selection = JSON.parse(result.stdout) as { scope: unknown; files: unknown; reason: string }
    const scope = CiScopeSchema.parse(selection.scope)
    const files = CiSelectedFilesSchema.parse(selection.files)
    if (!validCiSelection({ suite: meta.suite, scope, files })) throw new Error('The repository returned invalid affected files.')
    return { scope, files, reason: selection.reason }
  }

  private async partFiles(meta: RunMeta, source: string, selected: string[]) {
    const part = meta.part
    if (!part) return selected
    const heavyPath = join(source, 'apps/web/heavy-tests.json')
    const heavy = existsSync(heavyPath) ? (JSON.parse(await readFile(heavyPath, 'utf8')) as { files: string[] }).files : []
    let files = selected.filter(file => {
      if (part.endsWith('-api')) return file.startsWith('apps/api/')
      if (part.endsWith('-other')) {
        return !file.startsWith('apps/api/') && (meta.suite !== 'unit' || !file.startsWith('apps/web/'))
      }
      const isHeavy = heavy.some(pattern => matchesGlob(file.slice('apps/web/'.length), pattern))
      return file.startsWith('apps/web/') && (part === 'unit-web-heavy' ? isHeavy : !isHeavy)
    })
    if (meta.partition) {
      files = integrationPartition(files, meta.durations ?? {}, meta.partition)
    }
    return files
  }

  private async script(meta: RunMeta, source: string) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    const scripts = manifest.scripts ?? {}
    const capabilities = ciRepositoryCapabilities(['scripts/ci-suite.sh', 'scripts/ci-files.mjs',
      'scripts/ci-affected-run.mjs'].filter(file => existsSync(join(source, file))))
    const pm = this.packageManager(source)
    const suiteScript: Record<CiSuite, string | null> = { install: null, typecheck: 'typecheck', lint: 'lint',
      unit: 'test', build: 'build', integration: 'test:integration' }
    let name: string | null = null
    if (capabilities.parts) name = suiteScript[meta.suite]
    else if (meta.suite !== 'install') name = meta.suite
    if (!meta.part && name && !scripts[name]) throw new Error(`The repository has no "${name}" script for the ${meta.suite} suite.`)
    if (meta.part && !capabilities.parts) throw new Error('The repository does not support CI suite parts.')
    if (meta.partition && !meta.part && !capabilities.integrationPartitions) {
      throw new Error('The repository does not support integration partitions.')
    }
    let command = ''
    if (meta.part) command = this.partCommand(meta, quote)
    else if (name) command = capabilities.parts ? `${pm} ${name}` : `${pm} run ${name}`
    const supportsSelection = meta.suite === 'integration' ? capabilities.integrationPartitions : capabilities.affected
    const affected = meta.scope === 'affected' && supportsSelection
    if (affected && meta.suite !== 'integration') {
      const selectedPath = join(this.runDirectory(meta.runId), 'selected-files.json')
      await writeFile(selectedPath, JSON.stringify(meta.files ?? []), { mode: 0o600 })
      command = meta.files?.length ? `node scripts/ci-affected-run.mjs ${meta.suite} --files-from ${quote(selectedPath)}` : 'true'
    }
    if (meta.suite === 'typecheck' && command !== 'true'
      && existsSync(join(source, 'scripts/ci-typecheck-cache.mjs'))) {
      command = `node scripts/ci-typecheck-cache.mjs -- bash -c ${quote(command)}`
    }
    const apiUnit = meta.suite === 'unit' && (meta.part === 'unit-api'
      || (affected && meta.files?.some(file => file.startsWith('apps/api/'))))
    const prerequisiteSuite = apiUnit ? 'unit-api' : meta.part ?? meta.suite
    const run = this.runDirectory(meta.runId)
    const resources = this.suiteResources(meta)
    const workers = Math.max(1, Math.min(resources.cpuCount, Math.floor(resources.memoryBytes / 2 ** 30)))
    const heapMb = Math.max(256, Math.min(6144, Math.floor(resources.memoryBytes / 2 / 2 ** 20)))
    const database = capabilities.parts && meta.isolatedDatabase === true
    const databaseResources = this.databaseResources(meta)
    const cache = join(this.root, 'cache', ...meta.repository.split('/'))
    const prerequisites = command !== '' && command !== 'true' && capabilities.parts
    const contracts = prerequisites && existsSync(join(source, 'scripts/ci-contracts.mjs'))
    let integrationEnvironment = ''
    if (meta.suite === 'integration' && capabilities.integrationPartitions) {
      const durations = meta.durations ?? {}
      await writeFile(join(run, 'expected-durations.json'), JSON.stringify(durations), { mode: 0o600 })
      // The repository's integration runner uses them for per-file hang deadlines and reports what it measured.
      integrationEnvironment = ` FOREMAN_CODE_INTEGRATION_DURATIONS=${quote(join(run, 'expected-durations.json'))}`
        + ` FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT=${quote(join(run, 'measured-durations.json'))}`
        + ` FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT=${quote(join(run, 'test-results.json'))}`
      if (meta.partition || affected || meta.gate) {
        const tests = join(source, 'apps/api/test')
        const files = existsSync(tests) ? (await readdir(tests)).filter(file => file.endsWith('.integration.test.ts'))
          .map(file => `apps/api/test/${file}`).sort() : []
        const selected = affected || meta.gate ? meta.files ?? [] : files
        if (selected.some(file => !files.includes(file))) throw new Error('Selected integration files are absent from the commit.')
        const slice = meta.partition ? integrationPartition(selected, durations, meta.partition) : selected
        if (!slice.length && meta.partition && meta.scope !== 'affected' && !meta.deriveFiles) {
          throw new Error('This partition has no integration files.')
        }
        if (!slice.length && meta.scope === 'affected') meta.message = 'No affected files for this suite part.'
        command = slice.length ? `${command} --files ${slice.map(quote).join(' ')}` : 'true'
      }
    }
    meta.testResultsExpected = command !== 'true' && (meta.suite === 'unit' && capabilities.parts
      || meta.suite === 'integration' && capabilities.integrationPartitions)
    const sourceWatchdog = join(source, 'scripts/ci-watchdog.mjs')
    const watchdog = existsSync(sourceWatchdog) ? sourceWatchdog
      : fileURLToPath(new URL('../../../../../scripts/ci-watchdog.mjs', import.meta.url))
    const watchedCommand = `CI_EXPECTED_DURATION_MS=${meta.expectedDurationMs ?? 0}`
        + ` CI_WATCHDOG_DIRECTORY=${quote(run)} CI_WATCHDOG_MESSAGE_FILE=${quote(join(run, 'watchdog-message.json'))}`
        // Only test suites report per-test progress; typecheck, lint and build can stay silent for minutes.
        + (['unit', 'integration'].includes(meta.suite) ? ` node ${quote(watchdog)} --` : '') + ` bash -c ${quote(command)}`
    return ['#!/bin/bash', 'set -o pipefail', `exec >>${quote(join(run, 'log'))} 2>&1`,
      `export TMPDIR=${quote(join(run, 'tmp'))} CI=true NODE_OPTIONS=--max-old-space-size=${heapMb}`
        + ` FOREMAN_CODE_CI_CONTRACTS_CACHE=${quote(join(cache, 'contracts'))}`
        + ` FOREMAN_CODE_CI_TYPECHECK_CACHE=${quote(join(source, '..', 'typecheck-cache'))}`
        + ` FOREMAN_CODE_CI_CPU_COUNT=${Math.max(1, Math.floor(resources.cpuCount))}`
        + ` FOREMAN_CODE_CI_MEMORY_BYTES=${resources.memoryBytes}`
        + ` FOREMAN_CODE_VERIFICATION_UNIT_WORKERS=${workers}`
        + (meta.gate ? ` FOREMAN_CODE_CI_INTEGRATION_SHARDS=${meta.integrationShards}` : '')
        // The repository's suite hook writes structured test results here; integration has its own setting.
        + (capabilities.parts ? ` CI_HOST_RUNNER=1 FOREMAN_CODE_CI_DEDICATED=1`
          + (meta.suite === 'integration' ? '' : ` TEST_RESULTS_OUTPUT=${quote(join(run, 'test-results.json'))}`)
          + ` FOREMAN_CODE_VITEST_CACHE=${quote(join(run, 'vitest-cache'))}` : '') + integrationEnvironment,
      ...(database ? [`export FOREMAN_CODE_CI_HOST_RUN_ID=${quote(meta.runId)}`
        + ` FOREMAN_CODE_CI_DATABASE_CPUS=${databaseResources.cpuCount}`
        + ` FOREMAN_CODE_CI_DATABASE_MEMORY_BYTES=${databaseResources.memoryBytes}`] : []),
      'mkdir -p "$TMPDIR"',
      `finish() { local code="$1";`
        + ' if [ -n "${preparation_pid:-}" ]; then wait "$preparation_pid" || true; fi;'
        + (database ? ` ${pm} db:down || { [ "$code" != 0 ] || code=1; }; trap - EXIT;` : '')
        + ` echo "$code" > ${quote(join(run, 'exit.tmp'))};`
        + ` mv -- ${quote(join(run, 'exit.tmp'))} ${quote(join(run, 'exit'))}; exit "$code"; }`,
      ...(database ? [`trap '${pm} db:down' EXIT`] : []),
      `step() { echo "$1" > ${quote(join(run, 'step'))}; echo "::step $1"; }`,
      ...(meta.notice ? [`echo ${quote(meta.notice)}`] : []),
      ...(meta.message ? [`echo ${quote(meta.message)}`] : []),
      'step install',
      ...(existsSync(join(source, 'pnpm-lock.yaml')) ? pnpmInstall(cache) : [`${pm} install || finish $?`]),
      // pnpm script commands can reinstall dependencies, so preparation must wait for installation.
      ...(prerequisites ? [`SUITE=${quote(prerequisiteSuite)} bash scripts/ci-suite.sh prepare`
        + ` >${quote(join(run, 'preparation.log'))} 2>&1 & preparation_pid=$!`] : []),
      ...(contracts ? ['step contracts', 'corepack pnpm --filter @foreman-code/contracts build || finish $?'] : []),
      ...(prerequisites ? ['step prepare', 'wait "$preparation_pid"; preparation_code=$?',
        `cat ${quote(join(run, 'preparation.log'))}`, '[ "$preparation_code" = 0 ] || finish "$preparation_code"'] : []),
      `echo "[ci-setup] setup completed in $(( $(date +%s%3N) - ${Date.parse(meta.startedAt)} )) ms"`,
      ...(command ? [`step ${meta.part ?? meta.suite}`,
        ...(database ? ['if [ -f "$TMPDIR/test-database-url" ]; then',
          '  export FOREMAN_CODE_CI_TEST_ADMIN_URL="$(cat "$TMPDIR/test-database-url")"', 'fi'] : []),
        `${watchedCommand} || finish $?`] : []),
      'finish 0', ''].join('\n')
  }

  private packageManager(source: string): string {
    if (existsSync(join(source, 'pnpm-lock.yaml'))) return 'corepack pnpm'
    if (existsSync(join(source, 'package-lock.json')) || existsSync(join(source, 'npm-shrinkwrap.json'))) return 'npm'
    if (existsSync(join(source, 'yarn.lock'))) return 'corepack yarn'
    return 'npm'
  }

  private partCommand(meta: RunMeta, quote: (value: string) => string): string {
    const output = join(this.runDirectory(meta.runId), 'measured-durations.json')
    const slice = meta.partition ? `${meta.partition.index + 1}/${meta.partition.count}` : ''
    // The runner already chose the scope; the hook must not derive its own selection.
    return `SUITE=${quote(meta.part!)} SCOPE=full SLICE=${quote(slice)} DURATIONS_OUTPUT=${quote(output)} bash scripts/ci-suite.sh`
  }

  private async finish(runId: string, state: CiHostRun['state'], exitCode: number | null, message: string | null) {
    const meta = await this.readMeta(runId)
    if (!['starting', 'running'].includes(meta.state)) return
    const outcome = meta.cancellationRequested ? 'canceled' : state
    await this.writeMeta({ ...meta, state: outcome, exitCode, message, finishedAt: this.ports.now().toISOString() })
  }

  private async cleanDatabase(meta: RunMeta) {
    const directory = this.runDirectory(meta.runId)
    const source = meta.slot === undefined ? join(directory, 'src') : this.slotSource(meta.repository, meta.slot)
    const script = join(source, 'scripts/test-db.mjs')
    if (!existsSync(script) || meta.isolatedDatabase !== true) return
    const result = await this.ports.run('node', [script, 'down'], {
      cwd: source,
      env: { ...this.environment, FOREMAN_CODE_CI_HOST_RUN_ID: meta.runId,
        FOREMAN_CODE_VERIFICATION_ENVIRONMENT: '', TMPDIR: join(directory, 'tmp') },
    })
    if (result.code !== 0) throw new Error(`CI database cleanup failed: ${result.stderr.trim().slice(0, 500)}`)
  }

  private async unitState(meta: RunMeta): Promise<'active' | 'stopped' | 'unknown'> {
    const unit = meta.serviceUnit ?? `${unitName(meta.runId)}.service`
    const result = await this.ports.run('systemctl', ['--user', 'is-active', unit], { env: this.environment })
    const state = result.stdout.trim()
    if ([0, 3].includes(result.code)) {
      if (['active', 'activating', 'reloading', 'deactivating'].includes(state)) return 'active'
      if (['inactive', 'failed'].includes(state)) return 'stopped'
    }
    // Collected transient units have no record. A successful manager query must establish that absence.
    const detail = await this.ports.run('systemctl', ['--user', 'show',
      '--property=LoadState', '--property=ActiveState', unit], { env: this.environment })
    if (detail.code === 0 && detail.stdout.split('\n').includes('LoadState=not-found')
      && detail.stdout.split('\n').includes('ActiveState=inactive')) return 'stopped'
    return 'unknown'
  }

  private async finishFromExit(meta: RunMeta): Promise<boolean> {
    const exit = await readFile(join(this.runDirectory(meta.runId), 'exit'), 'utf8')
      .catch(fallbackOnError(null, 'jobs', 'read CI exit status', { runId: meta.runId }, ['ENOENT']))
    if (exit === null || exit.trim() === '') return false
    const code = Number(exit.trim())
    const watchdog = await readFile(join(this.runDirectory(meta.runId), 'watchdog-message.json'), 'utf8')
      .catch(fallbackOnError(null, 'jobs', 'read CI watchdog message', { runId: meta.runId }, ['ENOENT']))
    let state: CiHostRun['state'] = code === 0 ? 'passed' : 'failed'
    if (meta.cancellationRequested) state = 'canceled'
    await this.finish(meta.runId, state,
      Number.isInteger(code) ? code : 1,
      watchdog ? CiWatchdogFailureSchema.parse(JSON.parse(watchdog)).message : meta.message)
    if (meta.cancellationRequested) await this.cleanDatabase(meta)
    return true
  }

  private async reconcile(meta: RunMeta, preparing: boolean): Promise<void> {
    if (!['starting', 'running'].includes(meta.state) || preparing) return
    if (await this.finishFromExit(meta)) return
    if (meta.cancellationRequested) {
      const stop = await this.ports.run('systemctl', ['--user', 'stop',
        meta.serviceUnit ?? `${unitName(meta.runId)}.service`], { env: this.environment })
      if (stop.code !== 0) await this.writeMeta({ ...meta,
        message: 'Cancellation requested; the CI unit has not confirmed it stopped.' })
    }
    const state = await this.unitState(meta)
    if (state === 'stopped') {
      // The unit can publish its exit status while the systemd query is in flight.
      if (await this.finishFromExit(meta)) return
      await this.cleanDatabase(meta)
      await this.finish(meta.runId, meta.cancellationRequested ? 'canceled' : 'lost', null,
        meta.cancellationRequested ? 'Canceled.' : 'The CI unit ended without an exit status.')
    } else if (state === 'active' && meta.state === 'starting') {
      const current = await this.readMeta(meta.runId)
      if (current.state === 'starting') await this.writeMeta({ ...current, state: 'running' })
    }
  }

  /** Reads the current state of a run, settling it once its unit has exited, and frees its worktree. */
  async refresh(runId: string): Promise<CiHostRun> {
    // Launch can finish while the metadata read is awaiting I/O.
    const preparing = this.preparing.has(runId) || this.startingRun?.runId === runId
    let meta = await this.readMeta(runId).catch(error => {
      if (error instanceof DomainError && error.code === 'CI_RUN_UNKNOWN'
        && existsSync(join(this.runDirectory(runId), 'cancel-requested'))) return null
      throw error
    })
    if (!meta) return this.canceledBeforeStart(runId)
    const directory = this.runDirectory(runId)
    // Settled runs have nothing to reconcile. Each lock spawns a flock process, and status polls read every run.
    const settled = !['starting', 'running'].includes(meta.state)
    const reconciled = settled || await withHostCiRunLock(directory, async () => {
      await this.reconcile(await this.readMeta(runId), preparing)
      return true
    }, { nonBlocking: true })
    if (!settled) meta = await this.readMeta(runId)
    if (!reconciled && meta.state === 'starting' && meta.serviceUnit && await this.unitState(meta) === 'active') {
      // A live launcher can still be writing metadata after systemd accepted the service.
      meta = { ...meta, state: 'running' }
    }
    if (!['starting', 'running'].includes(meta.state) && !meta.cleaned && !this.preparing.has(runId)) {
      const clone = join(this.root, 'git', ...meta.repository.split('/'))
      if (existsSync(join(directory, 'src'))) {
        if (!(await stat(join(directory, 'src/.git')).catch(
          fallbackOnError(null, 'jobs', 'stat CI checkout metadata', { runId }, ['ENOENT']),
        ))?.isDirectory()) {
          await this.ports.run('git', ['worktree', 'remove', '--force', join(directory, 'src')], { cwd: clone, env: this.environment })
        }
        await rm(join(directory, 'src'), { recursive: true, force: true })
        await this.ports.run('git', ['worktree', 'prune'], { cwd: clone, env: this.environment })
      }
      await rm(join(directory, 'tmp'), { recursive: true, force: true })
      meta = { ...meta, cleaned: true }
      await this.writeMeta(meta)
    }
    const log = await stat(join(directory, 'log')).catch(fallbackOnError(null, 'jobs', 'stat CI log', { runId }, ['ENOENT']))
    const step = (await readFile(join(directory, 'step'), 'utf8').catch(() => '')).trim()
      || (this.startingRun?.runId === runId ? 'dispatch' : null)
    return { runId, state: meta.state, step, exitCode: meta.exitCode, startedAt: meta.startedAt,
      finishedAt: meta.finishedAt, logBytes: log?.size ?? 0,
      message: this.runMessage(meta) }
  }

  private runMessage(meta: RunMeta): string | null {
    if (meta.cancellationRequested && ['starting', 'running'].includes(meta.state)) {
      return 'Cancellation requested; waiting for preparation and the CI unit to stop.'
    }
    return meta.message === null ? null : sanitizeCiText(meta.message)
  }

  private async cancelPreparation(runId: string) {
    const meta = await this.readMeta(runId)
    if (!meta.cancellationRequested) return false
    await this.finish(runId, 'canceled', null, 'Canceled before execution.')
    return true
  }

  private async canceledBeforeStart(runId: string): Promise<CiHostRun> {
    if (this.startingRun?.runId === runId) {
      return { ...this.startingRun, message: 'Cancellation requested; waiting for preparation to stop.' }
    }
    const requested = await stat(join(this.runDirectory(runId), 'cancel-requested'))
    return { runId, state: 'canceled', step: null, exitCode: null,
      startedAt: requested.mtime.toISOString(), finishedAt: requested.mtime.toISOString(),
      logBytes: 0, message: 'Canceled before execution.' }
  }

  async cancel(runId: string): Promise<CiHostRun> {
    const meta = await this.readMeta(runId).catch(error => {
      if (error instanceof DomainError && error.code === 'CI_RUN_UNKNOWN') return null
      throw error
    })
    if (!meta || ['starting', 'running'].includes(meta.state)) {
      const directory = this.runDirectory(runId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      try {
        await writeFile(join(directory, 'cancel-requested'), '', { mode: 0o600, flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // The first marker keeps the cancellation timestamp stable on retries.
      }
      if (!meta) return this.refresh(runId)
      await this.preparing.get(runId)
    }
    return this.refresh(runId)
  }
}
