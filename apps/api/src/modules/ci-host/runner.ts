import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { availableParallelism, freemem, homedir, totalmem } from 'node:os'
import { join, matchesGlob } from 'node:path'
import { CiDurationsSchema, CiHostReplySchema, CiHostRequestSchema, CiTestResultsSchema, integrationPartition,
  CiScopeSchema, CiSelectedFilesSchema, validCiSelection,
  type CiDurations, type CiHostReply, type CiHostRun, type CiSuite, type CiPart, type CiPartition, type CiScope } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { ciRepositoryCapabilities } from './repository.js'
import { gateIntegrationShards, hostCiCapacity } from './capacity.js'
import { fallbackOnError } from '../diagnostics/ignoredError.js'
import { warmPnpmInstall } from './warmSetup.js'

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
  isolatedDatabase?: boolean
  gate?: boolean; integrationShards?: number
}

type StartRequest = { runId: string; repository: string; commit: string; suite: CiSuite
  part?: CiPart | undefined; partition?: CiPartition | undefined; durations?: CiDurations | undefined;
  scope?: CiScope | undefined; files?: string[] | undefined; defaultBranch?: string | undefined;
  baseCommit?: string | undefined; gate?: boolean | undefined; integrationShards?: number | undefined }

const unitName = (runId: string) => `foreman-ci-${runId}`
// GitHub CLI's own credential helper: a computer that is logged in to gh fetches without any app setup.
const gitAuth = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']

/** Runs CI suites directly on this computer, like a self-hosted runner. Each run is a transient
 * systemd user service, so it outlives a Worker restart, and its CPU and memory stay below the host reserve. */
export class HostCiRunner {
  private readonly preparing = new Map<string, Promise<void>>()
  private startQueue = Promise.resolve()
  private startingRunId: string | null = null
  private readonly repositoryQueues = new Map<string, Promise<void>>()
  private githubChecked: { at: number; ready: boolean; reason: string | null } | undefined

  constructor(private readonly root = join(homedir(), '.local/share/foreman-code/ci-host'),
    private readonly ports: HostCiPorts = systemHostCiPorts(),
    private readonly environment: NodeJS.ProcessEnv = process.env) {}

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
        text = buffer.subarray(0, bytesRead).toString('utf8')
        nextOffset = request.afterOffset + bytesRead
      } finally { await handle.close() }
    }
    // A finished test run reports the file durations and test results it measured, so Main can learn and show them.
    const finished = !['starting', 'running'].includes(run.state)
    const report = (name: string) => readFile(join(this.runDirectory(request.runId), name), 'utf8')
      .then(text => JSON.parse(text) as unknown)
      .catch(fallbackOnError(null, 'jobs', 'read CI report', { runId: request.runId, report: name }, ['ENOENT']))
    const measured = request.durations && finished ? CiDurationsSchema.safeParse(await report('measured-durations.json')) : null
    const tests = request.testResults && finished ? CiTestResultsSchema.safeParse(await report('test-results.json')) : null
    return CiHostReplySchema.parse({ operation: 'read', run, text, nextOffset,
      ...(measured?.success ? { durations: measured.data } : {}),
      ...(tests?.success ? { testResults: tests.data } : {}) })
  }

  private runDirectory(runId: string) { return join(this.root, 'runs', runId) }

  private async readMeta(runId: string): Promise<RunMeta> {
    try { return JSON.parse(await readFile(join(this.runDirectory(runId), 'meta.json'), 'utf8')) as RunMeta }
    catch { throw new DomainError('CI_RUN_UNKNOWN', 'This computer has no such CI run.', 404) }
  }

  private async writeMeta(meta: RunMeta) {
    const path = join(this.runDirectory(meta.runId), 'meta.json')
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      // Busy checks must see a complete record while launch updates the run state.
      await writeFile(temporary, JSON.stringify(meta), { mode: 0o600, flag: 'wx' })
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
    const github = await this.github()
    const reasons = github.reason ? [github.reason] : []
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
    const active = await this.active()
    const availableMemoryBytes = this.ports.availableMemoryBytes?.() ?? this.ports.memoryBytes
    const capacity = this.capacity(active, availableMemoryBytes)
    const activeRuns = runs.filter(run => run && ['starting', 'running'].includes(run.state))
    const finishedRuns = runs.filter(run => run && !['starting', 'running'].includes(run.state))
    return CiHostReplySchema.parse({ operation: 'status', ready: !reasons.length, reasons,
      cpuCount: this.ports.cpus, memoryBytes: this.ports.memoryBytes, availableMemoryBytes,
      slotsUsed: capacity.slotsUsed, slotsTotal: capacity.slotsTotal,
      runs: [...activeRuns, ...finishedRuns.slice(-Math.max(0, 50 - activeRuns.length))].slice(0, 50) })
  }

  private capacity(active: RunMeta[], availableMemoryBytes = this.ports.availableMemoryBytes?.() ?? this.ports.memoryBytes) {
    return hostCiCapacity({ cpuCount: this.ports.cpus, memoryBytes: this.ports.memoryBytes, availableMemoryBytes },
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
    // Keep the busy check and initial persistence together, including same-run retries.
    const previous = this.startQueue
    let release!: () => void
    this.startQueue = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await this.startRun(request)
    } finally {
      this.startingRunId = null
      release()
    }
  }

  private async startRun(request: StartRequest) {
    const directory = this.runDirectory(request.runId)
    if (existsSync(join(directory, 'meta.json'))) return this.refresh(request.runId)
    this.startingRunId = request.runId
    let active = await this.active()
    if (active.some(run => run.gate) || request.gate && active.length) {
      throw new DomainError('CI_HOST_BUSY', 'A gate requires exclusive use of this build computer.', 409)
    }
    let capacity = this.capacity(active)
    if (capacity.slotsUsed >= capacity.slotsTotal) {
      throw new DomainError('CI_HOST_BUSY',
        `All CI slots are in use (${capacity.slotsUsed}/${capacity.slotsTotal}); waiting for CPU or memory capacity.`, 409)
    }
    const github = await this.github()
    if (!github.ready) throw new DomainError('COMPUTER_GITHUB_REQUIRED', github.reason!, 409)
    const startedAt = this.ports.now().toISOString()
    await this.prepareRepository(request)
    const databaseSuite = ['unit', 'integration'].includes(request.suite)
    const isolatedDatabase = databaseSuite && await this.supportsDatabaseIsolation(request)
    active = await this.active()
    capacity = this.capacity(active)
    if (request.gate) {
      capacity = { ...capacity, slotsUsed: active.length, slotsTotal: 1, cpuCount: this.ports.cpus,
        memoryBytes: Math.max(1, Math.min(capacity.memoryBudget,
          this.ports.availableMemoryBytes?.() ?? capacity.memoryBudget)) }
    }
    if (databaseSuite && !isolatedDatabase) {
      capacity = { slotsUsed: active.length, slotsTotal: 1, cpuCount: this.ports.cpus,
        memoryBudget: capacity.memoryBudget,
        memoryBytes: Math.min(this.ports.availableMemoryBytes?.() ?? this.ports.memoryBytes,
          Math.floor(this.ports.memoryBytes - Math.max(2 ** 30, this.ports.memoryBytes * 0.1))) }
    }
    if (capacity.slotsUsed >= capacity.slotsTotal) {
      throw new DomainError('CI_HOST_BUSY',
        `All CI slots are in use (${capacity.slotsUsed}/${capacity.slotsTotal}); this commit needs exclusive database capacity.`, 409)
    }
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const meta: RunMeta = { runId: request.runId, repository: request.repository, commit: request.commit,
      suite: request.suite, partition: request.partition ?? null, startedAt,
      state: 'starting', finishedAt: null, exitCode: null, message: null, cleaned: false,
      resources: { cpuCount: capacity.cpuCount, memoryBytes: capacity.memoryBytes, memoryBudget: capacity.memoryBudget },
      isolatedDatabase,
      ...(request.gate ? { gate: true, integrationShards: Math.min(request.integrationShards!,
        gateIntegrationShards(capacity.cpuCount, capacity.memoryBytes)) } : {}),
      ...(request.part ? { part: request.part } : {}),
      scope: request.scope ?? 'affected', ...(request.files !== undefined ? { files: request.files } : {}),
      deriveFiles: (request.scope ?? 'affected') === 'affected' && request.files === undefined,
      ...(request.defaultBranch ? { defaultBranch: request.defaultBranch } : {}),
      ...(request.baseCommit ? { baseCommit: request.baseCommit } : {}),
      ...(request.durations ? { durations: request.durations } : {}) }
    await this.writeMeta(meta)
    const preparing = this.launch(meta).catch(async error => {
      await this.finish(meta.runId, 'failed', null, (error instanceof Error ? error.message : String(error)).slice(0, 2000))
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
  private async launch(meta: RunMeta) {
    const previous = this.repositoryQueues.get(meta.repository) ?? Promise.resolve()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    this.repositoryQueues.set(meta.repository, pending)
    await previous
    const source = join(this.runDirectory(meta.runId), 'src')
    try {
      if ((await this.readMeta(meta.runId)).state !== 'starting') return
      await this.checkout(meta, source)
    } finally {
      release()
      if (this.repositoryQueues.get(meta.repository) === pending) this.repositoryQueues.delete(meta.repository)
    }
    await this.selectFiles(meta, source)
    const script = await this.script(meta, source)
    await writeFile(join(this.runDirectory(meta.runId), 'run.sh'), script, { mode: 0o700 })
    if ((await this.readMeta(meta.runId)).state !== 'starting') return
    const resources = this.suiteResources(meta)
    const environment = ['PATH', 'HOME', 'USER', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
      .flatMap(key => this.environment[key] ? [`--setenv=${key}=${this.environment[key]}`] : [])
    const started = await this.ports.run('systemd-run', ['--user', '--quiet', '--collect', `--unit=${unitName(meta.runId)}`,
      `--property=MemoryMax=${resources.memoryBytes}`, `--property=CPUQuota=${resources.cpuCount * 100}%`,
      '--property=UMask=0022', `--working-directory=${source}`, ...environment, '/bin/bash', join(this.runDirectory(meta.runId), 'run.sh')],
    { env: this.environment, timeoutMs: 30_000 })
    if (started.code !== 0) throw new Error(`The CI unit could not start: ${started.stderr.trim().slice(0, 500)}`)
    if ((await this.readMeta(meta.runId)).state !== 'starting') {
      await this.ports.run('systemctl', ['--user', 'stop', `${unitName(meta.runId)}.service`], { env: this.environment })
      await this.cleanDatabase(meta)
      return
    }
    await this.writeMeta({ ...meta, state: 'running' })
  }

  private async prepareRepository(request: Pick<StartRequest, 'repository' | 'commit'>) {
    const clone = join(this.root, 'git', ...request.repository.split('/'))
    if (!existsSync(join(clone, '.git'))) {
      await mkdir(join(clone, '..'), { recursive: true, mode: 0o700 })
      await this.git(['clone', '--quiet', '--filter=blob:none', '--no-checkout',
        `https://github.com/${request.repository}.git`, clone])
    }
    if ((await this.ports.run('git', ['cat-file', '-e', `${request.commit}^{commit}`], { cwd: clone, env: this.environment })).code !== 0) {
      await this.git(['fetch', '--quiet', '--no-tags', 'origin', request.commit], clone)
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

  private async checkout(meta: RunMeta, source: string) {
    const clone = join(this.root, 'git', ...meta.repository.split('/'))
    await this.git(['worktree', 'add', '--quiet', '--detach', source, meta.commit], clone)
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
    return { cpuCount: Math.min(1, resources.cpuCount / 2),
      memoryBytes: Math.min(2 ** 30, Math.floor(resources.memoryBytes / 2)) }
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
      const timingsPath = join(source, 'scripts/unit-durations.json')
      const committed = existsSync(timingsPath) ? JSON.parse(await readFile(timingsPath, 'utf8')) as CiDurations : {}
      files = integrationPartition(files, { ...committed, ...meta.durations }, meta.partition)
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
      // Main's learned durations, with the commit's committed ones for files it has not measured yet.
      const durationsPath = join(source, 'scripts/integration-durations.json')
      const committed = existsSync(durationsPath) ? JSON.parse(await readFile(durationsPath, 'utf8')) as Record<string, number> : {}
      const durations = { ...committed, ...meta.durations }
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
    return ['#!/bin/bash', 'set -o pipefail', `exec >>${quote(join(run, 'log'))} 2>&1`,
      `export TMPDIR=${quote(join(run, 'tmp'))} CI=true NODE_OPTIONS=--max-old-space-size=${heapMb}`
        + ` FOREMAN_CODE_CI_CONTRACTS_CACHE=${quote(join(cache, 'contracts'))}`
        + ` FOREMAN_CODE_CI_CPU_COUNT=${Math.max(1, Math.floor(resources.cpuCount))}`
        + ` FOREMAN_CODE_CI_MEMORY_BYTES=${resources.memoryBytes}`
        + ` FOREMAN_CODE_VERIFICATION_UNIT_WORKERS=${workers}`
        + (meta.gate ? ` FOREMAN_CODE_INTEGRATION_SHARDS=${meta.integrationShards}`
          + ` GRAPHQL_INTEGRATION_SHARDS=${meta.integrationShards}` : '')
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
      ...(meta.message ? [`echo ${quote(meta.message)}`] : []),
      'step install',
      ...(existsSync(join(source, 'pnpm-lock.yaml')) ? warmPnpmInstall(source, cache, run) : [`${pm} install || finish $?`]),
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
        `${command} || finish $?`] : []),
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
    await this.writeMeta({ ...meta, state, exitCode, message, finishedAt: this.ports.now().toISOString() })
  }

  private async cleanDatabase(meta: RunMeta) {
    const directory = this.runDirectory(meta.runId)
    const script = join(directory, 'src/scripts/test-db.mjs')
    if (!existsSync(script) || meta.isolatedDatabase !== true) return
    const result = await this.ports.run('node', [script, 'down'], {
      cwd: join(directory, 'src'),
      env: { ...this.environment, FOREMAN_CODE_CI_HOST_RUN_ID: meta.runId,
        FOREMAN_CODE_VERIFICATION_ENVIRONMENT: '', TMPDIR: join(directory, 'tmp') },
    })
    if (result.code !== 0) throw new Error(`CI database cleanup failed: ${result.stderr.trim().slice(0, 500)}`)
  }

  /** Reads the current state of a run, settling it once its unit has exited, and frees its worktree. */
  async refresh(runId: string): Promise<CiHostRun> {
    // Launch can finish while the metadata read is awaiting I/O.
    const preparing = this.preparing.has(runId) || this.startingRunId === runId
    let meta = await this.readMeta(runId)
    const directory = this.runDirectory(runId)
    if (meta.state === 'running') {
      const exit = await readFile(join(directory, 'exit'), 'utf8').catch(fallbackOnError(null, 'jobs', 'read CI exit status', { runId }, ['ENOENT']))
      // A unit launched before atomic exit publication can expose an empty file mid-write.
      if (exit !== null && exit.trim() !== '') {
        const code = Number(exit.trim())
        await this.finish(runId, code === 0 ? 'passed' : 'failed', Number.isInteger(code) ? code : 1, meta.message)
      } else {
        const unit = await this.ports.run('systemctl', ['--user', 'is-active', `${unitName(runId)}.service`], { env: this.environment })
        if (!['active', 'activating'].includes(unit.stdout.trim())) {
          // The unit is gone without recording an exit: it was stopped or the computer restarted.
          await this.cleanDatabase(meta)
          await this.finish(runId, 'lost', null, 'The CI unit ended without an exit status.')
        }
      }
    } else if (meta.state === 'starting' && !preparing) {
      await this.cleanDatabase(meta)
      await this.finish(runId, 'lost', null, 'The Worker restarted while preparing this run.')
    }
    meta = await this.readMeta(runId)
    if (!['starting', 'running'].includes(meta.state) && !meta.cleaned && !this.preparing.has(runId)) {
      const clone = join(this.root, 'git', ...meta.repository.split('/'))
      if (existsSync(join(directory, 'src'))) {
        if (!(await stat(join(directory, 'src/.git')).catch(() => null))?.isDirectory()) {
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
    const step = (await readFile(join(directory, 'step'), 'utf8').catch(() => '')).trim() || null
    return { runId, state: meta.state, step, exitCode: meta.exitCode, startedAt: meta.startedAt,
      finishedAt: meta.finishedAt, logBytes: log?.size ?? 0, message: meta.message }
  }

  async cancel(runId: string): Promise<CiHostRun> {
    const meta = await this.readMeta(runId)
    if (['starting', 'running'].includes(meta.state)) {
      await this.ports.run('systemctl', ['--user', 'stop', `${unitName(runId)}.service`], { env: this.environment })
      await this.finish(runId, 'canceled', null, 'Canceled.')
      await this.preparing.get(runId)
      await this.ports.run('systemctl', ['--user', 'stop', `${unitName(runId)}.service`], { env: this.environment })
      await this.cleanDatabase(meta)
      await this.finish(runId, 'canceled', null, 'Canceled.')
    }
    return this.refresh(runId)
  }
}
