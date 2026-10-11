import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CiExecutionSuite, CiScope } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { HostCiPorts } from './runner.js'
import type { CloudRun } from './cloud.js'

export type CloudStatus = { done: false } | { done: true; conclusion: 'success' | 'failure' | 'cancelled'; finishedAt: string }
export interface CloudDispatchInput {
  mirror: string; branch: string; runId: string; suite: CiExecutionSuite; slice: string
  scope?: CiScope; files?: string; defaultBranch?: string; partition?: string; durations?: string
}

/** One cloud CI service: how Main starts a run of a mirror branch and reads it back, through the service's CLI login. */
export interface CloudProvider {
  readonly id: 'github' | 'circleci'
  readonly label: string
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
  /** The measured test file durations the run left as an artifact. */
  durations(run: CloudRun, directory: string): Promise<unknown>
  cancel(run: CloudRun): Promise<void>
}

async function command(ports: HostCiPorts, label: string, file: string, args: string[], timeoutMs = 120_000) {
  const result = await ports.run(file, args, { timeoutMs })
  if (result.code !== 0) {
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

const WORKFLOW = 'ci.yml'

/** Standard public-repository runners: 4 vCPUs and 16 GB; a free account runs 20 jobs at once. */
export class GitHubActionsProvider implements CloudProvider {
  readonly id = 'github' as const
  readonly label = 'GitHub Actions'
  readonly slots = 16
  readonly cpus = 4
  readonly memoryBytes = 16 * 2 ** 30
  readonly loginHint = 'Log in to GitHub on Main (gh auth login) to run CI on GitHub Actions.'

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

  async status(run: CloudRun): Promise<CloudStatus> {
    const view = JSON.parse(await this.gh(['run', 'view', run.providerRunId!, '-R', run.mirror, '--json',
      'status,conclusion,updatedAt'])) as { status: string; conclusion: string; updatedAt: string }
    if (view.status !== 'completed') return { done: false }
    return { done: true, finishedAt: view.updatedAt,
      conclusion: view.conclusion === 'success' ? 'success' : view.conclusion === 'cancelled' ? 'cancelled' : 'failure' }
  }

  async log(run: CloudRun) {
    return (await this.ports.run('gh', ['run', 'view', run.providerRunId!, '-R', run.mirror, '--log'], { timeoutMs: 300_000 })).stdout
  }

  async durations(run: CloudRun, directory: string) {
    const downloaded = await this.ports.run('gh', ['run', 'download', run.providerRunId!, '-R', run.mirror,
      '-n', 'durations', '-D', directory], { timeoutMs: 120_000 })
    const path = downloaded.code === 0 ? await findFile(directory, 'durations.json') : null
    return path ? JSON.parse(await readFile(path, 'utf8')) as unknown : null
  }

  async cancel(run: CloudRun) { await this.gh(['run', 'cancel', run.providerRunId!, '-R', run.mirror]) }
}

/** Large Linux machines (4 vCPUs, 15 GB); the free plan runs 30 jobs at once and open-source Linux builds are free. */
export class CircleCiProvider implements CloudProvider {
  readonly id = 'circleci' as const
  readonly label = 'CircleCI'
  readonly slots = 28
  readonly cpus = 4
  readonly memoryBytes = 15 * 2 ** 30
  readonly loginHint = 'Log in to CircleCI on Main (circleci auth login) and follow the CI mirror project to run CI there.'

  constructor(private readonly ports: HostCiPorts) {}

  private circleci(args: string[], timeoutMs?: number) { return command(this.ports, this.label, 'circleci', args, timeoutMs) }

  async ready() { return (await this.ports.run('circleci', ['auth', 'me'], { timeoutMs: 15_000 })).code === 0 }

  async dispatch(input: CloudDispatchInput) {
    const started = JSON.parse(await this.circleci(['run', 'trigger', '--project', `gh/${input.mirror}`, '--branch', input.branch,
      '--parameter', `run_id=${input.runId}`, '--parameter', `suite=${input.suite}`,
      '--parameter', `slice=${input.slice}`, ...(input.scope ? ['--parameter', `scope=${input.scope}`] : []),
      ...(input.files !== undefined ? ['--parameter', `files=${input.files}`] : []),
      ...(input.defaultBranch ? ['--parameter', `default_branch=${input.defaultBranch}`] : []),
      ...(input.partition ? ['--parameter', `partition=${input.partition}`] : []),
      ...(input.durations ? ['--parameter', `durations=${input.durations}`] : []), '--json'])) as { id: string }
    return started.id
  }

  async find(run: CloudRun) {
    if (!run.providerRunId) return null
    const view = JSON.parse(await this.circleci(['run', 'get', run.providerRunId, '--json'], 15_000)) as
      { workflows?: unknown[] }
    return view.workflows?.length ? run.providerRunId : null
  }

  private async job(run: CloudRun) {
    const view = JSON.parse(await this.circleci(['run', 'get', run.providerRunId!, '--json'])) as
      { workflows?: { jobs?: { id: string }[] }[] }
    return { job: view.workflows?.[0]?.jobs?.[0] ?? null }
  }

  async status(run: CloudRun): Promise<CloudStatus> {
    const { job } = await this.job(run)
    if (!job) return { done: false }
    const detail = JSON.parse(await this.circleci(['job', 'get', job.id, '--json'])) as
      { phase: string; outcome?: string; stopped_at?: string }
    if (detail.phase !== 'ended') return { done: false }
    return { done: true, finishedAt: detail.stopped_at ?? new Date().toISOString(),
      conclusion: detail.outcome === 'succeeded' ? 'success' : detail.outcome === 'canceled' ? 'cancelled' : 'failure' }
  }

  async log(run: CloudRun) {
    const { job } = await this.job(run)
    if (!job) return ''
    return (await this.ports.run('circleci', ['job', 'output', 'list', job.id], { timeoutMs: 300_000 })).stdout
  }

  async durations(run: CloudRun, directory: string) {
    const { job } = await this.job(run)
    if (!job) return null
    await this.ports.run('circleci', ['job', 'artifact', job.id, '--output', directory], { timeoutMs: 120_000 })
    const path = await findFile(directory, 'durations.json')
    return path ? JSON.parse(await readFile(path, 'utf8')) as unknown : null
  }

  async cancel(run: CloudRun) {
    const view = JSON.parse(await this.circleci(['run', 'get', run.providerRunId!, '--json'])) as
      { phase?: string; workflows?: unknown[] }
    if (view.phase === 'ended' && !view.workflows?.length) return
    await this.circleci(['run', 'cancel', run.providerRunId!, '--force'])
  }
}
