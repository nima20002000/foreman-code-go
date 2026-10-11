import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { availableParallelism, homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import { CiDurationsSchema, CiHostReplySchema, CiHostRequestSchema, integrationPartition,
  type CiDurations, type CiHostReply, type CiHostRun, type CiSuite, type CiPartition, type CiScope } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'

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
  scope?: CiScope; files?: string[]
}

const unitName = (runId: string) => `foreman-ci-${runId}`
// GitHub CLI's own credential helper: a computer that is logged in to gh fetches without any app setup.
const gitAuth = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']

/** Runs CI suites directly on this computer, like a self-hosted runner. One run at a time; each run is a transient
 * systemd user service, so it outlives a Worker restart, and its CPU and memory stay below the host reserve. */
export class HostCiRunner {
  private readonly preparing = new Map<string, Promise<void>>()
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
    // A finished integration run reports the file durations it measured, so Main can learn them.
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
    await writeFile(join(this.runDirectory(meta.runId), 'meta.json'), JSON.stringify(meta), { mode: 0o600 })
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
    const directory = join(this.root, 'runs')
    if (!existsSync(directory)) return null
    for (const runId of await readdir(directory)) {
      const run = await this.refresh(runId).catch(() => null)
      if (run && ['starting', 'running'].includes(run.state)) return runId
    }
    return null
  }

  private async start(request: { runId: string; repository: string; commit: string; suite: CiSuite
    partition?: CiPartition | undefined; durations?: CiDurations | undefined; scope?: CiScope | undefined; files?: string[] | undefined }) {
    const directory = this.runDirectory(request.runId)
    if (existsSync(join(directory, 'meta.json'))) return this.refresh(request.runId)
    const busy = await this.active()
    if (busy) throw new DomainError('CI_HOST_BUSY', 'This computer is already running a CI suite.', 409)
    const github = await this.github()
    if (!github.ready) throw new DomainError('COMPUTER_GITHUB_REQUIRED', github.reason!, 409)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const meta: RunMeta = { runId: request.runId, repository: request.repository, commit: request.commit,
      suite: request.suite, partition: request.partition ?? null, startedAt: this.ports.now().toISOString(),
      state: 'starting', finishedAt: null, exitCode: null, message: null, cleaned: false,
      scope: request.scope ?? 'full', files: request.files ?? [],
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
    const script = await this.script(meta, source)
    await writeFile(join(this.runDirectory(meta.runId), 'run.sh'), script, { mode: 0o700 })
    const reserve = Math.max(2 ** 30, this.ports.memoryBytes * 0.1)
    const environment = ['PATH', 'HOME', 'USER', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
      .flatMap(key => this.environment[key] ? [`--setenv=${key}=${this.environment[key]}`] : [])
    const started = await this.ports.run('systemd-run', ['--user', '--quiet', '--collect', `--unit=${unitName(meta.runId)}`,
      `--property=MemoryMax=${Math.floor(this.ports.memoryBytes - reserve)}`, `--property=CPUQuota=${this.ports.cpus * 100}%`,
      `--working-directory=${source}`, ...environment, '/bin/bash', join(this.runDirectory(meta.runId), 'run.sh')],
    { env: this.environment, timeoutMs: 30_000 })
    if (started.code !== 0) throw new Error(`The CI unit could not start: ${started.stderr.trim().slice(0, 500)}`)
    await this.writeMeta({ ...meta, state: 'running' })
  }

  private async script(meta: RunMeta, source: string) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    const scripts = manifest.scripts ?? {}
    const suiteScript: Record<CiSuite, string | null> = { install: null, typecheck: 'typecheck', lint: 'lint',
      unit: 'test', build: 'build', integration: 'test:integration' }
    const name = suiteScript[meta.suite]
    if (name && !scripts[name]) throw new Error(`The repository has no "${name}" script for the ${meta.suite} suite.`)
    let command = name ? `corepack pnpm ${name}` : ''
    if (meta.scope === 'affected' && meta.suite !== 'integration') {
      const selectedPath = join(this.runDirectory(meta.runId), 'selected-files.json')
      await writeFile(selectedPath, JSON.stringify(meta.files ?? []), { mode: 0o600 })
      command = `node scripts/ci-affected-run.mjs ${meta.suite} --files-from ${quote(selectedPath)}`
    }
    const run = this.runDirectory(meta.runId)
    let integrationEnvironment = ''
    if (meta.suite === 'integration') {
      // Main's learned durations, with the commit's committed ones for files it has not measured yet.
      const durationsPath = join(source, 'scripts/integration-durations.json')
      const committed = existsSync(durationsPath) ? JSON.parse(await readFile(durationsPath, 'utf8')) as Record<string, number> : {}
      const durations = { ...committed, ...meta.durations }
      await writeFile(join(run, 'expected-durations.json'), JSON.stringify(durations), { mode: 0o600 })
      // The repository's integration runner uses them for per-file hang deadlines and reports what it measured.
      integrationEnvironment = ` FOREMAN_CODE_INTEGRATION_DURATIONS=${quote(join(run, 'expected-durations.json'))}`
        + ` FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT=${quote(join(run, 'measured-durations.json'))}`
      if (meta.partition || meta.scope === 'affected') {
        const tests = join(source, 'apps/api/test')
        const files = existsSync(tests) ? (await readdir(tests)).filter(file => file.endsWith('.integration.test.ts'))
          .map(file => `apps/api/test/${file}`).sort() : []
        const selected = meta.scope === 'affected' ? meta.files ?? [] : files
        if (selected.some(file => !files.includes(file))) throw new Error('Selected integration files are absent from the commit.')
        const slice = meta.partition ? integrationPartition(selected, durations, meta.partition) : selected
        if (!slice.length && meta.partition) throw new Error('This partition has no integration files.')
        command = slice.length ? `${command} --files ${slice.map(quote).join(' ')}` : 'true'
      }
      if (scripts['db:up']) command = `corepack pnpm db:up && ${command}`
    }
    return ['#!/bin/bash', 'set -o pipefail', `exec >>${quote(join(run, 'log'))} 2>&1`,
      // The repository's own integration runner sizes its shards to this computer.
      // Compiled test modules outlive the run's worktree, so the next run on this computer starts warm.
      `export TMPDIR=${quote(join(run, 'tmp'))} CI=true FOREMAN_CODE_CI_DEDICATED=1 NODE_OPTIONS=--max-old-space-size=6144`
        + ` FOREMAN_CODE_VITEST_CACHE=${quote(join(this.root, 'vitest-cache'))}${integrationEnvironment}`,
      'mkdir -p "$TMPDIR"',
      `finish() { echo "$1" > ${quote(join(run, 'exit'))}; exit "$1"; }`,
      `step() { echo "$1" > ${quote(join(run, 'step'))}; echo "::step $1"; }`,
      'step install', 'corepack pnpm install --frozen-lockfile || finish $?',
      ...(command ? [`step ${meta.suite}`, `${command} || finish $?`] : []),
      'finish 0', ''].join('\n')
  }

  private async finish(runId: string, state: CiHostRun['state'], exitCode: number | null, message: string | null) {
    const meta = await this.readMeta(runId)
    if (!['starting', 'running'].includes(meta.state)) return
    await this.writeMeta({ ...meta, state, exitCode, message, finishedAt: this.ports.now().toISOString() })
  }

  /** Reads the current state of a run, settling it once its unit has exited, and frees its worktree. */
  async refresh(runId: string): Promise<CiHostRun> {
    let meta = await this.readMeta(runId)
    const directory = this.runDirectory(runId)
    if (meta.state === 'running') {
      const exit = await readFile(join(directory, 'exit'), 'utf8').catch(() => null)
      if (exit !== null) {
        const code = Number(exit.trim())
        await this.finish(runId, code === 0 ? 'passed' : 'failed', Number.isInteger(code) ? code : 1, null)
      } else {
        const unit = await this.ports.run('systemctl', ['--user', 'is-active', `${unitName(runId)}.service`], { env: this.environment })
        if (!['active', 'activating'].includes(unit.stdout.trim())) {
          // The unit is gone without recording an exit: it was stopped or the computer restarted.
          await this.finish(runId, 'lost', null, 'The CI unit ended without an exit status.')
        }
      }
    } else if (meta.state === 'starting' && !this.preparing.has(runId)) {
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
