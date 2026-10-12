import { mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { CiExecutionSuite, CiScope } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { HostCiPorts } from './runner.js'
import type { CloudRun } from './cloud.js'

export const CLOUD_START_TIMEOUT_MS = 75_000

/** One step of the provider's job; `key` stays the same across polls. */
export interface CloudStep { key: string; name: string; state: 'running' | 'passed' | 'failed' | 'skipped' }
/** The run's state with its live progress: the job's steps and, where the provider streams it, the running step's
 * output so far. */
export type CloudStatus = ({ done: false } | { done: true; conclusion: 'success' | 'failure' | 'cancelled'; finishedAt: string })
  & { steps?: CloudStep[]; output?: { key: string; text: string } }
export interface CloudDispatchInput {
  mirror: string; branch: string; runId: string; suite: CiExecutionSuite; slice: string
  scope?: CiScope; files?: string; defaultBranch?: string; baseCommit?: string; partition?: string; durations?: string
}

/** One cloud CI service: how Main starts a run of a mirror branch and reads it back, through the service's CLI login. */
export interface CloudProvider {
  readonly id: 'github' | 'circleci'
  readonly label: string
  /** Longest accepted pipeline parameter value, when the provider caps it. */
  readonly parameterLimit?: number
  /** Jobs the service runs at once for a public repository on its free plan, less a few kept for retries. */
  readonly slots: number
  readonly cpus: number
  readonly memoryBytes: number
  readonly loginHint: string
  ready(): Promise<boolean>
  /** Starts a run; returns the service's run id when it is known at once. */
  dispatch(input: CloudDispatchInput): Promise<string | null>
  /** The service's run id once a workflow exists; a pipeline alone is not a started run. */
  find(run: CloudRun): Promise<string | null>
  status(run: CloudRun): Promise<CloudStatus>
  log(run: CloudRun): Promise<string>
  /** The measured test file durations and structured test results the run left as an artifact. */
  artifacts(run: CloudRun, directory: string): Promise<CloudArtifacts>
  cancel(run: CloudRun): Promise<void>
}

/** The service refused because its API rate limit is spent; callers back off instead of retrying at once. */
function rateLimited(label: string, text: string) {
  return /rate limit|\b429\b|too many requests/i.test(text)
    ? new DomainError('CI_CLOUD_RATE_LIMITED', `${label} rate limit reached; polling paused.`, 503) : null
}

async function command(ports: HostCiPorts, label: string, file: string, args: string[], timeoutMs = 120_000) {
  const result = await ports.run(file, args, { timeoutMs })
  if (result.code !== 0) {
    const limited = rateLimited(label, result.stderr)
    if (limited) throw limited
    const missingRun = file === 'circleci' && args[0] === 'run' && args[1] === 'get'
      && /\brun\.not_found\b/.test(result.stderr)
    if (missingRun) throw new DomainError('CI_CLOUD_RUN_NOT_FOUND', 'CircleCI run is not visible.', 502)
    throw new DomainError('CI_CLOUD_FAILED', `${label} did not accept ${file} ${args[0]} ${args[1]}: `
      + `${result.stderr.trim().slice(0, 300)}`, 502)
  }
  return result.stdout
}

async function findFile(directory: string, name: string): Promise<string | null> {
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (entry.isFile() && entry.name === name) return join(entry.parentPath, entry.name)
  }
  return null
}

export interface CloudArtifacts { durations: unknown; testResults: unknown }
const noArtifacts: CloudArtifacts = { durations: null, testResults: null }

async function readArtifacts(directory: string): Promise<CloudArtifacts> {
  const read = async (name: string) => {
    const path = await findFile(directory, name)
    return path ? JSON.parse(await readFile(path, 'utf8')) as unknown : null
  }
  return { durations: await read('durations.json').catch(() => null), testResults: await read('test-results.json').catch(() => null) }
}

const WORKFLOW = 'ci.yml'

interface GitHubJob { id: number; status: string; steps?: { number: number; name: string; status: string; conclusion: string | null }[] }

/** Standard public-repository runners: 4 vCPUs and 16 GB; a free account runs 20 jobs at once. */
export class GitHubActionsProvider implements CloudProvider {
  readonly id = 'github' as const
  readonly label = 'GitHub Actions'
  readonly slots = 16
  readonly cpus = 4
  readonly memoryBytes = 16 * 2 ** 30
  readonly loginHint = 'Log in to GitHub on Main (gh auth login) to run CI on GitHub Actions.'
  private readonly jobsCache = new Map<string, { etag: string; jobs: GitHubJob[] }>()

  constructor(private readonly ports: HostCiPorts) {}

  private gh(args: string[], timeoutMs?: number) { return command(this.ports, this.label, 'gh', args, timeoutMs) }

  async ready() {
    return (await this.ports.run('gh', ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000 })).code === 0
  }

  async dispatch(input: CloudDispatchInput) {
    // Runs start from main, whose cache scope every run shares, and check out the commit's branch.
    await this.gh(['workflow', 'run', WORKFLOW, '-R', input.mirror, '--ref', 'main', '-f', `ref=${input.branch}`,
      '-f', `run_id=${input.runId}`, '-f', `suite=${input.suite}`, '-f', `slice=${input.slice}`,
      ...(input.scope ? ['-f', `scope=${input.scope}`] : []), ...(input.files !== undefined ? ['-f', `files=${input.files}`] : []),
      ...(input.defaultBranch ? ['-f', `default_branch=${input.defaultBranch}`] : []),
      ...(input.baseCommit ? ['-f', `base_commit=${input.baseCommit}`] : []),
      ...(input.partition ? ['-f', `partition=${input.partition}`] : []),
      ...(input.durations ? ['-f', `durations=${input.durations}`] : [])])
    return null
  }

  async find(run: CloudRun) {
    const listed = JSON.parse(await this.gh(['run', 'list', '-R', run.mirror, '--workflow', WORKFLOW, '--branch', 'main',
      '--event', 'workflow_dispatch', '--limit', '200', '--json', 'databaseId,displayTitle,status'], 15_000)) as
      { databaseId: number; displayTitle: string; status?: string }[]
    const matches = listed.filter(value => value.displayTitle === `ci ${run.runId}`)
      .sort((left, right) => left.databaseId - right.databaseId)
    const match = matches.find(value => String(value.databaseId) === run.providerRunId) ?? matches[0]
    for (const duplicate of matches) {
      if (duplicate === match || duplicate.status === 'completed') continue
      await this.cancel({ ...run, providerRunId: String(duplicate.databaseId) })
    }
    return match ? String(match.databaseId) : null
  }

  /** The run's jobs and steps by a conditional request: an unchanged answer (304) costs no rate limit. */
  private async jobs(run: CloudRun): Promise<GitHubJob[]> {
    const id = run.providerRunId!
    const cached = this.jobsCache.get(id)
    const result = await this.ports.run('gh', ['api', '-i', ...(cached ? ['-H', `If-None-Match: ${cached.etag}`] : []),
      `repos/${run.mirror}/actions/runs/${id}/jobs?per_page=100`], { timeoutMs: 15_000 })
    const split = /\r?\n\r?\n/.exec(result.stdout)
    const head = split ? result.stdout.slice(0, split.index) : result.stdout
    const status = Number(/^HTTP\/\S+ (\d{3})/.exec(head)?.[1])
    if (status === 304 && cached) return cached.jobs
    if (result.code !== 0 || status !== 200) {
      const limited = rateLimited(this.label, `${result.stderr}\n${status === 429 || /^x-ratelimit-remaining:\s*0\s*$/im.test(head)
        ? 'rate limit' : ''}`)
      throw limited ?? new DomainError('CI_CLOUD_FAILED', `${this.label} did not return the run's jobs: `
        + `${result.stderr.trim().slice(0, 300)}`, 502)
    }
    const jobs = (JSON.parse(result.stdout.slice(split!.index + split![0].length)) as { jobs: GitHubJob[] }).jobs
    const etag = /^etag:\s*(.+?)\s*$/im.exec(head)?.[1]
    this.jobsCache.delete(id)
    if (etag) this.jobsCache.set(id, { etag, jobs })
    if (this.jobsCache.size > 200) this.jobsCache.delete(this.jobsCache.keys().next().value!)
    return jobs
  }

  async status(run: CloudRun): Promise<CloudStatus> {
    const jobs = await this.jobs(run)
    const steps = jobs.flatMap(job => (job.steps ?? []).flatMap(step => {
      const state = step.status === 'in_progress' ? 'running' as const : step.status !== 'completed' ? null
        : step.conclusion === 'success' ? 'passed' as const : step.conclusion === 'skipped' ? 'skipped' as const : 'failed' as const
      return state ? [{ key: `${job.id}:${step.number}`, name: step.name, state }] : []
    }))
    // Only a finished-looking run costs an unconditional read of its conclusion.
    if (jobs.some(job => job.status !== 'completed')) return { done: false, steps }
    const view = JSON.parse(await this.gh(['run', 'view', run.providerRunId!, '-R', run.mirror, '--json',
      'status,conclusion,updatedAt'])) as { status: string; conclusion: string; updatedAt: string }
    if (view.status !== 'completed') return { done: false, steps }
    this.jobsCache.delete(run.providerRunId!)
    return { done: true, finishedAt: view.updatedAt, steps,
      conclusion: view.conclusion === 'success' ? 'success' : view.conclusion === 'cancelled' ? 'cancelled' : 'failure' }
  }

  async log(run: CloudRun) {
    return (await this.ports.run('gh', ['run', 'view', run.providerRunId!, '-R', run.mirror, '--log'], { timeoutMs: 300_000 })).stdout
  }

  async artifacts(run: CloudRun, directory: string) {
    const downloaded = await this.ports.run('gh', ['run', 'download', run.providerRunId!, '-R', run.mirror,
      '-n', 'durations', '-D', directory], { timeoutMs: 120_000 })
    return downloaded.code === 0 ? readArtifacts(directory) : noArtifacts
  }

  async cancel(run: CloudRun) { await this.gh(['run', 'cancel', run.providerRunId!, '-R', run.mirror]) }
}

/** Large Linux machines (4 vCPUs, 15 GB); the free plan runs 30 jobs at once and open-source Linux builds are free. */
export class CircleCiProvider implements CloudProvider {
  readonly id = 'circleci' as const
  readonly label = 'CircleCI'
  /** CircleCI rejects pipeline parameter values longer than 512 characters. */
  readonly parameterLimit = 500
  readonly slots = 28
  readonly cpus = 4
  readonly memoryBytes = 15 * 2 ** 30
  readonly loginHint = 'Log in to CircleCI on Main (circleci auth login) and follow the CI mirror project to run CI there.'
  /** A pipeline's job id once its workflow has one, so each poll costs one job read. */
  private readonly jobIds = new Map<string, string>()

  constructor(private readonly ports: HostCiPorts) {}

  private circleci(args: string[], timeoutMs?: number) { return command(this.ports, this.label, 'circleci', args, timeoutMs) }

  async ready() { return (await this.ports.run('circleci', ['auth', 'me'], { timeoutMs: 15_000 })).code === 0 }

  async dispatch(input: CloudDispatchInput) {
    const started = JSON.parse(await this.circleci(['run', 'trigger', '--project', `gh/${input.mirror}`, '--branch', input.branch,
      '--parameter', `run_id=${input.runId}`, '--parameter', `suite=${input.suite}`,
      '--parameter', `slice=${input.slice}`, ...(input.scope ? ['--parameter', `scope=${input.scope}`] : []),
      ...(input.files !== undefined ? ['--parameter', `files=${input.files}`] : []),
      ...(input.defaultBranch ? ['--parameter', `default_branch=${input.defaultBranch}`] : []),
      ...(input.baseCommit ? ['--parameter', `base_commit=${input.baseCommit}`] : []),
      ...(input.partition ? ['--parameter', `partition=${input.partition}`] : []),
      ...(input.durations ? ['--parameter', `durations=${input.durations}`] : []), '--json'])) as { id: string }
    return started.id
  }

  async find(run: CloudRun) {
    if (!run.providerRunId) return null
    try {
      const view = JSON.parse(await this.circleci(['run', 'get', run.providerRunId, '--json'], 15_000)) as
        { workflows?: unknown[] }
      return view.workflows?.length ? run.providerRunId : null
    } catch (error) {
      const elapsed = this.ports.now().getTime() - Date.parse(run.dispatch?.at ?? run.startedAt)
      // Accepted pipelines can take a few polls to appear in CircleCI's run lookup.
      if (error instanceof DomainError && error.code === 'CI_CLOUD_RUN_NOT_FOUND'
        && !run.workflowStarted && elapsed >= 0 && elapsed < CLOUD_START_TIMEOUT_MS) return null
      throw error
    }
  }

  private async job(run: CloudRun) {
    const known = this.jobIds.get(run.providerRunId!)
    if (known) return { job: { id: known } }
    const view = JSON.parse(await this.circleci(['run', 'get', run.providerRunId!, '--json'])) as
      { workflows?: { jobs?: { id: string }[] }[] }
    const job = view.workflows?.[0]?.jobs?.[0] ?? null
    if (job) this.jobIds.set(run.providerRunId!, job.id)
    if (this.jobIds.size > 200) this.jobIds.delete(this.jobIds.keys().next().value!)
    return { job }
  }

  async status(run: CloudRun): Promise<CloudStatus> {
    const { job } = await this.job(run)
    if (!job) return { done: false }
    const detail = JSON.parse(await this.circleci(['job', 'get', job.id, '--json'])) as
      { phase: string; outcome?: string; stopped_at?: string
        executions?: { steps?: { num: number; name: string; phase: string; outcome?: string }[] }[] }
    const raw = detail.executions?.[0]?.steps ?? []
    const steps = raw.map(step => ({ key: String(step.num), name: step.name, state: step.phase !== 'ended' ? 'running' as const
      : step.outcome === 'succeeded' ? 'passed' as const : step.outcome === 'skipped' ? 'skipped' as const : 'failed' as const }))
    if (detail.phase !== 'ended') {
      // CircleCI serves a running step's output so far; it is read whole, so only the running step is read.
      const current = raw.findLast(step => step.phase !== 'ended')
      if (!current) return { done: false, steps }
      const result = await this.ports.run('circleci', ['job', 'output', 'get', job.id, '--step-num', String(current.num)],
        { timeoutMs: 60_000 })
      if (result.code !== 0) {
        const limited = rateLimited(this.label, result.stderr)
        if (limited) throw limited
        return { done: false, steps }
      }
      return { done: false, steps, output: { key: String(current.num), text: result.stdout } }
    }
    return { done: true, finishedAt: detail.stopped_at ?? new Date().toISOString(), steps,
      conclusion: detail.outcome === 'succeeded' ? 'success' : detail.outcome === 'canceled' ? 'cancelled' : 'failure' }
  }

  async log(run: CloudRun) {
    const { job } = await this.job(run)
    if (!job) return ''
    return (await this.ports.run('circleci', ['job', 'output', 'list', job.id], { timeoutMs: 300_000 })).stdout
  }

  async artifacts(run: CloudRun, directory: string) {
    const { job } = await this.job(run)
    if (!job) return noArtifacts
    // Only the durations artifact is read: downloading every integration log artifact outlasts any timeout.
    const listed = await this.ports.run('circleci', ['job', 'artifact', job.id, '--json'], { timeoutMs: 60_000 })
    if (listed.code !== 0) return noArtifacts
    await mkdir(directory, { recursive: true })
    for (const artifact of (JSON.parse(listed.stdout) as { path: string; url: string }[])
      .filter(value => value.path.startsWith('durations/'))) {
      await this.ports.run('curl', ['-fsSL', '--max-time', '60', '-o', join(directory, basename(artifact.path)), artifact.url],
        { timeoutMs: 70_000 })
    }
    return readArtifacts(directory)
  }

  async cancel(run: CloudRun) {
    const view = JSON.parse(await this.circleci(['run', 'get', run.providerRunId!, '--json'])) as
      { phase?: string; workflows?: unknown[] }
    if (view.phase === 'ended' && !view.workflows?.length) return
    await this.circleci(['run', 'cancel', run.providerRunId!, '--force'])
  }
}
