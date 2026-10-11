import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { CiDurationsSchema, CiHostReplySchema, CiHostRequestSchema, WorkspaceSchema, integrationPartition,
  type CiDurations, type CiHostReply, type CiHostRun, type CiPartition, type CiSuite } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { ensureClone, systemGitWorktreePorts, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { systemHostCiPorts, type HostCiPorts } from './runner.js'
import type { HostCiComputer } from './service.js'

/** The workflow every mirror carries (.github/workflows/ci.yml): one dispatched job per suite or partition. */
const WORKFLOW = 'ci.yml'
/** A free account runs 20 jobs at once; Main keeps a few for the mirror's own pushes and reruns. */
const SLOTS = 16
// A standard public-repository runner: 4 vCPUs and 16 GB.
const RUNNER_CPUS = 4, RUNNER_MEMORY = 16 * 2 ** 30
const LOG_LIMIT = 4 * 1024 * 1024

interface CloudRun {
  runId: string; repository: string; mirror: string; commit: string; suite: CiSuite; startedAt: string
  githubRunId: number | null; state: CiHostRun['state']; finishedAt: string | null; exitCode: number | null
  message: string | null; durations?: CiDurations
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

/** GitHub Actions on a workspace's public mirror as CI computers: one slot per concurrent job. A run pushes the
 * commit's files to the mirror as one commit without history, dispatches the mirror's workflow, and reads the
 * result, log and measured durations back from GitHub. */
export class GitHubActionsCi {
  private githubChecked: { at: number; ready: boolean } | undefined

  constructor(private readonly mainId: string, private readonly mirrors: Mirrors,
    private readonly root = join(homedir(), '.local/share/foreman-code/ci-cloud'),
    private readonly ports: HostCiPorts = systemHostCiPorts(),
    private readonly git: GitWorktreePorts = systemGitWorktreePorts(),
    private readonly identity = { home: homedir(), user: userInfo().username, host: hostname() }) {}

  computers(priority = 30): HostCiComputer[] {
    return Array.from({ length: SLOTS }, (_, slot) => ({ key: `${this.mainId}:cloud:${slot}`,
      hostRef: { kind: 'cloud' as const, mainId: this.mainId, slot }, label: `GitHub Actions ${slot + 1}`, priority }))
  }

  async handle(raw: unknown): Promise<CiHostReply> {
    const request = CiHostRequestSchema.parse(raw)
    if (request.operation === 'status') {
      const ready = await this.github()
      return CiHostReplySchema.parse({ operation: 'status', ready,
        reasons: ready ? [] : ['Log in to GitHub on Main (gh auth login) to run CI on GitHub Actions.'],
        cpuCount: RUNNER_CPUS, memoryBytes: RUNNER_MEMORY, runs: [] })
    }
    if (request.operation === 'start') return CiHostReplySchema.parse({ operation: 'start', run: await this.start(request) })
    if (request.operation === 'cancel') {
      const run = await this.refresh(request.runId)
      if (run.githubRunId && ['starting', 'running'].includes(run.state)) {
        await this.gh(['run', 'cancel', String(run.githubRunId), '-R', run.mirror])
      }
      const canceled = ['starting', 'running'].includes(run.state)
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

  private async github() {
    if (this.githubChecked && Date.now() - this.githubChecked.at < 60_000) return this.githubChecked.ready
    const ready = (await this.ports.run('gh', ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000 })
      .catch(() => ({ code: 127 }))).code === 0
    this.githubChecked = { at: Date.now(), ready }
    return ready
  }

  private async gh(args: string[], timeoutMs = 120_000) {
    const result = await this.ports.run('gh', args, { timeoutMs })
    if (result.code !== 0) {
      throw new DomainError('CI_CLOUD_FAILED', `GitHub Actions did not accept gh ${args[0]} ${args[1]}: `
        + `${result.stderr.trim().slice(0, 300)}`, 502)
    }
    return result.stdout
  }

  private path(runId: string, name: 'meta.json' | 'log') { return join(this.root, 'runs', runId, name) }

  private async read(runId: string): Promise<CloudRun> {
    try { return JSON.parse(await readFile(this.path(runId, 'meta.json'), 'utf8')) as CloudRun }
    catch { throw new DomainError('CI_RUN_UNKNOWN', 'GitHub Actions has no such CI run.', 404) }
  }

  private async save(run: CloudRun) {
    await mkdir(join(this.root, 'runs', run.runId), { recursive: true, mode: 0o700 })
    await writeFile(this.path(run.runId, 'meta.json'), JSON.stringify(run), { mode: 0o600 })
    return run
  }

  private view(run: CloudRun, logBytes: number): CiHostRun {
    return { runId: run.runId, state: run.state, step: run.state === 'starting' ? 'dispatch' : run.suite,
      exitCode: run.exitCode, startedAt: run.startedAt, finishedAt: run.finishedAt, logBytes, message: run.message }
  }

  private async start(request: { runId: string; repository: string; commit: string; suite: CiSuite
    partition?: CiPartition | undefined; durations?: CiDurations | undefined }): Promise<CiHostRun> {
    const existing = await this.read(request.runId).catch(() => null)
    if (existing) return this.view(existing, 0)
    const mirror = await this.mirrors(request.repository)
    if (!mirror || !await this.github()) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE', 'This workspace has no CI mirror, or Main is not logged in to GitHub.', 409)
    }
    const signal = AbortSignal.timeout(600_000)
    const clone = await ensureClone(this.git, request.repository, signal)
    const git = async (args: string[], env?: Record<string, string>) => {
      const result = await this.git.git(args, { cwd: clone, signal, ...(env ? { env } : {}) })
      if (result.code !== 0) throw new DomainError('CI_CLOUD_FAILED', `git ${args[0]} failed for the CI mirror.`, 502)
      return result.stdout.trim()
    }
    const base = `refs/foreman/mirror/${mirror}`
    await git(['fetch', '--quiet', '--no-tags', `https://github.com/${mirror}.git`, `+main:${base}`])
    await this.guard(clone, request.commit, signal)
    // The same commit always yields the same snapshot, so every partition of a run shares one mirror branch.
    const date = await git(['show', '-s', '--format=%cI', request.commit])
    const author = { GIT_AUTHOR_NAME: mirror.split('/')[0]!, GIT_AUTHOR_EMAIL: `${mirror.split('/')[0]}@users.noreply.github.com`,
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    const snapshot = await git(['commit-tree', `${request.commit}^{tree}`, '-p', base, '-m', `Snapshot ${request.commit.slice(0, 12)}`],
      { ...author, GIT_COMMITTER_NAME: author.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: author.GIT_AUTHOR_EMAIL })
    const branch = `ci/${request.commit}`
    await git(['push', '--quiet', '--force', `https://github.com/${mirror}.git`, `${snapshot}:refs/heads/${branch}`])
    const files = request.suite === 'integration' && request.partition
      ? await this.slice(git, request.commit, request.partition, request.durations ?? {}) : []
    const run = await this.save({ runId: request.runId, repository: request.repository, mirror, commit: request.commit,
      suite: request.suite, startedAt: this.ports.now().toISOString(), githubRunId: null, state: 'starting',
      finishedAt: null, exitCode: null, message: null })
    await this.gh(['workflow', 'run', WORKFLOW, '-R', mirror, '--ref', branch, '-f', `run_id=${request.runId}`,
      '-f', `suite=${request.suite}`, '-f', `files=${files.join(' ')}`])
    return this.view(run, 0)
  }

  /** The same duration-balanced slice a build computer would run, from the commit's own files and durations. */
  private async slice(git: (args: string[]) => Promise<string>, commit: string, partition: CiPartition, learned: CiDurations) {
    const files = (await git(['ls-tree', '--name-only', `${commit}:apps/api/test`])).split('\n')
      .filter(name => name.endsWith('.integration.test.ts')).map(name => `apps/api/test/${name}`).sort()
    const committed = await git(['show', `${commit}:scripts/integration-durations.json`])
      .then(text => JSON.parse(text) as Record<string, number>, () => ({}))
    const slice = integrationPartition(files, { ...committed, ...learned }, partition)
    if (!slice.length) throw new DomainError('CI_CLOUD_FAILED', 'This partition has no integration files.', 409)
    return slice
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

  /** Follows the dispatched GitHub run; once it finishes, keeps its log and measured durations. */
  private async refresh(runId: string): Promise<CloudRun> {
    let run = await this.read(runId)
    if (!['starting', 'running'].includes(run.state)) return run
    if (!run.githubRunId) {
      const listed = JSON.parse(await this.gh(['run', 'list', '-R', run.mirror, '--workflow', WORKFLOW, '--branch',
        `ci/${run.commit}`, '--event', 'workflow_dispatch', '--limit', '100', '--json', 'databaseId,displayTitle'])) as
        { databaseId: number; displayTitle: string }[]
      const match = listed.find(value => value.displayTitle === `ci ${run.runId}`)
      if (!match) {
        // GitHub lists a dispatched run within seconds; one never listed was not accepted.
        if (Date.now() - Date.parse(run.startedAt) < 10 * 60_000) return run
        return this.save({ ...run, state: 'lost', finishedAt: this.ports.now().toISOString(),
          message: 'GitHub Actions never started this run.' })
      }
      run = await this.save({ ...run, githubRunId: match.databaseId, state: 'running' })
    }
    const view = JSON.parse(await this.gh(['run', 'view', String(run.githubRunId), '-R', run.mirror, '--json',
      'status,conclusion,updatedAt'])) as { status: string; conclusion: string; updatedAt: string }
    if (view.status !== 'completed') return run
    const log = await this.ports.run('gh', ['run', 'view', String(run.githubRunId), '-R', run.mirror, '--log'], { timeoutMs: 300_000 })
    await writeFile(this.path(runId, 'log'), Buffer.from(log.stdout).subarray(-LOG_LIMIT), { mode: 0o600 })
    let durations: CiDurations | undefined
    if (run.suite === 'integration') {
      const directory = join(this.root, 'runs', runId, 'artifact')
      const downloaded = await this.ports.run('gh', ['run', 'download', String(run.githubRunId), '-R', run.mirror,
        '-n', 'durations', '-D', directory], { timeoutMs: 120_000 })
      const parsed = downloaded.code === 0 ? CiDurationsSchema.safeParse(await readFile(join(directory, 'durations.json'), 'utf8')
        .then(text => JSON.parse(text) as unknown, () => null)) : null
      if (parsed?.success) durations = parsed.data
    }
    const passed = view.conclusion === 'success'
    return this.save({ ...run, state: passed ? 'passed' : view.conclusion === 'cancelled' ? 'canceled' : 'failed',
      exitCode: passed ? 0 : 1, finishedAt: view.updatedAt, message: passed ? null : `GitHub Actions: ${view.conclusion}.`,
      ...(durations ? { durations } : {}) })
  }
}

interface Peer { HostName?: string; TailscaleIPs?: string[] }
