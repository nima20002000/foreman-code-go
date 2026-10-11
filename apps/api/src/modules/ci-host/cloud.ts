import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { CiDurationsSchema, CiHostReplySchema, CiHostRequestSchema, WorkspaceSchema, integrationPartition,
  type CiDurations, type CiHostReply, type CiHostRequest, type CiHostRun, type CiPartition, type CiSuite, type CiPart, type CiScope } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import { ensureClone, fetchRepositoryBranch, systemGitWorktreePorts, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { systemHostCiPorts, type HostCiPorts } from './runner.js'
import type { HostCiComputer } from './service.js'
import { CircleCiProvider, GitHubActionsProvider, type CloudDispatchInput, type CloudProvider } from './cloudProviders.js'

const LOG_LIMIT = 4 * 1024 * 1024
const START_TIMEOUT_MS = 75_000
const MAX_DISPATCH_ATTEMPTS = 3
const log = componentLogger('jobs')

export interface CloudRun {
  runId: string; repository: string; mirror: string; commit: string; suite: CiSuite; startedAt: string
  providerRunId: string | null; state: CiHostRun['state']; finishedAt: string | null; exitCode: number | null
  message: string | null; durations?: CiDurations
  scope?: CiScope; files?: string[]; part?: CiPart
  dispatch?: { input: CloudDispatchInput; attempts: number; at: string }
  workflowStarted?: boolean
}
type Mirrors = (repository: string) => Promise<string | null>

/** The public mirror configured for a private repository's workspace, if any. */
export function workspaceMirrors(pool: pg.Pool): Mirrors {
  return async repository => {
    const [owner, name] = repository.split('/')
    const row = (await pool.query<{ record: unknown }>(`select record from workspaces where archived_at is null
      and record->'repository'->>'owner'=$1 and record->'repository'->>'name'=$2 and record ? 'ciMirror'
      order by id limit 1`, [owner, name])).rows[0]
    const mirror = row ? WorkspaceSchema.parse(row.record).ciMirror : undefined
    return mirror ? `${mirror.owner}/${mirror.name}` : null
  }
}

/** A cloud CI service on a workspace's public mirror as CI computers: one slot per concurrent job. A run pushes the
 * commit's files to the mirror as one commit without history, starts the provider's run of them, and reads the
 * result, log and measured durations back. */
export class CloudCi {
  private checked: { at: number; ready: boolean } | undefined
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly published = new Map<string, Promise<{
    git: (args: string[]) => Promise<string>; branch: string; defaultBranch?: string
  }>>()

  constructor(private readonly mainId: string, readonly provider: CloudProvider, private readonly mirrors: Mirrors,
    private readonly root = join(homedir(), '.local/share/foreman-code/ci-cloud', provider.id),
    private readonly ports: HostCiPorts = systemHostCiPorts(),
    private readonly git: GitWorktreePorts = systemGitWorktreePorts(),
    private readonly identity = { home: homedir(), user: userInfo().username, host: hostname() }) {}

  computers(priority = 30): HostCiComputer[] {
    return Array.from({ length: this.provider.slots }, (_, slot) => ({ key: `${this.mainId}:cloud:${this.provider.id}:${slot}`,
      hostRef: { kind: 'cloud' as const, mainId: this.mainId, provider: this.provider.id, slot },
      label: `${this.provider.label} ${slot + 1}`, priority }))
  }

  async handle(raw: unknown): Promise<CiHostReply> {
    const request = CiHostRequestSchema.parse(raw)
    if (request.operation === 'status') {
      const ready = await this.ready()
      return CiHostReplySchema.parse({ operation: 'status', ready, reasons: ready ? [] : [this.provider.loginHint],
        cpuCount: this.provider.cpus, memoryBytes: this.provider.memoryBytes, runs: [] })
    }
    const previous = this.operations.get(request.runId) ?? Promise.resolve()
    // A previous failure belongs to its caller and must not block the next read or cancellation.
    const operation = previous.then(() => this.handleRun(request), () => this.handleRun(request))
    this.operations.set(request.runId, operation)
    try {
      return await operation
    } finally {
      if (this.operations.get(request.runId) === operation) this.operations.delete(request.runId)
    }
  }

  private async handleRun(request: Exclude<CiHostRequest, { operation: 'status' }>) {
    if (request.operation === 'start') return CiHostReplySchema.parse({ operation: 'start', run: await this.start(request) })
    if (request.operation === 'cancel') {
      let run = await this.read(request.runId)
      if (!run.providerRunId && run.state === 'starting') {
        run = { ...run, providerRunId: await this.provider.find(run) }
      }
      if (run.providerRunId && ['starting', 'running'].includes(run.state)) await this.provider.cancel(run)
      const canceled = ['queued', 'starting', 'running'].includes(run.state)
        ? await this.save({ ...run, state: 'canceled', finishedAt: this.ports.now().toISOString(), message: 'Canceled.' }) : run
      return CiHostReplySchema.parse({ operation: 'cancel', run: this.view(canceled, 0) })
    }
    const run = await this.refresh(request.runId)
    const log = await readFile(this.path(run.runId, 'log')).catch(() => Buffer.alloc(0))
    const text = log.subarray(request.afterOffset, request.afterOffset + request.maxBytes)
    return CiHostReplySchema.parse({ operation: 'read', run: this.view(run, log.length), text: text.toString('utf8'),
      nextOffset: request.afterOffset + text.length,
      ...(request.durations && run.durations ? { durations: run.durations } : {}) })
  }

  /** Main's login for the service works; checked at most once a minute. */
  async ready() {
    if (this.checked && Date.now() - this.checked.at < 60_000) return this.checked.ready
    const ready = await this.provider.ready().catch(() => false)
    this.checked = { at: Date.now(), ready }
    return ready
  }

  private path(runId: string, name: 'meta.json' | 'log') { return join(this.root, 'runs', runId, name) }

  private async read(runId: string): Promise<CloudRun> {
    try { return JSON.parse(await readFile(this.path(runId, 'meta.json'), 'utf8')) as CloudRun }
    catch { throw new DomainError('CI_RUN_UNKNOWN', `${this.provider.label} has no such CI run.`, 404) }
  }

  private async save(run: CloudRun) {
    await mkdir(join(this.root, 'runs', run.runId), { recursive: true, mode: 0o700 })
    await writeFile(this.path(run.runId, 'meta.json'), JSON.stringify(run), { mode: 0o600 })
    return run
  }

  private view(run: CloudRun, logBytes: number): CiHostRun {
    let step: string | null = run.part ?? run.suite
    if (run.state === 'starting') step = 'dispatch'
    if (run.state === 'queued') step = null
    return { runId: run.runId, state: run.state, step,
      exitCode: run.exitCode, startedAt: run.startedAt, finishedAt: run.finishedAt, logBytes, message: run.message }
  }

  private async start(request: { runId: string; repository: string; commit: string; suite: CiSuite
    part?: CiPart | undefined; partition?: CiPartition | undefined; durations?: CiDurations | undefined; scope?: CiScope | undefined;
    files?: string[] | undefined; defaultBranch?: string | undefined }): Promise<CiHostRun> {
    const existing = await this.read(request.runId).catch(() => null)
    if (existing) return this.view(existing, 0)
    const mirror = await this.mirrors(request.repository)
    // CircleCI's machine image has no podman, which the Worker and check suites use; it takes integration work only.
    if (this.provider.id === 'circleci' && request.suite !== 'integration') {
      throw new DomainError('CI_CLOUD_UNAVAILABLE', `${this.provider.label} runs integration partitions only.`, 409)
    }
    if (!mirror || !await this.ready()) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE', `This workspace has no CI mirror, or Main is not logged in to ${this.provider.label}.`, 409)
    }
    const scope = request.scope ?? 'affected'
    const deriveFiles = scope === 'affected' && request.files === undefined
    const { git, branch, defaultBranch } = await this.publish(request.repository, mirror, request.commit,
      deriveFiles ? request.defaultBranch ?? 'main' : undefined)
    const selectOnRunner = deriveFiles && defaultBranch !== undefined
    const message = deriveFiles && !selectOnRunner
      ? 'Running full suite: No merge-base with the workspace default branch is available.' : null
    let slice = request.suite === 'integration' && !selectOnRunner && (request.partition || !deriveFiles && scope === 'affected')
      ? await this.slice(git, request.commit, request.partition, request.durations ?? {}, request.files) : ''
    if ((!request.files || scope !== 'affected') && request.partition && request.part) {
      slice = `${request.partition.index + 1}/${request.partition.count}`
    }
    const files = scope === 'affected' && request.files !== undefined && request.suite !== 'integration'
      ? await this.selectedIndexes(git, request.commit, request.files) : undefined
    let run = await this.save({ runId: request.runId, repository: request.repository, mirror, commit: request.commit,
      suite: request.suite, ...(request.part ? { part: request.part } : {}), startedAt: this.ports.now().toISOString(), providerRunId: null, state: 'starting',
      scope, ...(request.files !== undefined ? { files: request.files } : {}),
      finishedAt: null, exitCode: null, message })
    const input: CloudDispatchInput = { mirror, branch, runId: request.runId, suite: request.part ?? request.suite, slice,
      scope: message ? 'full' : scope, ...(files !== undefined ? { files } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(selectOnRunner && request.partition ? { partition: JSON.stringify(request.partition) } : {}),
      ...(selectOnRunner && request.durations ? { durations: JSON.stringify(request.durations) } : {}) }
    run = await this.trigger(run, input)
    if (run.providerRunId) {
      try {
        if (await this.provider.find(run)) run = await this.save({ ...run, state: 'running', workflowStarted: true })
      } catch (error) {
        // The trigger was accepted, so a lookup failure must not dispatch the ticket to another computer.
        log.warn({ err: error, runId: run.runId }, 'Cloud CI workflow lookup failed; dispatch remains pending')
      }
    }
    return this.view(run, 0)
  }

  private async trigger(run: CloudRun, input: CloudDispatchInput) {
    const pending = await this.save({ ...run, state: 'starting', providerRunId: null,
      dispatch: { input, attempts: (run.dispatch?.attempts ?? 0) + 1, at: this.ports.now().toISOString() } })
    const providerRunId = await this.provider.dispatch(input)
    return this.save({ ...pending, providerRunId })
  }

  private async recoverUnstarted(run: CloudRun) {
    const dispatchedAt = run.dispatch?.at ?? run.startedAt
    if (this.ports.now().getTime() - Date.parse(dispatchedAt) < START_TIMEOUT_MS) return run
    // Retire the pipeline before retrying so it cannot acquire a workflow later.
    if (run.providerRunId) {
      await this.provider.cancel(run)
      if (await this.provider.find(run)) return this.save({ ...run, state: 'running', workflowStarted: true })
    }
    const retry = run.dispatch && run.dispatch.attempts < MAX_DISPATCH_ATTEMPTS
    const message = `${this.provider.label} created no workflow within 75 seconds. `
      + (retry ? `Retrying dispatch (${run.dispatch!.attempts + 1}/${MAX_DISPATCH_ATTEMPTS}).`
        : 'Dispatch retries exhausted; queued for another computer.')
    await writeFile(this.path(run.runId, 'log'), `${message}\n`, { flag: 'a', mode: 0o600 })
    const next = await this.save({ ...run, message })
    if (retry) return this.trigger(next, run.dispatch!.input)
    return this.save({ ...next, state: 'queued', providerRunId: null, finishedAt: null, exitCode: null })
  }

  /** Puts the commit's files on the mirror once: every partition of a run starting together shares one push. */
  private publish(repository: string, mirror: string, commit: string, defaultBranch?: string) {
    const key = `${mirror}\n${commit}\n${defaultBranch ?? ''}`
    let published = this.published.get(key)
    if (!published) {
      published = this.push(repository, mirror, commit, defaultBranch)
      this.published.set(key, published)
      // A failed push is retried by the next start; a done one is kept for the run's later partitions.
      published.catch(() => { this.published.delete(key) })
      if (this.published.size > 50) this.published.delete(this.published.keys().next().value!)
    }
    return published
  }

  private async push(repository: string, mirror: string, commit: string, defaultBranch?: string) {
    const signal = AbortSignal.timeout(600_000)
    const clone = await ensureClone(this.git, repository, signal)
    const git = async (args: string[], env?: Record<string, string>) => {
      const result = await this.git.git(args, { cwd: clone, signal: AbortSignal.timeout(600_000), ...(env ? { env } : {}) })
      if (result.code !== 0) throw new DomainError('CI_CLOUD_FAILED', `git ${args[0]} failed for the CI mirror.`, 502)
      return result.stdout.trim()
    }
    const base = `refs/foreman/mirror/${mirror}`
    await git(['fetch', '--quiet', '--no-tags', `https://github.com/${mirror}.git`, `+main:${base}`])
    const workflow = this.provider.id === 'github' ? '.github/workflows/ci.yml' : '.circleci/config.yml'
    const workflows = ['.github/workflows/ci.yml', '.circleci/config.yml']
    const entries = (await git(['ls-tree', base, '--', ...workflows])).split('\n')
      .filter(entry => /^100[0-7]{3} blob [a-f0-9]+\t/.test(entry))
    if (!entries.some(entry => entry.endsWith(`\t${workflow}`))) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE',
        `The CI mirror has no ${workflow} workflow for ${this.provider.label}. Use a build computer or configure the mirror.`, 409)
    }
    await this.guard(clone, commit, signal)
    // A source without the mirror's provider workflows gets the mirror's copies.
    const treeOf = async (source: string) => {
      const sourceWorkflows = new Set((await git(['ls-tree', source, '--', ...workflows])).split('\n')
        .map(entry => entry.split('\t')[1]))
      const missing = entries.filter(entry => !sourceWorkflows.has(entry.split('\t')[1]))
      if (!missing.length) return `${source}^{tree}`
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const directory = await mkdtemp(join(this.root, 'snapshot-'))
      try {
        const env = { GIT_INDEX_FILE: join(directory, 'index') }
        await git(['read-tree', source], env)
        for (const entry of missing) {
          const [mode, , blob, path] = entry.split(/\s+/)
          await git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], env)
        }
        return await git(['write-tree'], env)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
    // The same commit always yields the same snapshot, so every partition of a run shares one mirror branch.
    const date = await git(['show', '-s', '--format=%cI', commit])
    const author = { GIT_AUTHOR_NAME: mirror.split('/')[0]!, GIT_AUTHOR_EMAIL: `${mirror.split('/')[0]}@users.noreply.github.com`,
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    const identity = { ...author, GIT_COMMITTER_NAME: author.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: author.GIT_AUTHOR_EMAIL }
    const snapshotOf = async (source: string, parent: string) => git([
      'commit-tree', await treeOf(source), '-p', parent, '-m', `Snapshot ${source.slice(0, 12)}`,
    ], identity)
    let parent = base
    let comparison: { branch: string; commit: string } | undefined
    let head: string | undefined
    if (defaultBranch) {
      head = await fetchRepositoryBranch(this.git, clone, repository, defaultBranch, signal)
      const mergeBase = await this.git.git(['merge-base', commit, head], { cwd: clone, signal })
      if (mergeBase.code === 0) {
        const sourceBase = mergeBase.stdout.trim()
        // Publish only checked trees; the source repository's private commit history stays private.
        await this.guard(clone, sourceBase, signal)
        await this.guard(clone, head, signal)
        parent = await snapshotOf(sourceBase, base)
        comparison = { branch: `ci-default/${commit}`, commit: await snapshotOf(head, parent) }
      }
    }
    const snapshot = commit === head && comparison ? comparison.commit : await snapshotOf(commit, parent)
    const branch = `ci/${commit}`
    // GitHub runs start from main, whose cache scope every run shares, and check out the commit's branch.
    await git(['push', '--quiet', '--force', `https://github.com/${mirror}.git`, `${snapshot}:refs/heads/${branch}`,
      `${snapshot}:refs/heads/main`, ...(comparison ? [`${comparison.commit}:refs/heads/${comparison.branch}`] : [])])
    return { git, branch, ...(comparison ? { defaultBranch: comparison.branch } : {}) }
  }

  /** The same duration-balanced slice a build computer would run, from the commit's own files and durations, as
   * indexes into the commit's sorted integration files (scripts/ci-files.mjs), so it fits a short CI parameter. */
  private async slice(git: (args: string[]) => Promise<string>, commit: string, partition: CiPartition | undefined,
    learned: CiDurations, selected?: string[]) {
    const files = (await git(['ls-tree', '--name-only', `${commit}:apps/api/test`])).split('\n')
      .filter(name => name.endsWith('.integration.test.ts')).map(name => `apps/api/test/${name}`).sort()
    const committed = await git(['show', `${commit}:scripts/integration-durations.json`])
      .then(text => JSON.parse(text) as Record<string, number>, () => ({}))
    if (selected?.some(file => !files.includes(file))) {
      throw new DomainError('CI_CLOUD_FAILED', 'Selected integration files are absent from the commit.', 409)
    }
    const candidates = selected ?? files
    const slice = new Set<string>(partition ? integrationPartition(candidates, { ...committed, ...learned }, partition) : candidates)
    if (!slice.size) throw new DomainError('CI_CLOUD_FAILED', 'This partition has no integration files.', 409)
    return this.indexSpec(files, slice)
  }

  private async selectedIndexes(git: (args: string[]) => Promise<string>, commit: string, selected: string[]) {
    const files = (await git(['ls-tree', '-r', '--name-only', commit])).split('\n').sort()
    if (selected.some(file => !files.includes(file))) {
      throw new DomainError('CI_CLOUD_FAILED', 'Selected files are absent from the commit.', 409)
    }
    return this.indexSpec(files, new Set(selected))
  }

  private indexSpec(files: string[], selected: Set<string>) {
    const indexes = files.flatMap((file, index) => selected.has(file) ? [index] : [])
    const ranges: string[] = []
    for (let start = 0; start < indexes.length;) {
      let end = start
      while (end + 1 < indexes.length && indexes[end + 1] === indexes[end]! + 1) end++
      ranges.push(start === end ? `${indexes[start]}` : `${indexes[start]}-${indexes[end]}`)
      start = end + 1
    }
    return `s:${ranges.join(',')}`
  }

  /** Refuses to publish files that name this fleet: Main's home path and user, and every Tailscale computer's
   * name, address and tailnet domain. Only the commit's files are published, so only they are checked. */
  private async guard(clone: string, commit: string, signal: AbortSignal) {
    const fixed = new Set<string>([this.identity.home]), words = new Set<string>([this.identity.user])
    const word = (value: string) => { const first = value.toLowerCase().split(/[^a-z0-9]/)[0] ?? ''; if (first.length >= 3) words.add(first) }
    word(this.identity.host)
    const status = await this.ports.run('tailscale', ['status', '--json'], { timeoutMs: 15_000 }).catch(() => null)
    if (status?.code === 0) {
      const parsed = JSON.parse(status.stdout) as { Self?: Peer; Peer?: Record<string, Peer>; MagicDNSSuffix?: string
        User?: Record<string, { LoginName?: string }> }
      for (const peer of [parsed.Self, ...Object.values(parsed.Peer ?? {})]) {
        if (!peer) continue
        for (const address of peer.TailscaleIPs ?? []) if (address.includes('.')) fixed.add(address)
        if (peer.HostName) { fixed.add(peer.HostName); word(peer.HostName) }
      }
      if (parsed.MagicDNSSuffix) fixed.add(parsed.MagicDNSSuffix)
      for (const user of Object.values(parsed.User ?? {})) if (user.LoginName?.includes('@')) fixed.add(user.LoginName)
    }
    const found: string[] = []
    for (const [mode, values] of [[['-F'], fixed], [['-w', '-F'], words]] as const) {
      const patterns = [...values].filter(value => value.length >= 3).flatMap(value => ['-e', value])
      if (!patterns.length) continue
      const result = await this.git.git(['grep', '-I', '-n', '-i', '--no-color', ...mode, ...patterns, commit, '--'],
        { cwd: clone, signal })
      if (result.code > 1) throw new DomainError('CI_CLOUD_FAILED', 'Main could not check the files for the CI mirror.', 502)
      found.push(...result.stdout.split('\n').filter(Boolean).map(line => line.split(':').slice(1, 3).join(':')))
    }
    if (found.length) {
      throw new DomainError('CI_MIRROR_PRIVATE_DATA', `Not published to the public CI mirror: ${found.slice(0, 10).join(', ')}`
        + `${found.length > 10 ? ` and ${found.length - 10} more` : ''} name this computer fleet (home path, user or computer `
        + 'name, Tailscale address or domain). Replace them with examples.', 409)
    }
  }

  /** Follows the provider's run; once it finishes, keeps its log and measured durations. */
  private async refresh(runId: string): Promise<CloudRun> {
    let run = await this.read(runId)
    if (!['starting', 'running'].includes(run.state)) return run
    if (run.state === 'starting' || !run.providerRunId || !run.workflowStarted && this.provider.id === 'circleci') {
      const providerRunId = await this.provider.find(run)
      if (!providerRunId) {
        return this.recoverUnstarted(run)
      }
      run = await this.save({ ...run, providerRunId, state: 'running', workflowStarted: true })
    } else if (this.provider.id === 'github' && (run.dispatch?.attempts ?? 0) > 1) {
      // A delayed workflow from an earlier dispatch can appear after its replacement.
      await this.provider.find(run)
    }
    const status = await this.provider.status(run)
    if (!status.done) return run
    await writeFile(this.path(runId, 'log'), Buffer.from(await this.provider.log(run).catch(() => '')).subarray(-LOG_LIMIT),
      { flag: 'a', mode: 0o600 })
    let durations: CiDurations | undefined
    if (run.suite === 'integration' || run.part === 'unit-api' || run.part === 'unit-web') {
      const parsed = CiDurationsSchema.safeParse(await this.provider.durations(run, join(this.root, 'runs', runId, 'artifact'))
        .catch(() => null))
      if (parsed.success) durations = parsed.data
    }
    const passed = status.conclusion === 'success'
    return this.save({ ...run, state: passed ? 'passed' : status.conclusion === 'cancelled' ? 'canceled' : 'failed',
      exitCode: passed ? 0 : 1, finishedAt: status.finishedAt,
      message: passed ? run.message : [run.message, `${this.provider.label}: ${status.conclusion}.`].filter(Boolean).join(' '),
      ...(durations ? { durations } : {}) })
  }
}

/** GitHub Actions and CircleCI on the same public mirror. */
export function cloudCis(mainId: string, mirrors: Mirrors, ports: HostCiPorts = systemHostCiPorts()): CloudCi[] {
  return [new CloudCi(mainId, new GitHubActionsProvider(ports), mirrors), new CloudCi(mainId, new CircleCiProvider(ports), mirrors)]
}

interface Peer { HostName?: string; TailscaleIPs?: string[] }
