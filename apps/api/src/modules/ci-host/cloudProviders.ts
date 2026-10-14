import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { CiHostRequest, CiDurations, CiExecutionSuite, CiHostRun, CiPart, CiScope, CiSuite, CiTestResults, CiUserSystemd } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { HostCiPorts } from './runner.js'
import { providerCommand } from './providerPoll.js'
import { CloudHttp, type CloudRestOptions } from './cloudHttp.js'
import { GitHubRest } from './cloudGithub.js'
import { CircleRest } from './cloudCircle.js'
import { circleCiIntegrationResults } from './circleCiResults.js'

export interface CloudRun {
  runId: string; repository: string; mirror: string; commit: string; suite: CiSuite; startedAt: string
  providerRunId: string | null; state: CiHostRun['state']; finishedAt: string | null; exitCode: number | null
  message: string | null; durations?: CiDurations; testResults?: CiTestResults
  testsStarted?: boolean
  scope?: CiScope; files?: string[]; part?: CiPart; baseCommit?: string
  dispatch?: { input: CloudDispatchInput; attempts: number; at: string }
  reconciliation?: { attempts: number; at: string; since?: string; previousMessage: string | null }
  publicationRequest?: Extract<CiHostRequest, { operation: 'start' }>
  mirrorPublication?: CiHostRun['mirrorPublication']
  mirrorBranch?: string
  workflowStarted?: boolean
  lastProgressAt?: string
  provenance?: CiHostRun['provenance']
  collection?: { log: boolean; artifacts: boolean }
  cancellation?: { at: string; canceledIds: string[] }
  dispatchHistory?: { at: string; providerRunId: string | null }[]
  /** Live progress kept while the run is followed: steps already written to the log, the running step's output
   * bytes written so far, and bytes written in all. */
  live?: { step: string | null; seen: string[]; output?: { key: string; bytes: number }; bytes: number }
}
export const CLOUD_START_TIMEOUT_MS = 75_000

/** One step of the provider's job; `key` stays the same across polls. */
export interface CloudStep { key: string; name: string; state: 'running' | 'passed' | 'failed' | 'skipped' }
/** The run's state with its live progress: the job's steps and, where the provider streams it, the running step's
 * output so far. */
export type CloudStatus = ({ done: false } | {
  done: true; conclusion: 'success' | 'failure' | 'cancelled'; finishedAt: string; message?: string
}) & { steps?: CloudStep[]; output?: { key: string; text: string } }
export interface CloudDispatchInput {
  mirror: string; branch: string; snapshotCommit?: string; runId: string; suite: CiExecutionSuite; slice: string
  expectedDurationMs?: number
  scope?: CiScope; files?: string; defaultBranch?: string; baseCommit?: string; partition?: string; durations?: string
  workflowRef?: string; workflowCommit?: string
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
  readonly userSystemd: CiUserSystemd
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

export function validateProviderParameters(provider: Pick<CloudProvider, 'label' | 'parameterLimit'>,
  input: CloudDispatchInput): void {
  const limit = provider.parameterLimit ?? Number.POSITIVE_INFINITY
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > limit) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE',
        `${provider.label} cannot accept ${name} longer than ${limit} characters; use another executor.`, 409)
    }
  }
}

/** The service refused because its API rate limit is spent; callers back off instead of retrying at once. */
function rateLimited(label: string, text: string) {
  return /rate limit|\b429\b|too many requests/i.test(text)
    ? new DomainError('CI_CLOUD_RATE_LIMITED', `${label} rate limit reached; polling paused.`, 503) : null
}

async function command(ports: HostCiPorts, label: string, file: string, args: string[], timeoutMs = 120_000) {
  return providerCommand(ports, file, args, () => executeCommand(ports, label, file, args, timeoutMs))
}

async function executeCommand(ports: HostCiPorts, label: string, file: string, args: string[], timeoutMs: number) {
  const result = await ports.run(file, args, { timeoutMs })
  if (result.code !== 0) {
    const limited = rateLimited(label, result.stderr)
    if (limited) throw limited
    const noCircleArtifacts = file === 'circleci' && args[0] === 'job' && args[1] === 'artifact'
      && /\bartifacts\.not_found\b/.test(result.stderr)
    if (noCircleArtifacts) return '[]'
    const noActiveWorkflows = file === 'circleci' && args[0] === 'run'
      && (args[1] === 'get' || args[1] === 'cancel') && /\bno active workflows\b/i.test(result.stderr)
    if (noActiveWorkflows) {
      if (args[1] === 'cancel') return ''
      throw new DomainError('CI_CLOUD_RUN_UNREADABLE',
        'CircleCI reports no active workflows; the final outcome is not visible yet.', 502)
    }
    const missingRun = file === 'circleci' && args[0] === 'run' && args[1] === 'get'
      && /\brun\.not_found\b/.test(result.stderr)
    if (missingRun) throw new DomainError('CI_CLOUD_RUN_NOT_FOUND', 'CircleCI run is not visible.', 502)
    const lookup = file === 'circleci' && args[1] === 'get' && (args[0] === 'run' || args[0] === 'job')
    const denied = /permission denied|not authorized|unauthori[sz]ed|forbidden|authentication|invalid (?:api )?token|\b40[13]\b/i
    if (lookup && denied.test(result.stderr)) {
      throw new DomainError('CI_CLOUD_RUN_UNREADABLE', `${label} execution is not readable: `
        + result.stderr.trim().slice(0, 300), 502)
    }

    throw new DomainError('CI_CLOUD_FAILED', `${label} did not accept ${file} ${args[0]} ${args[1]}: `
      + `${result.stderr.trim().slice(0, 300)}`, 502)
  }
  return result.stdout
}

async function findFile(directory: string, name: string): Promise<string | null> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (entry.isFile() && entry.name === name) return join(entry.parentPath, entry.name)
  }
  return null
}

export interface CloudArtifacts {
  durations: unknown; testResults: unknown; watchdogFailure?: unknown; suiteLog?: string
}
const ARTIFACT_VISIBILITY_MS = 5 * 60_000
const noArtifacts: CloudArtifacts = { durations: null, testResults: null }

async function readArtifacts(directory: string): Promise<CloudArtifacts> {
  const read = async (name: string) => {
    const path = await findFile(directory, name)
    return path ? JSON.parse(await readFile(path, 'utf8')) as unknown : null
  }
  const suiteLog = await findFile(directory, 'suite.log')
  return { durations: await read('durations.json'), testResults: await read('test-results.json'),
    watchdogFailure: await read('watchdog-message.json'),
    ...(suiteLog ? { suiteLog: await readFile(suiteLog, 'utf8') } : {}) }
}

const WORKFLOW = 'ci.yml'

interface GitHubJob { id: number; status: string; steps?: { number: number; name: string; status: string; conclusion: string | null }[] }

/** Standard public-repository runners: 4 vCPUs and 16 GB; a free account runs 20 jobs at once. */
export class GitHubActionsProvider implements CloudProvider {
  readonly id = 'github' as const
  readonly label = 'GitHub Actions'
  readonly userSystemd = { supported: true, reason: null }
  readonly slots = 16
  readonly cpus = 4
  readonly memoryBytes = 16 * 2 ** 30
  readonly loginHint = 'Log in to GitHub on Main (gh auth login) to run CI on GitHub Actions.'
  private readonly jobsCache = new Map<string, { etag: string; jobs: GitHubJob[] }>()

  private readonly rest: GitHubRest

  constructor(private readonly ports: HostCiPorts, options: CloudRestOptions = {}) {
    this.rest = new GitHubRest(new CloudHttp(ports, 'github', options))
  }

  private gh(args: string[], timeoutMs = 120_000) {
    return providerCommand(this.ports, 'gh', args, async () => {
      let result: string | null = null
      const mirror = args[args.indexOf('-R') + 1]!
      if (args[0] === 'run' && args[1] === 'list') {
        result = await this.rest.list(mirror, args[args.indexOf('--branch') + 1]!)
      } else if (args[0] === 'run' && args[1] === 'view') {
        result = args.includes('--log') ? await this.rest.log(mirror, args[2]!) : await this.rest.view(mirror, args[2]!)
      }
      return result ?? executeCommand(this.ports, this.label, 'gh', args, timeoutMs)
    })
  }

  async ready() {
    return (await this.ports.run('gh', ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000 })).code === 0
  }

  async dispatch(input: CloudDispatchInput) {
    await this.gh(['workflow', 'run', WORKFLOW, '-R', input.mirror, '--ref', input.workflowRef ?? input.branch,
      '-f', `ref=${input.workflowRef ?? input.branch}`,
      '-f', `run_id=${input.runId}`, '-f', `suite=${input.suite}`, '-f', `slice=${input.slice}`,
      '-f', `expected_duration_ms=${input.expectedDurationMs ?? 0}`,
      ...(input.scope ? ['-f', `scope=${input.scope}`] : []), ...(input.files !== undefined ? ['-f', `files=${input.files}`] : []),
      ...(input.defaultBranch ? ['-f', `default_branch=${input.defaultBranch}`] : []),
      ...(input.baseCommit ? ['-f', `base_commit=${input.baseCommit}`] : []),
      ...(input.partition ? ['-f', `partition=${input.partition}`] : []),
      ...(input.durations ? ['-f', `durations=${input.durations}`] : [])])
    return null
  }

  async find(run: CloudRun) {
    const branch = run.dispatch?.input.workflowRef ?? run.dispatch?.input.branch ?? 'main'
    const listed = JSON.parse(await this.gh(['run', 'list', '-R', run.mirror, '--workflow', WORKFLOW, '--branch', branch,
      '--event', 'workflow_dispatch', '--limit', '200', '--json', 'databaseId,displayTitle,status,headSha'], 15_000)) as
      { databaseId: number; displayTitle: string; status?: string; headSha: string }[]
    const matches = listed.filter(value => value.displayTitle === `ci ${run.runId}`)
      .sort((left, right) => left.databaseId - right.databaseId)
    const match = matches.find(value => String(value.databaseId) === run.providerRunId) ?? matches[0]
    if (match && run.provenance && match.headSha !== run.provenance.workflowCommit) {
      await this.cancel({ ...run, providerRunId: String(match.databaseId) })
      throw new DomainError('CI_CLOUD_PROVENANCE_MISMATCH', 'The provider workflow does not match the pinned snapshot.', 409)
    }
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
    const response = await this.rest.jobs(run.mirror, id, cached?.etag)
    if (response) {
      if (response.status === 304 && cached) return cached.jobs
      const jobs = (await this.rest.readJobs(response)).jobs
      this.cacheJobs(id, jobs, response.headers.get('etag'))
      return jobs
    }
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
    this.cacheJobs(id, jobs, etag)
    return jobs
  }

  private cacheJobs(id: string, jobs: GitHubJob[], etag: string | null | undefined) {
    this.jobsCache.delete(id)
    if (etag) this.jobsCache.set(id, { etag, jobs })
    if (this.jobsCache.size > 200) this.jobsCache.delete(this.jobsCache.keys().next().value!)
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
    return this.gh(['run', 'view', run.providerRunId!, '-R', run.mirror, '--log'], 300_000)
  }

  async artifacts(run: CloudRun, directory: string) {
    await rm(directory, { recursive: true, force: true })
    const artifacts = await this.rest.artifacts(run.mirror, run.providerRunId!, directory)
    if (artifacts !== null) return artifacts ? readArtifacts(directory) : noArtifacts
    const downloaded = await this.ports.run('gh', ['run', 'download', run.providerRunId!, '-R', run.mirror,
      '-n', 'durations', '-D', directory], { timeoutMs: 120_000 })
    if (downloaded.code === 0) return readArtifacts(directory)
    if (/^no artifact|^no valid artifacts/i.test(downloaded.stderr.trim())) return noArtifacts
    throw rateLimited(this.label, downloaded.stderr)
      ?? new DomainError('CI_CLOUD_FAILED', 'GitHub Actions artifacts could not be downloaded.', 502)
  }

  async cancel(run: CloudRun) { await this.gh(['run', 'cancel', run.providerRunId!, '-R', run.mirror]) }
}

function circleConclusion(outcome: string | undefined): 'success' | 'failure' | 'cancelled' | null {
  if (outcome === 'succeeded') return 'success'
  if (outcome === 'canceled') return 'cancelled'
  const failures = ['failed', 'errored', 'unauthorized', 'not_run', 'skipped', 'infrastructure_fail', 'timedout']
  return failures.includes(outcome ?? '') ? 'failure' : null
}

/** Large Linux machines (4 vCPUs, 15 GB); the free plan runs 30 jobs at once and open-source Linux builds are free. */
export class CircleCiProvider implements CloudProvider {
  readonly id = 'circleci' as const
  readonly label = 'CircleCI'
  readonly userSystemd = { supported: true, reason: null }
  /** CircleCI rejects pipeline parameter values longer than 512 characters. */
  readonly parameterLimit = 500
  readonly slots = 28
  readonly cpus = 4
  readonly memoryBytes = 15 * 2 ** 30
  readonly loginHint = 'Log in to CircleCI on Main (circleci auth login) and follow the CI mirror project to run CI there.'

  private readonly rest: CircleRest

  constructor(private readonly ports: HostCiPorts, options: CloudRestOptions = {}) {
    this.rest = new CircleRest(new CloudHttp(ports, 'circleci', options))
  }

  private circleci(args: string[], timeoutMs = 120_000) {
    return providerCommand(this.ports, 'circleci', args, async () => {
      const result = await this.rest.command(args, timeoutMs)
      return result ?? executeCommand(this.ports, this.label, 'circleci', args, timeoutMs)
    })
  }

  async ready() { return (await this.ports.run('circleci', ['auth', 'me'], { timeoutMs: 15_000 })).code === 0 }

  async dispatch(input: CloudDispatchInput) {
    validateProviderParameters(this, input)
    const started = JSON.parse(await this.circleci(['run', 'trigger', '--project', `gh/${input.mirror}`,
      '--branch', input.workflowRef ?? input.branch,
      '--parameter', `run_id=${input.runId}`, '--parameter', `suite=${input.suite}`,
      '--parameter', `slice=${input.slice}`, '--parameter', `expected_duration_ms=${input.expectedDurationMs ?? 0}`, ...(input.scope ? ['--parameter', `scope=${input.scope}`] : []),
      ...(input.files !== undefined ? ['--parameter', `files=${input.files}`] : []),
      ...(input.defaultBranch ? ['--parameter', `default_branch=${input.defaultBranch}`] : []),
      ...(input.baseCommit ? ['--parameter', `base_commit=${input.baseCommit}`] : []),
      ...(input.partition ? ['--parameter', `partition=${input.partition}`] : []),
      ...(input.durations ? ['--parameter', `durations=${input.durations}`] : []), '--json'])) as { id: string }
    return started.id
  }

  async find(run: CloudRun) {
    if (!run.providerRunId) return null
    const view = await this.pipeline(run, 15_000)
    const terminal = view.phase === 'ended' && circleConclusion(view.outcome ?? view.current_outcome) !== null
    return view.workflows?.length || terminal ? run.providerRunId : null
  }

  private async pipeline(run: CloudRun, timeoutMs?: number) {
    const view = JSON.parse(await this.circleci(['run', 'get', run.providerRunId!, '--json'], timeoutMs)) as {
      state?: string; phase?: string; outcome?: string; current_outcome?: string; stopped_at?: string
      errors?: { type: string; message: string }[]
      workflows?: { phase?: string; outcome?: string; stopped_at?: string; jobs?: { id: string }[] }[]
    }
    // A CLI placeholder outcome cannot finish a pipeline that is still waiting for workflows.
    const pendingState = [view.state, view.phase].some(state => state === 'created' || state === 'setup-pending')
    const notStarted = (view.outcome ?? view.current_outcome) === 'not_run' && !view.errors?.length
    const waiting = !view.workflows?.length && (pendingState || notStarted)
    if (waiting) return { ...view, phase: 'started', outcome: undefined, current_outcome: undefined }
    if (view.errors?.length && (view.phase === 'ended' || view.current_outcome === 'not_run')) {
      const message = view.errors.map(error => `${error.type}: ${error.message}`).join('; ')
      throw new DomainError('CI_CLOUD_PIPELINE_FAILED', `${this.label} pipeline failed: ${message}`, 502,
        { configError: view.errors.some(error => error.type === 'config') })
    }
    return view
  }

  private async job(run: CloudRun) {
    const view = await this.pipeline(run)
    return { job: view.workflows?.flatMap(workflow => workflow.jobs ?? [])[0] ?? null }
  }

  async status(run: CloudRun): Promise<CloudStatus> {
    const view = await this.pipeline(run)
    const workflows = view.workflows ?? []
    const pipelineEnded = view.phase === 'ended'
    const workflowsEnded = workflows.length > 0 && workflows.every(workflow => workflow.phase === 'ended')
    const ended = pipelineEnded || workflowsEnded
    let finalOutcomes: (string | undefined)[] = []
    const pipelineOutcome = view.outcome ?? view.current_outcome
    if (pipelineEnded && pipelineOutcome !== undefined) finalOutcomes = [pipelineOutcome]
    else if (ended) finalOutcomes = workflows.map(workflow => workflow.outcome)
    const stopped = [view.stopped_at, ...workflows.map(workflow => workflow.stopped_at)]
      .filter((value): value is string => value !== undefined).sort().at(-1)
    const hasFinalOutcome = finalOutcomes.some(outcome => outcome !== undefined)
    // Terminal parent status wins over child records that CircleCI has not updated yet.
    if (ended && workflows.every(workflow => !workflow.jobs?.length)) {
      return this.completed(finalOutcomes, stopped, [])
    }
    let jobs
    try {
      jobs = await Promise.all(workflows.flatMap(workflow => workflow.jobs ?? []).map(async job => ({
        id: job.id,
        detail: JSON.parse(await this.circleci(['job', 'get', job.id, '--json'])) as {
          phase: string; outcome?: string; stopped_at?: string
          executions?: { steps?: { num: number; name: string; phase: string; outcome?: string }[] }[]
        },
      })))
    } catch (error) {
      // The parent outcome still settles a finished pipeline when its step details are unavailable.
      if (ended && hasFinalOutcome) return this.completed(finalOutcomes, stopped, [])
      throw error
    }
    const raw = jobs.flatMap(job => job.detail.executions?.flatMap(execution =>
      (execution.steps ?? []).map(step => ({ ...step, jobId: job.id }))) ?? [])
    const key = (step: { jobId: string; num: number }) => `${step.jobId}:${step.num}`
    const steps = raw.map(step => ({ key: key(step), name: step.name, state: step.phase !== 'ended' ? 'running' as const
      : step.outcome === 'succeeded' ? 'passed' as const : step.outcome === 'skipped' ? 'skipped' as const : 'failed' as const }))
    if (ended && hasFinalOutcome) return this.completed(finalOutcomes, stopped, steps)
    const pending = !ended && (view.phase !== undefined && view.phase !== 'ended'
      || workflows.some(workflow => workflow.phase !== undefined && workflow.phase !== 'ended'
        || !workflow.jobs?.length && workflow.phase !== 'ended' && view.phase !== 'ended')
      || jobs.some(job => job.detail.phase !== 'ended') || !workflows.length)
    if (pending) {
      // CircleCI serves a running step's output so far; it is read whole, so only the running step is read.
      const current = raw.findLast(step => step.phase !== 'ended')
      if (!current) return { done: false, steps }
      const output = await this.rest.output(current.jobId, current.num, 60_000)
      if (output !== null) {
        return { done: false, steps, ...(output.ok ? { output: { key: key(current), text: output.text } } : {}) }
      }
      const result = await this.ports.run('circleci', ['job', 'output', 'get', current.jobId, '--step-num', String(current.num)],
        { timeoutMs: 60_000 })
      if (result.code !== 0) {
        const limited = rateLimited(this.label, result.stderr)
        if (limited) throw limited
        return { done: false, steps }
      }
      return { done: false, steps, output: { key: key(current), text: result.stdout } }
    }
    const outcomes = [view.outcome, ...workflows.map(workflow => workflow.outcome),
      ...jobs.filter(job => job.detail.phase === 'ended').map(job => job.detail.outcome)]
      .filter((outcome): outcome is string => outcome !== undefined)
    const finishedAt = [stopped, ...jobs.map(job => job.detail.stopped_at)]
      .filter((value): value is string => value !== undefined).sort().at(-1)
    return this.completed(outcomes, finishedAt, steps)
  }

  private completed(outcomes: (string | undefined)[], stopped: string | undefined, steps: CloudStep[]): CloudStatus {
    const conclusions = outcomes.map(circleConclusion)
    const failed = conclusions.includes('failure')
    if (!failed && (!conclusions.length || conclusions.includes(null))) return { done: false, steps }
    let conclusion: 'success' | 'failure' | 'cancelled' = 'success'
    if (failed) conclusion = 'failure'
    else if (conclusions.includes('cancelled')) conclusion = 'cancelled'
    return { done: true, finishedAt: stopped ?? this.ports.now().toISOString(), steps, conclusion }
  }

  async log(run: CloudRun) {
    const view = await this.pipeline(run)
    const logs = await Promise.all((view.workflows ?? []).flatMap(workflow => workflow.jobs ?? []).map(async job => {
      const detail = JSON.parse(await this.circleci(['job', 'get', job.id, '--json'])) as {
        executions?: { steps?: { num: number; name: string; outcome?: string }[] }[]
      }
      const suite = (detail.executions ?? []).flatMap((execution, index) => (execution.steps ?? [])
        .filter(step => step.name === 'Suite' && step.outcome !== 'skipped')
        .map(step => ({ ...step, execution: index })))
      if (!suite.length) return this.circleci(['job', 'output', 'list', job.id, '--tail', '0'], 300_000)
      // Terminal replay can erase stderr failure lines; raw output preserves both streams.
      const output = await Promise.all(suite.map(step => this.circleci(['job', 'output', 'get', job.id,
        '--step-num', String(step.num), '--execution', String(step.execution), '--strip-ansi=false'], 300_000)))
      return `Suite\n${output.join('\n')}`
    }))
    return logs.join('\n')
  }

  async artifacts(run: CloudRun, directory: string) {
    const { job } = await this.job(run)
    if (!job) return noArtifacts
    // Read result metadata, not the per-slot logs and archives, which can outlast the download timeout.
    const listed = await this.rest.artifacts(run.mirror, job.id)
      ?? await this.circleci(['job', 'artifact', job.id, '--json'], 60_000)
    const finishedAt = Date.parse(run.finishedAt ?? '')
    if ((JSON.parse(listed) as unknown[]).length === 0 && run.state === 'passed'
      && !(this.ports.now().getTime() - finishedAt >= ARTIFACT_VISIBILITY_MS)) {
      // CircleCI lists a finished job's uploads with a delay; a passed job must not complete without its results.
      throw new DomainError('CI_CLOUD_FAILED', 'CircleCI job artifacts are not visible yet.', 502)
    }
    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { recursive: true })
    const resultPaths = new Set(['durations/durations.json', 'durations/test-results.json',
      'durations/watchdog-message.json', 'durations/suite.log'])
    for (const artifact of (JSON.parse(listed) as { path: string; url: string }[])
      .filter(value => resultPaths.has(value.path) || run.suite === 'integration'
        && /^integration-logs\/[^/]+\/summary\.json$/.test(value.path))) {
      if (await this.rest.download(artifact.url, join(directory, basename(artifact.path)))) continue
      await command(this.ports, this.label, 'curl',
        ['-fsSL', '--max-time', '60', '-o', join(directory, basename(artifact.path)), artifact.url], 70_000)
    }
    const artifacts = await readArtifacts(directory)
    if (run.suite === 'integration') {
      const summary = await findFile(directory, 'summary.json')
      artifacts.testResults = circleCiIntegrationResults(artifacts.testResults,
        summary ? JSON.parse(await readFile(summary, 'utf8')) as unknown : null)
    }
    return artifacts
  }

  async cancel(run: CloudRun) {
    let view: { phase?: string; workflows?: unknown[] } | null
    try {
      view = JSON.parse(await this.circleci(['run', 'get', run.providerRunId!, '--json'], 15_000)) as typeof view
    } catch (error) {
      if (!(error instanceof DomainError
        && ['CI_CLOUD_RUN_NOT_FOUND', 'CI_CLOUD_RUN_UNREADABLE'].includes(error.code))) throw error
      // Cancellation of the known pipeline does not require a successful status lookup.
      view = null
    }
    if (view?.phase === 'ended' && !view.workflows?.length) return
    await this.circleci(['run', 'cancel', run.providerRunId!, '--force'], 15_000)
  }
}
