import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { availableParallelism, homedir, totalmem } from 'node:os'
import { join, matchesGlob } from 'node:path'
import { CiDurationsSchema, CiHostReplySchema, CiHostRequestSchema, integrationPartition,
  CiScopeSchema, CiSelectedFilesSchema, validCiSelection,
  type CiDurations, type CiHostReply, type CiHostRun, type CiSuite, type CiPart, type CiPartition, type CiScope } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { ciRepositoryCapabilities } from './repository.js'

type Command = { code: number; stdout: string; stderr: string }
export interface HostCiPorts {
  run(file: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<Command>
  now(): Date
  cpus: number
  memoryBytes: number
}

export function systemHostCiPorts(environment: NodeJS.ProcessEnv = process.env): HostCiPorts {
  return {
    run: (file, args, options = {}) => new Promise(resolve => {
      execFile(file, [...args], { cwd: options.cwd, env: options.env ?? environment, timeout: options.timeoutMs ?? 600_000,
        maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
        resolve({ code, stdout, stderr })
      })
    }),
    now: () => new Date(),
    cpus: availableParallelism(),
    memoryBytes: totalmem(),
  }
}

interface RunMeta {
  runId: string; repository: string; commit: string; suite: CiSuite; partition: CiPartition | null
  startedAt: string; state: CiHostRun['state']; finishedAt: string | null; exitCode: number | null
  message: string | null; cleaned: boolean; durations?: CiDurations
  scope?: CiScope; files?: string[]; part?: CiPart; defaultBranch?: string; baseCommit?: string; deriveFiles?: boolean
}

type StartRequest = { runId: string; repository: string; commit: string; suite: CiSuite
  part?: CiPart | undefined; partition?: CiPartition | undefined; durations?: CiDurations | undefined;
  scope?: CiScope | undefined; files?: string[] | undefined; defaultBranch?: string | undefined;
  baseCommit?: string | undefined }

const unitName = (runId: string) => `foreman-ci-${runId}`
// GitHub CLI's own credential helper: a computer that is logged in to gh fetches without any app setup.
const gitAuth = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']

/** Runs CI suites directly on this computer, like a self-hosted runner. One run at a time; each run is a transient
 * systemd user service, so it outlives a Worker restart, and its CPU and memory stay below the host reserve. */
export class HostCiRunner {
  private readonly preparing = new Map<string, Promise<void>>()
  private startQueue = Promise.resolve()
  private startingRunId: string | null = null
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
    // A finished test run reports the file durations it measured, so Main can learn them.
    const measured = request.durations && !['starting', 'running'].includes(run.state)
      ? CiDurationsSchema.safeParse(await readFile(join(this.runDirectory(request.runId), 'measured-durations.json'), 'utf8')
        .then(text => JSON.parse(text) as unknown).catch(() => null)) : null
    return CiHostReplySchema.parse({ operation: 'read', run, text, nextOffset,
      ...(measured?.success ? { durations: measured.data } : {}) })
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
    const names = existsSync(directory) ? (await readdir(directory)).sort().slice(-50) : []
    for (const runId of names) runs.push(await this.refresh(runId).catch(() => null))
    return CiHostReplySchema.parse({ operation: 'status', ready: !reasons.length, reasons,
      cpuCount: this.ports.cpus, memoryBytes: this.ports.memoryBytes, runs: runs.filter(Boolean) })
  }

  private async active(): Promise<string | null> {
    const preparing = this.preparing.keys().next().value
    if (preparing) return preparing
    const directory = join(this.root, 'runs')
    if (!existsSync(directory)) return null
    for (const runId of await readdir(directory)) {
      const run = await this.refresh(runId).catch(() => null)
      if (run && ['starting', 'running'].includes(run.state)) return runId
    }
    return null
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
    const busy = await this.active()
    if (busy) throw new DomainError('CI_HOST_BUSY', 'This computer is already running a CI suite.', 409)
    const github = await this.github()
    if (!github.ready) throw new DomainError('COMPUTER_GITHUB_REQUIRED', github.reason!, 409)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const meta: RunMeta = { runId: request.runId, repository: request.repository, commit: request.commit,
      suite: request.suite, partition: request.partition ?? null, startedAt: this.ports.now().toISOString(),
      state: 'starting', finishedAt: null, exitCode: null, message: null, cleaned: false,
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

  /** Fetch the commit with this computer's GitHub login, check it out in its own worktree and start the suite. */
  private async launch(meta: RunMeta) {
    const clone = join(this.root, 'git', ...meta.repository.split('/'))
    if (!existsSync(join(clone, '.git'))) {
      await mkdir(join(clone, '..'), { recursive: true, mode: 0o700 })
      await this.git(['clone', '--quiet', '--no-checkout', `https://github.com/${meta.repository}.git`, clone])
    }
    if ((await this.ports.run('git', ['cat-file', '-e', `${meta.commit}^{commit}`], { cwd: clone, env: this.environment })).code !== 0) {
      await this.git(['fetch', '--quiet', '--no-tags', 'origin', meta.commit], clone)
    }
    const source = join(this.runDirectory(meta.runId), 'src')
    await this.git(['worktree', 'prune'], clone)
    await this.git(['worktree', 'add', '--quiet', '--detach', source, meta.commit], clone)
    await this.selectFiles(meta, source)
    const script = await this.script(meta, source)
    await writeFile(join(this.runDirectory(meta.runId), 'run.sh'), script, { mode: 0o700 })
    const reserve = Math.max(2 ** 30, this.ports.memoryBytes * 0.1)
    const environment = ['PATH', 'HOME', 'USER', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
      .flatMap(key => this.environment[key] ? [`--setenv=${key}=${this.environment[key]}`] : [])
    const started = await this.ports.run('systemd-run', ['--user', '--quiet', '--collect', `--unit=${unitName(meta.runId)}`,
      `--property=MemoryMax=${Math.floor(this.ports.memoryBytes - reserve)}`, `--property=CPUQuota=${this.ports.cpus * 100}%`,
      // Desktop sessions default to umask 0002; suites expect the 0022 every cloud CI runner uses.
      '--property=UMask=0022', `--working-directory=${source}`, ...environment, '/bin/bash', join(this.runDirectory(meta.runId), 'run.sh')],
    { env: this.environment, timeoutMs: 30_000 })
    if (started.code !== 0) throw new Error(`The CI unit could not start: ${started.stderr.trim().slice(0, 500)}`)
    await this.writeMeta({ ...meta, state: 'running' })
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
      if (meta.partition || affected) {
        const tests = join(source, 'apps/api/test')
        const files = existsSync(tests) ? (await readdir(tests)).filter(file => file.endsWith('.integration.test.ts'))
          .map(file => `apps/api/test/${file}`).sort() : []
        const selected = affected ? meta.files ?? [] : files
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
      // The repository's own integration runner sizes its shards to this computer.
      // Compiled test modules outlive the run's worktree, so the next run on this computer starts warm.
      `export TMPDIR=${quote(join(run, 'tmp'))} CI=true NODE_OPTIONS=--max-old-space-size=6144`
        + (capabilities.parts ? ` CI_HOST_RUNNER=1 FOREMAN_CODE_CI_DEDICATED=1`
          + ` FOREMAN_CODE_VITEST_CACHE=${quote(join(this.root, 'vitest-cache'))}` : '') + integrationEnvironment,
      'mkdir -p "$TMPDIR"',
      `finish() { echo "$1" > ${quote(join(run, 'exit'))}; exit "$1"; }`,
      `step() { echo "$1" > ${quote(join(run, 'step'))}; echo "::step $1"; }`,
      ...(meta.message ? [`echo ${quote(meta.message)}`] : []),
      'step install', `${pm} install${existsSync(join(source, 'pnpm-lock.yaml')) ? ' --frozen-lockfile' : ''} || finish $?`,
      ...(command ? [`step ${meta.part ?? meta.suite}`,
        ...(command !== 'true' && capabilities.parts
          ? [`SUITE=${quote(prerequisiteSuite)} bash scripts/ci-suite.sh prepare || finish $?`] : []),
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

  /** Reads the current state of a run, settling it once its unit has exited, and frees its worktree. */
  async refresh(runId: string): Promise<CiHostRun> {
    // Launch can finish while the metadata read is awaiting I/O.
    const preparing = this.preparing.has(runId) || this.startingRunId === runId
    let meta = await this.readMeta(runId)
    const directory = this.runDirectory(runId)
    if (meta.state === 'running') {
      const exit = await readFile(join(directory, 'exit'), 'utf8').catch(() => null)
      if (exit !== null) {
        const code = Number(exit.trim())
        await this.finish(runId, code === 0 ? 'passed' : 'failed', Number.isInteger(code) ? code : 1, meta.message)
      } else {
        const unit = await this.ports.run('systemctl', ['--user', 'is-active', `${unitName(runId)}.service`], { env: this.environment })
        if (!['active', 'activating'].includes(unit.stdout.trim())) {
          // The unit is gone without recording an exit: it was stopped or the computer restarted.
          await this.finish(runId, 'lost', null, 'The CI unit ended without an exit status.')
        }
      }
    } else if (meta.state === 'starting' && !preparing) {
      await this.finish(runId, 'lost', null, 'The Worker restarted while preparing this run.')
    }
    meta = await this.readMeta(runId)
    if (!['starting', 'running'].includes(meta.state) && !meta.cleaned) {
      const clone = join(this.root, 'git', ...meta.repository.split('/'))
      if (existsSync(join(directory, 'src'))) {
        await this.ports.run('git', ['worktree', 'remove', '--force', join(directory, 'src')], { cwd: clone, env: this.environment })
        await rm(join(directory, 'src'), { recursive: true, force: true })
      }
      await rm(join(directory, 'tmp'), { recursive: true, force: true })
      meta = { ...meta, cleaned: true }
      await this.writeMeta(meta)
    }
    const log = await stat(join(directory, 'log')).catch(() => null)
    const step = (await readFile(join(directory, 'step'), 'utf8').catch(() => '')).trim() || null
    return { runId, state: meta.state, step, exitCode: meta.exitCode, startedAt: meta.startedAt,
      finishedAt: meta.finishedAt, logBytes: log?.size ?? 0, message: meta.message }
  }

  async cancel(runId: string): Promise<CiHostRun> {
    const meta = await this.readMeta(runId)
    if (['starting', 'running'].includes(meta.state)) {
      await this.ports.run('systemctl', ['--user', 'stop', `${unitName(runId)}.service`], { env: this.environment })
      await this.finish(runId, 'canceled', null, 'Canceled.')
    }
    return this.refresh(runId)
  }
}
