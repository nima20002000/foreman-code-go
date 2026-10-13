import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { CiWatchdogFailureSchema, CiDurationsSchema, CiHostReplySchema, CiHostRequestSchema, CiTestResultsSchema, WorkspaceSchema,
  integrationPartition, requiresUserSystemd,
  type CiDurations, type CiTestResults, type CiHostReply, type CiHostRequest, type CiHostRun, type CiPartition, type CiSuite, type CiPart, type CiScope } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import { ensureClone, fetchRepositoryBranch, systemGitWorktreePorts, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { systemHostCiPorts, type HostCiPorts } from './runner.js'
import type { HostCiComputer } from './service.js'
import { CLOUD_START_TIMEOUT_MS, CircleCiProvider, GitHubActionsProvider,
  type CloudDispatchInput, type CloudProvider, type CloudRun, type CloudStatus } from './cloudProviders.js'
import { runsOnCircleCi } from './parts.js'
import { fallbackOnError } from '../diagnostics/ignoredError.js'

const LOG_LIMIT = 4 * 1024 * 1024
const MAX_DISPATCH_ATTEMPTS = 3
/** A running run asks its service at most this often; reads in between answer from the kept state and log. */
const POLL_MS = 4_000
const MAX_BACKOFF_MS = 10 * 60_000
/** Provider CLI polls run on Main, which also runs Agents: at most this many follow runs at once per service. */
const POLL_CONCURRENCY = 3
const log = componentLogger('jobs')

export type { CloudRun }
type Mirrors = (repository: string) => Promise<string | null>
/** Pushes to one mirror, across both services, run one at a time: concurrent force-pushes of the mirror's main fail
 * the remote's old-value check ("incorrect old value provided"), and concurrent fetches race on its local ref. */
const mirrorPushes = new Map<string, Promise<unknown>>()

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
  private readonly polled = new Map<string, number>()
  private backoff = { until: 0, ms: 0 }
  private following = 0
  private readonly waiting: (() => void)[] = []
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly reading = new Set<string>()
  private readonly published = new Map<string, Promise<{
    git: (args: string[]) => Promise<string>; branch: string; defaultBranch?: string; baseCommit?: string
  }>>()

  constructor(private readonly mainId: string, readonly provider: CloudProvider, private readonly mirrors: Mirrors,
    private readonly root = join(homedir(), '.local/share/foreman-code/ci-cloud', provider.id),
    private readonly ports: HostCiPorts = systemHostCiPorts(),
    private readonly git: GitWorktreePorts = systemGitWorktreePorts(),
    private readonly identity = { home: homedir(), user: userInfo().username, host: hostname() }) {}

  computers(priority = 30): HostCiComputer[] {
    return Array.from({ length: this.provider.slots }, (_, slot) => ({ key: `${this.mainId}:cloud:${this.provider.id}:${slot}`,
      hostRef: { kind: 'cloud' as const, mainId: this.mainId, provider: this.provider.id, slot },
      label: `${this.provider.label} ${slot + 1}`, priority, userSystemd: this.provider.userSystemd }))
  }

  async handle(raw: unknown): Promise<CiHostReply> {
    const request = CiHostRequestSchema.parse(raw)
    if (request.operation === 'status') {
      const ready = await this.ready()
      return CiHostReplySchema.parse({ operation: 'status', ready, reasons: ready ? [] : [this.provider.loginHint],
        cpuCount: this.provider.cpus, memoryBytes: this.provider.memoryBytes,
        userSystemd: this.provider.userSystemd, runs: [] })
    }
    if (request.operation === 'read' && this.reading.has(request.runId)) {
      // Another read is following the provider; this one answers from the kept state and log instead of queueing.
      return this.answer(request, await this.read(request.runId))
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
    this.reading.add(request.runId)
    try {
      return await this.answer(request, await this.refresh(request.runId))
    } finally {
      this.reading.delete(request.runId)
    }
  }

  private async answer(request: Extract<CiHostRequest, { operation: 'read' }>, run: CloudRun) {
    const log = await readFile(this.path(run.runId, 'log')).catch(() => Buffer.alloc(0))
    const text = log.subarray(request.afterOffset, request.afterOffset + request.maxBytes)
    return CiHostReplySchema.parse({ operation: 'read', run: this.view(run, log.length), text: text.toString('utf8'),
      nextOffset: request.afterOffset + text.length,
      ...(request.durations && run.durations ? { durations: run.durations } : {}),
      ...(request.testResults && run.testResults ? { testResults: run.testResults } : {}) })
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
    if (run.state === 'running' && run.live?.step) step = run.live.step
    if (run.state === 'starting') step = 'dispatch'
    if (run.state === 'queued') step = null
    return { runId: run.runId, state: run.state, step,
      exitCode: run.exitCode, startedAt: run.startedAt, finishedAt: run.finishedAt, logBytes, message: run.message }
  }

  private async start(request: { runId: string; repository: string; commit: string; suite: CiSuite
    part?: CiPart | undefined; partition?: CiPartition | undefined; durations?: CiDurations | undefined; scope?: CiScope | undefined;
    files?: string[] | undefined; defaultBranch?: string | undefined; baseCommit?: string | undefined;
    gate?: boolean | undefined; integrationShards?: number | undefined }): Promise<CiHostRun> {
    const existing = await this.read(request.runId).catch(fallbackOnError(null, 'jobs', 'read existing CI run', { runId: request.runId }, ['ENOENT']))
    if (existing) return this.view(existing, 0)
    if (!this.provider.userSystemd.supported && request.suite === 'integration'
      && (request.partition?.hostIndexes?.includes(request.partition.index)
      || !request.partition && request.files?.some(requiresUserSystemd))) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE',
        `${this.provider.label} cannot run user-systemd files: ${this.provider.userSystemd.reason ?? 'user systemd is unavailable'}.`, 409)
    }
    const mirror = await this.mirrors(request.repository)
    // CircleCI's machine image has no podman, which the Worker unit tests (unit-other) use.
    if (this.provider.id === 'circleci' && !runsOnCircleCi(request)) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE', `${this.provider.label} cannot run the Worker unit tests (no podman).`, 409)
    }
    if (!mirror || !await this.ready()) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE', `This workspace has no CI mirror, or Main is not logged in to ${this.provider.label}.`, 409)
    }
    const scope = request.scope ?? 'affected'
    const deriveFiles = scope === 'affected' && request.files === undefined
    const { git, branch, defaultBranch, baseCommit } = await this.publish(request.repository, mirror, request.commit,
      deriveFiles && !request.baseCommit ? request.defaultBranch ?? 'main' : undefined,
      deriveFiles ? request.baseCommit : undefined)
    const selectOnRunner = deriveFiles && (defaultBranch !== undefined || baseCommit !== undefined)
    const message = deriveFiles && !selectOnRunner
      ? 'Running full suite: ' + (request.baseCommit
        ? 'baseCommit is unavailable or is not an ancestor of the resolved commit.'
        : 'No merge-base with the workspace default branch is available.') : null
    let slice = request.suite === 'integration' && !selectOnRunner
      && (request.gate || request.partition || !deriveFiles && scope === 'affected')
      ? await this.slice(git, request.commit, request.partition, request.durations ?? {}, request.files) : ''
    if ((!request.files || scope !== 'affected') && request.partition && request.part) {
      slice = `${request.partition.index + 1}/${request.partition.count}`
    }
    const files = scope === 'affected' && request.files !== undefined && request.suite !== 'integration'
      ? await this.selectedIndexes(git, request.commit, request.files) : undefined
    let run = await this.save({ runId: request.runId, repository: request.repository, mirror, commit: request.commit,
      suite: request.suite, ...(request.part ? { part: request.part } : {}), startedAt: this.ports.now().toISOString(), providerRunId: null, state: 'starting',
      scope, ...(request.files !== undefined ? { files: request.files } : {}),
      ...(request.baseCommit ? { baseCommit: request.baseCommit } : {}),
      finishedAt: null, exitCode: null, message })
    // Providers cap pipeline parameter length: a full partition too long to list is computed on the runner from the
    // commit's durations instead, and oversized learned durations stay behind.
    const limit = this.provider.parameterLimit ?? Number.POSITIVE_INFINITY
    let partition = selectOnRunner && request.partition ? JSON.stringify(request.partition) : undefined
    if (slice.length > limit && request.suite === 'integration' && request.partition
      && (scope === 'full' || message !== null) && request.files === undefined) {
      slice = ''
      partition = JSON.stringify(request.partition)
    }
    const durations = selectOnRunner && request.durations ? JSON.stringify(request.durations) : undefined
    const input: CloudDispatchInput = { mirror, branch, runId: request.runId, suite: request.part ?? request.suite, slice,
      expectedDurationMs: request.expectedDurationMs ?? 0,
      scope: message ? 'full' : scope, ...(files !== undefined ? { files } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(partition ? { partition } : {}),
      ...(durations && durations.length <= limit ? { durations } : {}) }
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
    if (this.ports.now().getTime() - Date.parse(dispatchedAt) < CLOUD_START_TIMEOUT_MS) return run
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
  private publish(repository: string, mirror: string, commit: string, defaultBranch?: string, baseCommit?: string) {
    const key = `${mirror}\n${commit}\n${defaultBranch ?? ''}\n${baseCommit ?? ''}`
    let published = this.published.get(key)
    if (!published) {
      const queued = (mirrorPushes.get(mirror) ?? Promise.resolve()).catch(() => { /* ignore: the previous caller receives its failure; the queue must still admit the next operation. */ })
      const pushed = queued.then(() => this.push(repository, mirror, commit, defaultBranch, baseCommit))
      published = pushed
      mirrorPushes.set(mirror, pushed)
      void pushed.catch(() => { /* ignore: the push failure is reported to the caller awaiting it; this only clears the queue entry */ }).then(() => { if (mirrorPushes.get(mirror) === pushed) mirrorPushes.delete(mirror) })
      this.published.set(key, published)
      // A failed push is retried by the next start; a done one is kept for the run's later partitions.
      published.catch(() => { this.published.delete(key) })
      if (this.published.size > 50) this.published.delete(this.published.keys().next().value!)
    }
    return published
  }

  private async push(repository: string, mirror: string, commit: string, defaultBranch?: string, baseCommit?: string) {
    const signal = AbortSignal.timeout(600_000)
    const clone = await ensureClone(this.git, repository, signal)
    const git = async (args: string[], env?: Record<string, string>) => {
      const result = await this.git.git(args, { cwd: clone, signal: AbortSignal.timeout(600_000), ...(env ? { env } : {}) })
      if (result.code !== 0) {
        // Git's own reason, without any credentials in a URL.
        const detail = result.stderr.replace(/\/\/[^/@\s]+@/g, '//').trim().slice(-500)
        throw new DomainError('CI_CLOUD_FAILED', `git ${args[0]} failed for the CI mirror.${detail ? ` ${detail}` : ''}`, 502)
      }
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
    let runnerBaseCommit: string | undefined
    let head: string | undefined
    if (baseCommit) {
      const ancestor = await this.git.git(['merge-base', '--is-ancestor', baseCommit, commit], { cwd: clone, signal })
      if (ancestor.code === 0) {
        await this.guard(clone, baseCommit, signal)
        parent = await snapshotOf(baseCommit, base)
        runnerBaseCommit = parent
      }
    } else if (defaultBranch) {
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
    let snapshot: string
    if (commit === baseCommit && runnerBaseCommit) snapshot = runnerBaseCommit
    else if (commit === head && comparison) snapshot = comparison.commit
    else snapshot = await snapshotOf(commit, parent)
    const branch = baseCommit ? `ci/${commit}-${baseCommit}` : `ci/${commit}`
    // GitHub runs start from main, whose cache scope every run shares, and check out the commit's branch.
    await git(['push', '--quiet', '--force', `https://github.com/${mirror}.git`, `${snapshot}:refs/heads/${branch}`,
      `${snapshot}:refs/heads/main`, ...(comparison ? [`${comparison.commit}:refs/heads/${comparison.branch}`] : [])])
    return { git, branch, ...(comparison ? { defaultBranch: comparison.branch } : {}),
      ...(runnerBaseCommit ? { baseCommit: runnerBaseCommit } : {}) }
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
    if (!this.provider.userSystemd.supported && [...slice].some(requiresUserSystemd)) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE',
        `${this.provider.label} cannot run user-systemd files: ${this.provider.userSystemd.reason ?? 'user systemd is unavailable'}.`, 409)
    }
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
    const status = await this.ports.run('tailscale', ['status', '--json'], { timeoutMs: 15_000 }).catch(fallbackOnError(null, 'jobs', 'read tailscale status'))
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

  /** Follows the provider's run at most every few seconds, pausing while the service's rate limit is spent. */
  private async refresh(runId: string): Promise<CloudRun> {
    const run = await this.read(runId)
    if (!['starting', 'running'].includes(run.state)) return run
    const now = this.ports.now().getTime()
    if (now < this.backoff.until) return run
    if (run.state === 'running' && run.workflowStarted && now - (this.polled.get(runId) ?? -Infinity) < POLL_MS) return run
    if (this.following >= POLL_CONCURRENCY) await new Promise<void>(resolve => { this.waiting.push(resolve) })
    else this.following++
    try {
      // A poll that waited for its slot skips the service if a rate limit was hit meanwhile.
      if (this.ports.now().getTime() < this.backoff.until) return run
      const next = await this.follow(run)
      this.backoff = { until: 0, ms: 0 }
      return next
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'CI_CLOUD_RATE_LIMITED')) throw error
      const ms = Math.min(MAX_BACKOFF_MS, Math.max(30_000, this.backoff.ms * 2))
      this.backoff = { until: now + ms, ms }
      log.warn({ runId, provider: this.provider.id, backoffMs: ms }, 'Cloud CI rate limited; polling paused')
      return run
    } finally {
      // The slot passes straight to the next waiting poll.
      const next = this.waiting.shift()
      if (next) next()
      else this.following--
    }
  }

  /** Writes the steps the run has started, and new output of the running step, to its log. */
  private async progress(run: CloudRun, status: CloudStatus): Promise<CloudRun> {
    const live = run.live ?? { step: null, seen: [], bytes: 0 }
    const seen = new Set(live.seen)
    const chunks: Buffer[] = []
    let output = live.output, bytes = live.bytes, step = live.step
    for (const value of status.steps ?? []) {
      if (value.state === 'skipped') continue
      const name = value.name.split('\n')[0]!.trim().slice(0, 80) || value.key
      step = name
      if (!seen.has(value.key)) { seen.add(value.key); chunks.push(Buffer.from(`==> ${name}\n`)) }
      if (value.state === 'failed' && !seen.has(`${value.key}:failed`)) {
        seen.add(`${value.key}:failed`); chunks.push(Buffer.from(`==> ${name} failed\n`))
      }
      if (status.output?.key === value.key) {
        const text = Buffer.from(status.output.text)
        const written = output?.key === value.key ? output.bytes : 0
        if (text.length > written) chunks.push(text.subarray(written))
        output = { key: value.key, bytes: Math.max(written, text.length) }
      }
    }
    let chunk = Buffer.concat(chunks)
    // The provider's whole log is kept at the end, so the live copy stays within the same bound.
    chunk = chunk.subarray(0, Math.max(0, LOG_LIMIT - bytes))
    if (!chunk.length && step === live.step && output?.bytes === live.output?.bytes && seen.size === live.seen.length) return run
    if (chunk.length) await writeFile(this.path(run.runId, 'log'), chunk, { flag: 'a', mode: 0o600 })
    bytes += chunk.length
    return this.save({ ...run, live: { step, seen: [...seen], ...(output ? { output } : {}), bytes } })
  }

  /** Follows the provider's run; once it finishes, keeps its log, measured durations and test results. */
  private async follow(run: CloudRun): Promise<CloudRun> {
    const runId = run.runId
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
    this.polled.set(runId, this.ports.now().getTime())
    run = await this.progress(run, status)
    if (!status.done) return run
    this.polled.delete(runId)
    const full = Buffer.from(await this.provider.log(run).catch(() => '')).subarray(-LOG_LIMIT)
    await writeFile(this.path(runId, 'log'), run.live?.bytes ? Buffer.concat([Buffer.from(`--- ${this.provider.label} log ---\n`), full]) : full,
      { flag: 'a', mode: 0o600 })
    let durations: CiDurations | undefined
    let testResults: CiTestResults | undefined
    const artifacts = await this.provider.artifacts(run, join(this.root, 'runs', runId, 'artifact'))
      .catch(fallbackOnError(null, 'jobs', 'fetch CI run artifacts', { runId }))
    if (run.suite === 'integration' || run.suite === 'unit') {
      const parsed = CiDurationsSchema.safeParse(artifacts?.durations)
      if (parsed.success && (run.suite === 'integration' || run.part === 'unit-api' || run.part === 'unit-web')) {
        durations = parsed.data
      }
      const tests = CiTestResultsSchema.safeParse(artifacts?.testResults)
      if (tests.success) testResults = tests.data
    }
    const watchdog = CiWatchdogFailureSchema.safeParse(artifacts?.watchdogFailure)
    const watchdogMessage = watchdog.success ? watchdog.data.message : undefined
    const passed = status.conclusion === 'success'
    return this.save({ ...run, state: passed ? 'passed' : status.conclusion === 'cancelled' ? 'canceled' : 'failed',
      exitCode: passed ? 0 : 1, finishedAt: status.finishedAt,
      message: passed ? run.message : watchdogMessage
        ?? [run.message, `${this.provider.label}: ${status.conclusion}.`].filter(Boolean).join(' '),
      ...(durations ? { durations } : {}), ...(testResults ? { testResults } : {}) })
  }
}

/** GitHub Actions and CircleCI on the same public mirror. */
export function cloudCis(mainId: string, mirrors: Mirrors, ports: HostCiPorts = systemHostCiPorts()): CloudCi[] {
  return [new CloudCi(mainId, new GitHubActionsProvider(ports), mirrors), new CloudCi(mainId, new CircleCiProvider(ports), mirrors)]
}

interface Peer { HostName?: string; TailscaleIPs?: string[] }
