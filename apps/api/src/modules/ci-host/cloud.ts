import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir, hostname, userInfo } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import type pg from 'pg'
import { CiWatchdogFailureSchema, CiDurationsSchema, CiHostReplySchema, CiHostRequestSchema, CiTestResultsSchema, WorkspaceSchema,
  integrationPartition, requiresUserSystemd,
  type CiDurations, type CiHostReply, type CiHostRequest, type CiHostRun, type CiPartition } from '@foreman-code/contracts'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import { ensureClone, ensureCommit, fetchRepositoryBranch, systemGitWorktreePorts, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { systemHostCiPorts, type HostCiPorts } from './runner.js'
import type { HostCiComputer } from './service.js'
import type { CiMirrorInput } from './serviceTypes.js'
import { CLOUD_START_TIMEOUT_MS, CircleCiProvider, GitHubActionsProvider, validateProviderParameters,
  type CloudDispatchInput, type CloudProvider, type CloudRun, type CloudStatus } from './cloudProviders.js'
import { runsOnCircleCi } from './parts.js'
import { pruneMirrorBranches, type ActiveCiRuns } from './mirrorBranches.js'
import { fallbackOnError } from '../diagnostics/ignoredError.js'
import { readCloudRun, saveCloudRun } from './cloudJournal.js'
import { ciLogPage } from './logPage.js'
import { sanitizeCiText } from './text.js'
import { withProviderPoll } from './providerPoll.js'

const LOG_LIMIT = 4 * 1024 * 1024
const MAX_DISPATCH_ATTEMPTS = 3
/** A running run asks its service at most this often; reads in between answer from the kept state and log. */
const POLL_MS = 4_000
const FINISH_POLL_MS = 2_000
const FINISH_WINDOW_MS = 3_000
const MAX_BACKOFF_MS = 10 * 60_000
const MIN_STALL_MS = 15 * 60_000
const EXPECTED_DURATION_MULTIPLIER = 3
/** Status reads are cheap and must cover a full provider fleet without serial polling waves. */
const POLL_CONCURRENCY = 24
const PRUNE_INTERVAL_MS = 5 * 60_000
const log = componentLogger('jobs')

export type { CloudRun }
type Mirrors = (workspaceId: string) => Promise<string | null>
/** Pushes to one mirror, across both services, run one at a time: concurrent force-pushes of the mirror's main fail
 * the remote's old-value check ("incorrect old value provided"), and concurrent fetches race on its local ref. */
const mirrorPushes = new Map<string, Promise<unknown>>()
const pendingPublications = new Map<string, Promise<void>>()
const cloudOperations = new Map<string, Promise<unknown>>()
const publishingBranches = new Map<string, Set<string>>()
interface Publication {
  git: (args: string[]) => Promise<string>
  branch: string
  snapshot: string
  workflowRef: string
  mirrorPublication: NonNullable<CiHostRun['mirrorPublication']>
  workflows: string[]
  defaultBranch?: string
  baseCommit?: string
}
interface MirrorMaintenance {
  at: number
  cleanup: Promise<void> | undefined
  keep: Set<string>
  pendingFinishedRuns: Set<string>
}
const mirrorPublications = new Map<string, Map<string, Promise<Publication>>>()
const mirrorMaintenance = new Map<string, MirrorMaintenance>()

/** The public mirror belonging to this workspace, if any. */
export function workspaceMirrors(pool: pg.Pool): Mirrors {
  return async workspaceId => {
    const row = (await pool.query<{ record: unknown }>(`select record from workspaces
      where id=$1 and archived_at is null`, [workspaceId])).rows[0]
    const mirror = row ? WorkspaceSchema.parse(row.record).ciMirror : undefined
    return mirror ? `${mirror.owner}/${mirror.name}` : null
  }
}

/** Main owns ticket completion even when the last attempt ran on a different provider. */
export async function activeCiRuns(pool: pg.Pool): Promise<ActiveCiRuns> {
  const readAt = Date.now()
  const rows = (await pool.query<{ id: string; retry_id: string | null }>(
    "select id,record#>>'{setupRetry,runId}' as retry_id from ci_runs where state in ('queued','starting','running')")).rows
  return { ids: new Set(rows.flatMap(row => row.retry_id ? [row.id, row.retry_id] : [row.id])), readAt }
}

/** A cloud CI service on a workspace's public mirror as CI computers: one slot per concurrent job. A run pushes the
 * commit's files to the mirror as one commit without history, starts the provider's run of them, and reads the
 * result, log and measured durations back. */
export class CloudCi {
  private activeRuns: (() => Promise<ActiveCiRuns>) | undefined
  private checked: { at: number; ready: boolean } | undefined
  private reconciling: Promise<void> | undefined
  private readonly polled = new Map<string, number>()
  private reconcileCursor = 0
  private backoff = { until: 0, ms: 0 }
  private following = 0
  private readonly waiting: { run: CloudRun; resume: () => void }[] = []
  private readonly reading = new Set<string>()

  constructor(private readonly mainId: string, readonly provider: CloudProvider, private readonly mirrors: Mirrors,
    private readonly root = join(homedir(), '.local/share/foreman-code/ci-cloud', provider.id),
    private readonly ports: HostCiPorts = systemHostCiPorts(),
    private readonly git: GitWorktreePorts = systemGitWorktreePorts(),
    private readonly identity = { home: homedir(), user: userInfo().username, host: hostname() }) {}

  async publishMirror(input: CiMirrorInput): Promise<void> {
    await this.publish(input.repository, input.mirror, input.commit,
      input.defaultBranch, input.baseCommit, input.durations ?? {})
  }

  setActiveRunLookup(lookup: () => Promise<ActiveCiRuns>) {
    this.activeRuns = lookup
  }

  /** Waits for background sweeps before their repository can be removed. Call after ticket operations finish. */
  async waitForMirrorCleanup(repository: string, mirror: string) {
    await this.reconciling
    const key = this.mirrorKey(repository, mirror)
    await Promise.all([...pendingPublications].filter(([id]) => id.startsWith(`${this.root}\n`))
      .map(([, task]) => task))
    let cleanup = mirrorMaintenance.get(key)?.cleanup
    while (cleanup) {
      await cleanup
      // A completed sweep can schedule another pass for tickets canceled during that sweep.
      cleanup = mirrorMaintenance.get(key)?.cleanup
    }
  }

  computers(priority = 30): HostCiComputer[] {
    return Array.from({ length: this.provider.slots }, (_, slot) => ({ key: `${this.mainId}:cloud:${this.provider.id}:${slot}`,
      hostRef: { kind: 'cloud' as const, mainId: this.mainId, provider: this.provider.id, slot },
      label: `${this.provider.label} ${slot + 1}`, priority, userSystemd: this.provider.userSystemd }))
  }

  async handle(raw: unknown): Promise<CiHostReply> {
    const request = CiHostRequestSchema.parse(raw)
    if (request.operation === 'status') {
      // Recovery of an old ticket must not delay readiness for every slot of this provider.
      void this.reconcile().catch(error => {
        log.warn({ err: error, provider: this.provider.id }, 'Cloud CI recovery sweep failed')
      })
      const ready = await this.ready()
      return CiHostReplySchema.parse({ operation: 'status', ready, reasons: ready ? [] : [this.provider.loginHint],
        cpuCount: this.provider.cpus, memoryBytes: this.provider.memoryBytes,
        userSystemd: this.provider.userSystemd, runs: [] })
    }
    if (request.operation === 'read' && (this.reading.has(request.runId)
      || pendingPublications.has(`${this.root}\n${request.runId}`))) {
      // Publication and provider work answer reads from the journal while they continue in the background.
      return this.answer(request, await this.read(request.runId))
    }
    return this.serializeRun(request.runId, () => this.handleRun(request))
  }

  private async serializeRun<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const key = `${this.root}\n${runId}`
    const previous = cloudOperations.get(key) ?? Promise.resolve()
    const operation = previous.then(work, work)
    cloudOperations.set(key, operation)
    try {
      return await operation
    } finally {
      if (cloudOperations.get(key) === operation) cloudOperations.delete(key)
    }
  }

  private async handleRun(request: Exclude<CiHostRequest, { operation: 'status' }>) {
    if (request.operation === 'start') return CiHostReplySchema.parse({ operation: 'start', run: await this.start(request) })
    if (request.operation === 'cancel') {
      let run = await this.read(request.runId)
      if (['queued', 'starting', 'running'].includes(run.state)) {
        run = await this.save({ ...run, state: 'canceled', finishedAt: this.ports.now().toISOString(), message: 'Canceled.',
          cancellation: run.cancellation ?? { at: this.ports.now().toISOString(), canceledIds: [] } })
      }
      const canceled = run.cancellation && run.mirrorPublication?.state !== 'pending'
        ? await this.cancelAttempts(run) : run
      this.schedulePrune(canceled, canceled.runId)
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
    const page = await this.logPage(run.runId, request.afterOffset, request.maxBytes).catch(fallbackOnError(
      { text: '', nextOffset: request.afterOffset, logBytes: 0 },
      'jobs', 'read CI log', { runId: run.runId }, ['ENOENT'],
    ))
    if (!['starting', 'running', 'queued'].includes(run.state)) this.schedulePrune(run, run.runId)
    const view = this.view(run, page.logBytes)
    if (request.testResults && view.collection === 'complete' && !run.testResults) view.collection = 'unsupported'
    return CiHostReplySchema.parse({ operation: 'read', run: view,
      text: sanitizeCiText(page.text), nextOffset: page.nextOffset,
      ...(request.durations && run.durations ? { durations: run.durations } : {}),
      ...(request.testResults && run.testResults ? { testResults: run.testResults } : {}) })
  }

  private async logPage(runId: string, afterOffset: number, maxBytes: number) {
    const handle = await open(this.path(runId, 'log'), 'r')
    try {
      const { size } = await handle.stat()
      const length = Math.min(maxBytes, Math.max(0, size - afterOffset))
      if (!length) return { text: '', nextOffset: afterOffset, logBytes: size }
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, afterOffset)
      const page = ciLogPage(buffer.subarray(0, bytesRead), 0, maxBytes)
      return { text: page.text, nextOffset: afterOffset + page.nextOffset, logBytes: size }
    } finally {
      await handle.close()
    }
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
    return readCloudRun(this.path(runId, 'meta.json'))
  }

  private save(run: CloudRun) {
    return saveCloudRun(this.path(run.runId, 'meta.json'), run)
  }

  private view(run: CloudRun, logBytes: number): CiHostRun {
    let step: string | null = run.part ?? run.suite
    if (run.state === 'running' && run.live?.step) step = run.live.step
    if (run.state === 'starting') step = run.mirrorPublication?.state === 'pending' ? 'publish mirror' : 'dispatch'
    if (run.state === 'queued') step = null
    return { runId: run.runId, state: run.state, step,
      exitCode: run.exitCode, startedAt: run.startedAt, finishedAt: run.finishedAt, logBytes, message: run.message === null ? null : sanitizeCiText(run.message),
      ...(run.provenance ? { provenance: run.provenance } : {}),
      ...(run.mirrorPublication ? { mirrorPublication: run.mirrorPublication } : {}),
      ...(run.testsStarted !== undefined ? { testsStarted: run.testsStarted } : {}),
      ...(run.collection ? { collection: run.collection.log && run.collection.artifacts ? 'complete' as const : 'pending' as const } : {}) }
  }

  private async start(request: Extract<CiHostRequest, { operation: 'start' }>): Promise<CiHostRun> {
    const existing = await this.read(request.runId).catch(error => {
      if (error instanceof DomainError && error.code === 'CI_RUN_UNKNOWN') return null
      throw error
    })
    if (existing) {
      if (existing.publicationRequest && existing.state === 'starting') this.publishInBackground(existing)
      return this.view(existing, 0)
    }
    if (!this.provider.userSystemd.supported && request.suite === 'integration'
      && (request.partition?.hostIndexes?.includes(request.partition.index)
      || !request.partition && request.files?.some(requiresUserSystemd))) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE',
        `${this.provider.label} cannot run user-systemd files: ${this.provider.userSystemd.reason ?? 'user systemd is unavailable'}.`, 409)
    }
    let mirror = request.ciMirror ?? null
    if (request.ciMirror === undefined && request.workspaceId) mirror = await this.mirrors(request.workspaceId)
    // CircleCI's machine image has no podman, which the Worker unit tests (unit-other) use.
    if (this.provider.id === 'circleci' && !runsOnCircleCi(request)) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE', `${this.provider.label} cannot run the Worker unit tests (no podman).`, 409)
    }
    if (!mirror || !await this.ready()) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE', `This workspace has no CI mirror, or Main is not logged in to ${this.provider.label}.`, 409)
    }
    if (request.deferMirror) {
      const startedAt = this.ports.now().toISOString()
      const pending = await this.save({ runId: request.runId, repository: request.repository, mirror,
        commit: request.commit, suite: request.suite, startedAt, state: 'starting', providerRunId: null,
        finishedAt: null, exitCode: null, message: 'Publishing the checked CI mirror snapshot.',
        publicationRequest: request, mirrorPublication: { state: 'pending', startedAt, finishedAt: null } })
      this.publishInBackground(pending)
      return this.view(pending, 0)
    }
    return this.publishAndStart(request, mirror)
  }

  private publishInBackground(run: CloudRun) {
    const key = `${this.root}\n${run.runId}`
    if (pendingPublications.has(key)) return
    const task = this.publishAndStart(run.publicationRequest!, run.mirror).then(() => undefined).catch(async error => {
      log.warn({ err: error, runId: run.runId }, 'CI mirror publication failed')
      await this.serializeRun(run.runId, async () => {
        const latest = await this.read(run.runId)
        if (latest.state !== 'starting') return
        if (latest.mirrorPublication?.state === 'ready' && latest.dispatch) {
          await this.save({ ...latest, message: 'Cloud dispatch reply was not confirmed; ownership retained.' })
          return
        }
        const unavailable = error instanceof DomainError && error.code === 'CI_CLOUD_UNAVAILABLE'
        const failed: CloudRun = { ...latest, state: unavailable ? 'queued' : 'failed',
          finishedAt: unavailable ? null : this.ports.now().toISOString(),
          message: sanitizeCiText(error instanceof Error ? error.message : String(error)).slice(0, 2000),
          mirrorPublication: latest.mirrorPublication?.state === 'ready' ? latest.mirrorPublication
            : { ...latest.mirrorPublication!, state: 'failed', finishedAt: this.ports.now().toISOString() } }
        delete failed.publicationRequest
        await this.save(failed)
      })
    }).catch(error => {
      log.error({ err: error, runId: run.runId }, 'CI mirror failure could not be recorded; recovery will retry')
    }).finally(() => {
      pendingPublications.delete(key)
    })
    pendingPublications.set(key, task)
  }

  private async publishAndStart(request: Extract<CiHostRequest, { operation: 'start' }>, mirror: string) {
    const scope = request.scope ?? 'affected'
    const deriveFiles = scope === 'affected' && request.files === undefined
    const branchName = deriveFiles && request.baseCommit ? `ci/${request.commit}-${request.baseCommit}`
      : `ci/${request.commit}`
    const reservations = publishingBranches.get(mirror) ?? new Set<string>()
    // Keep each start separately: releasing one partition must not release a concurrent one.
    const reservation = `${request.runId}\n${branchName}`
    reservations.add(reservation)
    publishingBranches.set(mirror, reservations)
    const maintenance = mirrorMaintenance.get(this.mirrorKey(request.repository, mirror))
    if (maintenance?.cleanup) {
      maintenance.keep.add(branchName)
      maintenance.keep.add(`ci-default/${request.commit}`)
    }
    try {
      const publication = await this.publish(request.repository, mirror, request.commit,
        deriveFiles && !request.baseCommit ? request.defaultBranch ?? 'main' : undefined,
        deriveFiles ? request.baseCommit : undefined, request.durations ?? {})
      if (request.deferMirror) {
        return await this.serializeRun(request.runId, async () => {
          const latest = await this.read(request.runId)
          const completed = { ...latest, mirrorPublication: publication.mirrorPublication }
          delete completed.publicationRequest
          await this.save(completed)
          if (latest.state !== 'starting' || latest.cancellation) return this.view(completed, 0)
          return this.startPublished(request, mirror, publication)
        })
      }
      return await this.startPublished(request, mirror, publication)
    } finally {
      reservations.delete(reservation)
      if (!reservations.size) publishingBranches.delete(mirror)
    }
  }

  private async startPublished(request: Extract<CiHostRequest, { operation: 'start' }>,
    mirror: string, publication: Publication): Promise<CiHostRun> {
    const { git, branch, snapshot, workflowRef, defaultBranch, baseCommit, mirrorPublication } = publication
    const scope = request.scope ?? 'affected'
    const deriveFiles = scope === 'affected' && request.files === undefined
    this.schedulePrune({ repository: request.repository, mirror })
    const selectOnRunner = deriveFiles && (defaultBranch !== undefined || baseCommit !== undefined)
    const message = deriveFiles && !selectOnRunner
      ? 'Running full suite: ' + (request.baseCommit
        ? 'baseCommit is unavailable or is not an ancestor of the resolved commit.'
        : 'No merge-base with the workspace default branch is available.') : null
    let slice = request.suite === 'integration' && !selectOnRunner
      && (request.gate || request.partition || !deriveFiles && scope === 'affected')
      ? await this.slice(git, snapshot, request.partition, request.durations ?? {}, request.files) : ''
    if ((!request.files || scope !== 'affected') && request.partition && request.part) {
      slice = `${request.partition.index + 1}/${request.partition.count}`
    }
    const files = scope === 'affected' && request.files !== undefined && request.suite !== 'integration'
      ? await this.selectedIndexes(git, snapshot, request.files) : undefined
    // The snapshot carries learned timings even when a provider parameter cannot hold them.
    const limit = this.provider.parameterLimit ?? Number.POSITIVE_INFINITY
    let partition = selectOnRunner && request.partition ? JSON.stringify(request.partition) : undefined
    if (slice.length > limit && request.suite === 'integration' && request.partition
      && (scope === 'full' || message !== null) && request.files === undefined) {
      slice = ''
      partition = JSON.stringify(request.partition)
    }
    const durations = selectOnRunner && request.durations ? JSON.stringify(request.durations) : undefined
    const input: CloudDispatchInput = { mirror, branch, workflowRef, workflowCommit: snapshot, runId: request.runId, suite: request.part ?? request.suite, slice,
      expectedDurationMs: request.expectedDurationMs ?? 0,
      scope: message ? 'full' : scope, ...(files !== undefined ? { files } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(partition ? { partition } : {}),
      ...(durations && durations.length <= limit ? { durations } : {}) }
    validateProviderParameters(this.provider, input)
    let run = await this.save({ mirrorBranch: branch, runId: request.runId, repository: request.repository, mirror, commit: request.commit,
      suite: request.suite, ...(request.part ? { part: request.part } : {}), startedAt: this.ports.now().toISOString(), providerRunId: null, state: 'starting',
      scope, ...(request.files !== undefined ? { files: request.files } : {}),
      ...(request.baseCommit ? { baseCommit: request.baseCommit } : {}),
      provenance: { sourceCommit: request.commit, workflowCommit: snapshot, workflowRef },
      finishedAt: null, exitCode: null, message, mirrorPublication,
      dispatch: { input, attempts: 0, at: this.ports.now().toISOString() } })
    run = await this.trigger(run, input)
    if (run.providerRunId) {
      try {
        if (await this.provider.find(run)) run = await this.save({ ...run, state: 'running', workflowStarted: true })
      } catch (error) {
        if (error instanceof DomainError
          && ['CI_CLOUD_PIPELINE_FAILED', 'CI_CLOUD_RUN_ENDED'].includes(error.code)) {
          run = await this.failPipeline(run, { message: error.message, configError: error.details?.configError === true })
        } else {
          // The trigger was accepted, so a lookup failure must not dispatch the ticket to another computer.
          log.warn({ err: error, runId: run.runId }, 'Cloud CI workflow lookup failed; dispatch remains pending')
        }
      }
    }
    return this.view(run, 0)
  }

  private async trigger(run: CloudRun, input: CloudDispatchInput) {
    const pending = await this.save({ ...run, state: 'starting', providerRunId: null,
      dispatch: { input, attempts: (run.dispatch?.attempts ?? 0) + 1, at: this.ports.now().toISOString() } })
    if (this.provider.id === 'circleci') {
      const failed = await readCloudRun(this.configErrorPath(pending)).catch(error => {
        if (error instanceof DomainError && error.code === 'CI_RUN_UNKNOWN') return null
        throw error
      })
      if (failed) return this.failPipeline(pending, { message: failed.message! })
    }
    const providerRunId = await this.provider.dispatch(input)
    return this.save({ ...pending, providerRunId, dispatchHistory: [...pending.dispatchHistory ?? [],
      { at: pending.dispatch!.at, providerRunId }] })
  }

  private configErrorPath(run: CloudRun) {
    const key = createHash('sha256').update(canonicalJson({ mirror: run.mirror, commit: run.commit })).digest('hex')
    return join(this.root, 'config-errors', `${key}.json`)
  }

  private async failPipeline(run: CloudRun, failure: { message: string; configError?: boolean }): Promise<CloudRun> {
    const failed: CloudRun = { ...run, state: 'failed', exitCode: 1, finishedAt: this.ports.now().toISOString(),
      message: sanitizeCiText(failure.message), testsStarted: false, collection: { log: true, artifacts: true } }
    delete failed.reconciliation
    // A rejected pipeline has no job logs or artifacts; keep the provider error as its final log.
    await writeFile(this.path(run.runId, 'log'), `${failed.message}\n`, { flag: 'a', mode: 0o600 })
    if (failure.configError) await saveCloudRun(this.configErrorPath(failed), failed)
    return this.save(failed)
  }

  private async recoverUnstarted(run: CloudRun) {
    const dispatchedAt = run.dispatch?.at ?? run.mirrorPublication?.finishedAt ?? run.startedAt
    if (this.ports.now().getTime() - Date.parse(dispatchedAt) < CLOUD_START_TIMEOUT_MS) return run
    // Retire the pipeline before retrying so it cannot acquire a workflow later.
    if (run.providerRunId) {
      try {
        await this.provider.cancel(run)
      } catch (error) {
        if (error instanceof DomainError && error.code === 'CI_CLOUD_RATE_LIMITED') throw error
        return this.reconcileLookupFailure(run, error)
      }
      if (await this.provider.find(run)) return this.save({ ...run, state: 'running', workflowStarted: true })
    }
    const retry = run.dispatch && run.dispatch.attempts < MAX_DISPATCH_ATTEMPTS
    const message = `${this.provider.label} created no workflow within 75 seconds. `
      + (retry ? `Retrying dispatch (${run.dispatch!.attempts + 1}/${MAX_DISPATCH_ATTEMPTS}).`
        : 'Dispatch retries exhausted; queued for another computer.')
    await writeFile(this.path(run.runId, 'log'), sanitizeCiText(`${message}\n`), { flag: 'a', mode: 0o600 })
    const recovered = { ...run, message }
    delete recovered.reconciliation
    const next = await this.save(recovered)
    if (retry) return this.trigger(next, run.dispatch!.input)
    return this.save({ ...next, state: 'queued', providerRunId: null, finishedAt: null, exitCode: null,
      cancellation: { at: this.ports.now().toISOString(), canceledIds: [] } })
  }

  private mirrorKey(repository: string, mirror: string) {
    return `${this.git.cloneDirectory(repository)}\n${mirror}`
  }

  private publications(repository: string, mirror: string) {
    const key = this.mirrorKey(repository, mirror)
    let publications = mirrorPublications.get(key)
    if (!publications) {
      publications = new Map<string, Promise<Publication>>()
      mirrorPublications.set(key, publications)
    }
    return publications
  }

  private schedulePrune(run: Pick<CloudRun, 'repository' | 'mirror'>, finishedRunId?: string) {
    const key = this.mirrorKey(run.repository, run.mirror)
    const maintenance: MirrorMaintenance = mirrorMaintenance.get(key)
      ?? { at: -Infinity, cleanup: undefined, keep: new Set<string>(), pendingFinishedRuns: new Set<string>() }
    mirrorMaintenance.set(key, maintenance)
    const now = this.ports.now().getTime()
    if (maintenance.cleanup) {
      if (finishedRunId) maintenance.pendingFinishedRuns.add(finishedRunId)
      return
    }
    if (now - maintenance.at < PRUNE_INTERVAL_MS) return
    const finishedRuns = new Set(maintenance.pendingFinishedRuns)
    if (finishedRunId) finishedRuns.add(finishedRunId)
    maintenance.pendingFinishedRuns.clear()
    maintenance.keep.clear()
    for (const reservation of publishingBranches.get(run.mirror) ?? []) {
      const branch = reservation.split('\n')[1]!
      maintenance.keep.add(branch)
      maintenance.keep.add(`ci-default/${branch.slice('ci/'.length).split('-')[0]}`)
    }
    const cleanup = this.prune(run, finishedRuns)
    maintenance.at = now
    maintenance.cleanup = cleanup
    void cleanup.then(() => {
      maintenance.cleanup = undefined
      if (maintenance.pendingFinishedRuns.size) {
        maintenance.at = -Infinity
        this.schedulePrune(run)
      }
    })
  }

  private async prune(run: Pick<CloudRun, 'repository' | 'mirror'>, finishedRuns: ReadonlySet<string>) {
    try {
      const clone = await ensureClone(this.git, run.repository, AbortSignal.timeout(120_000))
      let activeRuns = await this.activeRuns?.()
      if (activeRuns && finishedRuns.size) {
        const ids = new Set(activeRuns.ids)
        for (const runId of finishedRuns) ids.delete(runId)
        activeRuns = { ...activeRuns, ids }
      }
      const publications = this.publications(run.repository, run.mirror)
      const publicationKeys = new Map<string, string[]>()
      for (const key of publications.keys()) {
        const [commit, , baseCommit] = key.split('\n')
        const branch = baseCommit ? `ci/${commit}-${baseCommit}` : `ci/${commit}`
        const keys = publicationKeys.get(branch) ?? []
        keys.push(key)
        publicationKeys.set(branch, keys)
      }
      const reserved = mirrorMaintenance.get(this.mirrorKey(run.repository, run.mirror))!.keep
      await pruneMirrorBranches({ mirror: run.mirror, activeRuns,
        roots: [this.root, join(this.root, '..', 'github'), join(this.root, '..', 'circleci')],
        // Starts during this sweep stay protected even after their reservation becomes a persisted ticket.
        keep: () => reserved,
        beforeRemove: branches => {
          for (const branch of branches) {
            for (const key of publicationKeys.get(branch) ?? []) publications.delete(key)
          }
        },
        git: async args => {
          const result = await this.git.git(args, { cwd: clone, signal: AbortSignal.timeout(120_000) })
          if (result.code !== 0) throw new Error(`CI mirror branch cleanup failed: ${result.stderr.trim().slice(-500)}`)
          return result.stdout.trim()
        } })
    } catch (error) {
      log.warn({ err: error, mirror: run.mirror }, 'CI mirror branch cleanup failed; next ticket read will retry')
    }
  }

  /** Puts the commit's files on the mirror once: every partition of a run starting together shares one push. */
  private async publish(repository: string, mirror: string, commit: string, defaultBranch: string | undefined,
    baseCommit: string | undefined, durations: CiDurations) {
    const key = `${commit}\n${defaultBranch ?? ''}\n${baseCommit ?? ''}\n${canonicalJson(durations)}`
    const publications = this.publications(repository, mirror)
    let published = publications.get(key)
    if (!published) {
      const queued = (mirrorPushes.get(mirror) ?? Promise.resolve()).catch(() => { /* ignore: the previous caller receives its failure; the queue must still admit the next operation. */ })
      const queuedAt = performance.now()
      const startedAt = this.ports.now().toISOString()
      const pushed = queued.then(() => this.push(repository, mirror, commit, defaultBranch, baseCommit, durations,
        { queuedAt, startedAt }))
      published = pushed
      mirrorPushes.set(mirror, pushed)
      void pushed.catch(() => { /* ignore: the push failure is reported to the caller awaiting it; this only clears the queue entry */ }).then(() => { if (mirrorPushes.get(mirror) === pushed) mirrorPushes.delete(mirror) })
      publications.set(key, published)
      // A failed push is retried by the next start; a done one is kept for the run's later partitions.
      published.catch(() => { publications.delete(key) })
      if (publications.size > 50) publications.delete(publications.keys().next().value!)
    }
    const publication = await published
    const workflow = this.provider.id === 'github' ? '.github/workflows/ci.yml' : '.circleci/config.yml'
    if (!publication.workflows.includes(workflow)) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE',
        `The CI mirror has no ${workflow} workflow for ${this.provider.label}. Use a build computer or configure the mirror.`, 409)
    }
    return publication
  }

  private async push(repository: string, mirror: string, commit: string, defaultBranch: string | undefined,
    baseCommit: string | undefined, durations: CiDurations, queued: { queuedAt: number; startedAt: string }) {
    const startedAt = queued.startedAt
    const started = performance.now()
    const queueMs = started - queued.queuedAt
    const signal = AbortSignal.timeout(600_000)
    const clone = await ensureCommit(this.git, repository, commit, signal)
    const objects = await this.git.git(['rev-parse', '--git-path', 'objects'], { cwd: clone, signal })
    if (objects.code !== 0) throw new DomainError('CI_CLOUD_FAILED', 'Could not read source objects.', 502)
    const sourceMs = performance.now() - started
    const fetching = performance.now()
    // A separate persistent mirror clone negotiates against public refs only. Source objects are read locally.
    const mirrorClone = await ensureClone(this.git, mirror, signal)
    const sourceObjects = resolve(clone, objects.stdout.trim())
    // Snapshot objects reference source objects, so they live in a daily store beside the mirror clone, never in it:
    // the clone's refs then reach only objects it owns. Yesterday's store stays readable for late partitions.
    const store = join(this.root, 'snapshot-objects', ...mirror.split('/'))
    const day = (offset: number) => new Date(this.ports.now().getTime() - offset).toISOString().slice(0, 10)
    const snapshotObjects = join(store, day(0))
    await mkdir(snapshotObjects, { recursive: true, mode: 0o700 })
    for (const entry of await readdir(store)) {
      if (entry !== day(0) && entry !== day(86_400_000)) await rm(join(store, entry), { recursive: true, force: true })
    }
    const run = async (args: string[], env: Record<string, string>) => {
      const result = await this.git.git(args, { cwd: mirrorClone, signal: AbortSignal.timeout(600_000), env })
      if (result.code !== 0) {
        // Git's own reason, without any credentials in a URL.
        const detail = result.stderr.replace(/\/\/[^/@\s]+@/g, '//').trim().slice(-500)
        throw new DomainError('CI_CLOUD_FAILED', `git ${args[0]} failed for the CI mirror.${detail ? ` ${detail}` : ''}`, 502)
      }
      return result.stdout.trim()
    }
    const read = (args: string[]) =>
      run(args, { GIT_ALTERNATE_OBJECT_DIRECTORIES: [snapshotObjects, sourceObjects].join(delimiter) })
    const git = (args: string[], env?: Record<string, string>) => run(args, { GIT_OBJECT_DIRECTORY: snapshotObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [resolve(mirrorClone, '.git', 'objects'), sourceObjects].join(delimiter), ...env })
    const base = 'refs/remotes/origin/main'
    // Fetch without source alternates: their shallow refs are not negotiation haves the mirror clone can walk.
    const fetch = () => run(['fetch', '--quiet', '--no-tags', 'origin', `+main:${base}`], {})
    await fetch().catch(async (error: unknown) => {
      if (!(error instanceof DomainError) || !/could not read|failed to traverse|did not send all necessary objects|bad object|corrupt/i
        .test(error.message)) throw error
      log.warn({ err: error, mirror }, 'CI mirror clone is unreadable; rebuilding it once')
      await rm(mirrorClone, { recursive: true, force: true })
      await ensureClone(this.git, mirror, signal)
      await fetch()
    })
    const reusedSnapshot = await git(['rev-parse', base])
    let fetchMs = performance.now() - fetching
    const workflow = this.provider.id === 'github' ? '.github/workflows/ci.yml' : '.circleci/config.yml'
    const workflows = ['.github/workflows/ci.yml', '.circleci/config.yml']
    const entries = (await git(['ls-tree', base, '--', ...workflows])).split('\n')
      .filter(entry => /^100[0-7]{3} blob [a-f0-9]+\t/.test(entry))
    if (!entries.some(entry => entry.endsWith(`\t${workflow}`))) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE',
        `The CI mirror has no ${workflow} workflow for ${this.provider.label}. Use a build computer or configure the mirror.`, 409)
    }
    const guarding = performance.now()
    await this.guard(clone, commit, signal)
    const initialGuardMs = performance.now() - guarding
    let guardMs = initialGuardMs
    const snapshotting = performance.now()
    let branchFetchMs = 0
    // A source without the mirror's provider workflows gets the mirror's copies.
    // Source commits are parsed only in their own (shallow) clone; the mirror clone sees their trees.
    const sourceRead = async (args: string[]) => {
      const result = await this.git.git(args, { cwd: clone, signal })
      if (result.code !== 0) throw new DomainError('CI_CLOUD_FAILED', `Could not read source ${args.at(-1)}.`, 502)
      return result.stdout.trim()
    }
    const treeOf = async (sourceCommit: string) => {
      const source = await sourceRead(['rev-parse', `${sourceCommit}^{tree}`])
      const sourceWorkflows = new Set((await git(['ls-tree', source, '--', ...workflows])).split('\n')
        .map(entry => entry.split('\t')[1]))
      const missing = entries.filter(entry => !sourceWorkflows.has(entry.split('\t')[1]))
      if (!missing.length && !Object.keys(durations).length) return source
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const directory = await mkdtemp(join(this.root, 'snapshot-'))
      try {
        const env = { GIT_INDEX_FILE: join(directory, 'index') }
        await git(['read-tree', source], env)
        for (const entry of missing) {
          const [mode, , blob, path] = entry.split(/\s+/)
          await git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], env)
        }
        if (Object.keys(durations).length) {
          const path = join(directory, 'durations.json')
          await writeFile(path, canonicalJson(durations), { mode: 0o600 })
          const blob = await git(['hash-object', '-w', path])
          await git(['update-index', '--add', '--cacheinfo', `100644,${blob},scripts/ci-learned-durations.json`], env)
        }
        return await git(['write-tree'], env)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
    // Partition starts share the published snapshot and its timing inputs.
    const date = await sourceRead(['show', '-s', '--format=%cI', commit])
    const author = { GIT_AUTHOR_NAME: mirror.split('/')[0]!, GIT_AUTHOR_EMAIL: `${mirror.split('/')[0]}@users.noreply.github.com`,
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    const identity = { ...author, GIT_COMMITTER_NAME: author.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: author.GIT_AUTHOR_EMAIL }
    const snapshotOf = async (source: string, parent: string) => {
      const tree = await git(['rev-parse', await treeOf(source)])
      if (tree === await git(['rev-parse', `${parent}^{tree}`])) return git(['rev-parse', parent])
      return git(['commit-tree', tree, '-p', parent, '-m', `Snapshot ${source.slice(0, 12)}`], identity)
    }
    let parent = base
    let comparison: { branch: string; commit: string } | undefined
    let runnerBaseCommit: string | undefined
    let head: string | undefined
    if (baseCommit) {
      const ancestor = await this.git.git(['merge-base', '--is-ancestor', baseCommit, commit], { cwd: clone, signal })
      if (ancestor.code === 0) {
        const checking = performance.now()
        await this.guard(clone, baseCommit, signal)
        guardMs += performance.now() - checking
        parent = await snapshotOf(baseCommit, base)
        runnerBaseCommit = parent
      }
    } else if (defaultBranch) {
      const branchFetching = performance.now()
      head = await fetchRepositoryBranch(this.git, clone, repository, defaultBranch, signal)
      branchFetchMs = performance.now() - branchFetching
      fetchMs += branchFetchMs
      const mergeBase = await this.git.git(['merge-base', commit, head], { cwd: clone, signal })
      if (mergeBase.code === 0) {
        const sourceBase = mergeBase.stdout.trim()
        // Publish only checked trees; the source repository's private commit history stays private.
        const checking = performance.now()
        await this.guard(clone, sourceBase, signal)
        await this.guard(clone, head, signal)
        guardMs += performance.now() - checking
        parent = await snapshotOf(sourceBase, base)
        if (commit !== head) runnerBaseCommit = parent
        comparison = { branch: `ci-default/${commit}`, commit: await snapshotOf(head, parent) }
      }
    }
    let snapshot: string
    if (commit === baseCommit && runnerBaseCommit) snapshot = runnerBaseCommit
    else if (commit === head && comparison) snapshot = comparison.commit
    else snapshot = await snapshotOf(commit, parent)
    const branch = baseCommit ? `ci/${commit}-${baseCommit}` : `ci/${commit}`
    const workflowRef = `ci-snapshot/${snapshot}`
    const snapshotMs = Math.max(0, performance.now() - snapshotting - (guardMs - initialGuardMs) - branchFetchMs)
    const pushing = performance.now()
    await git(['push', '--quiet', '--force', `https://github.com/${mirror}.git`, `${snapshot}:refs/heads/${branch}`,
      `${snapshot}:refs/heads/main`, `${snapshot}:refs/heads/${workflowRef}`, ...(comparison ? [`${comparison.commit}:refs/heads/${comparison.branch}`] : [])])
    const timings = { queueMs, sourceMs, fetchMs, guardMs, snapshotMs, pushMs: performance.now() - pushing,
      totalMs: performance.now() - started + queueMs }
    const mirrorPublication: NonNullable<CiHostRun['mirrorPublication']> = {
      state: 'ready', startedAt, finishedAt: this.ports.now().toISOString(), snapshotCommit: snapshot,
      reusedSnapshot, timings,
    }
    log.info({ commit, mirror, timings }, 'CI mirror snapshot published')
    return { git: read, branch, snapshot, workflowRef, mirrorPublication, workflows: entries.map(entry => entry.split('\t')[1]!),
      ...(comparison ? { defaultBranch: comparison.branch } : {}),
      ...(runnerBaseCommit ? { baseCommit: runnerBaseCommit } : {}) }
  }

  /** The same duration-balanced slice a build computer would run, from the commit's files and CI database durations, as
   * indexes into the commit's sorted integration files (scripts/ci-files.mjs), so it fits a short CI parameter. */
  private async slice(git: (args: string[]) => Promise<string>, commit: string, partition: CiPartition | undefined,
    learned: CiDurations, selected?: string[]) {
    const files = (await git(['ls-tree', '--name-only', `${commit}:apps/api/test`])).split('\n')
      .filter(name => name.endsWith('.integration.test.ts')).map(name => `apps/api/test/${name}`).sort()
    if (selected?.some(file => !files.includes(file))) {
      throw new DomainError('CI_CLOUD_FAILED', 'Selected integration files are absent from the commit.', 409)
    }
    const candidates = selected ?? files
    const slice = new Set<string>(partition ? integrationPartition(candidates, learned, partition) : candidates)
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

  private expectedEnd(run: CloudRun): number {
    const duration = run.dispatch?.input.expectedDurationMs ?? 0
    if (duration <= 0) return Infinity
    return Date.parse(run.dispatch?.at ?? run.startedAt) + duration
  }

  /** Follows the provider's run at most every few seconds, pausing while the service's rate limit is spent. */
  private async refresh(runId: string): Promise<CloudRun> {
    const run = await this.read(runId)
    if (run.publicationRequest && run.state === 'starting') {
      this.publishInBackground(run)
      return run
    }
    const pendingCollection = run.collection && (!run.collection.log || !run.collection.artifacts)
    if (!['starting', 'running'].includes(run.state) && !run.cancellation && !pendingCollection) return run
    const now = this.ports.now().getTime()
    if (run.reconciliation && (run.reconciliation.attempts >= MAX_DISPATCH_ATTEMPTS && !this.stalled(run)
      || now - Date.parse(run.reconciliation.at) < POLL_MS)) return run
    if (now < this.backoff.until) return run
    const interval = this.expectedEnd(run) - now <= FINISH_WINDOW_MS ? FINISH_POLL_MS : POLL_MS
    if ((run.cancellation || pendingCollection || run.state === 'running' && run.workflowStarted)
      && now - (this.polled.get(runId) ?? -Infinity) < interval) return run
    if (this.following >= POLL_CONCURRENCY) await new Promise<void>(resume => { this.waiting.push({ run, resume }) })
    else this.following++
    try {
      // A poll that waited for its slot skips the service if a rate limit was hit meanwhile.
      if (this.ports.now().getTime() < this.backoff.until) return run
      return await withProviderPoll(async () => {
        let next: CloudRun
        if (run.cancellation) next = await this.cancelAttempts(run)
        else if (pendingCollection) next = await this.collect(run)
        else next = await this.follow(run)
        this.backoff = { until: 0, ms: 0 }
        if (next.reconciliation && next.state !== 'starting') {
          const recovered = { ...next,
            message: next.message === run.message ? next.reconciliation.previousMessage : next.message }
          delete recovered.reconciliation
          next = await this.save(recovered)
        }
        if (next.collection && (!next.collection.log || !next.collection.artifacts)) return this.collect(next)
        return next
      })
    } catch (error) {
      if (error instanceof DomainError
        && ['CI_CLOUD_PIPELINE_FAILED', 'CI_CLOUD_RUN_ENDED'].includes(error.code)) {
        return this.failPipeline(run, { message: error.message, configError: error.details?.configError === true })
      }
      if (error instanceof DomainError && ['CI_CLOUD_RUN_NOT_FOUND', 'CI_CLOUD_RUN_UNREADABLE'].includes(error.code)) {
        return this.reconcileLookupFailure(run, error)
      }
      if (!(error instanceof DomainError && error.code === 'CI_CLOUD_RATE_LIMITED')) throw error
      const ms = Math.min(MAX_BACKOFF_MS, Math.max(30_000, this.backoff.ms * 2))
      this.backoff = { until: now + ms, ms }
      log.warn({ runId, provider: this.provider.id, backoffMs: ms }, 'Cloud CI rate limited; polling paused')
      return run
    } finally {
      // The slot passes straight to the next waiting poll.
      this.waiting.sort((left, right) => this.expectedEnd(left.run) - this.expectedEnd(right.run))
      const next = this.waiting.shift()
      if (next) next.resume()
      else this.following--
    }
  }

  private async reconcileLookupFailure(run: CloudRun, error: unknown): Promise<CloudRun> {
    const attempts = (run.reconciliation?.attempts ?? 0) + 1
    const message = `${this.provider.label} execution could not be reconciled: `
      + (error instanceof Error ? error.message : String(error)).slice(0, 500)
      + (attempts >= MAX_DISPATCH_ATTEMPTS ? ' Automatic recovery stopped; Operator cancellation is required.'
        : ` Ownership retained; recovery attempt ${attempts}/${MAX_DISPATCH_ATTEMPTS}.`)
    log.warn({ err: error, runId: run.runId, attempts }, 'Cloud CI execution needs reconciliation')
    return this.save({ ...run, message, reconciliation: { attempts, at: this.ports.now().toISOString(),
      previousMessage: run.reconciliation ? run.reconciliation.previousMessage : run.message } })
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
    const text = sanitizeCiText(chunk.toString('utf8'))
    if (text.length) await writeFile(this.path(run.runId, 'log'), text, { flag: 'a', mode: 0o600 })
    bytes += Buffer.byteLength(text)
    return this.save({ ...run, lastProgressAt: this.ports.now().toISOString(),
      live: { step, seen: [...seen], ...(output ? { output } : {}), bytes } })
  }

  private stalled(run: CloudRun): boolean {
    if (run.state !== 'running') return false
    const timeout = Math.max(MIN_STALL_MS,
      (run.dispatch?.input.expectedDurationMs ?? 0) * EXPECTED_DURATION_MULTIPLIER)
    const lastProgress = Date.parse(run.lastProgressAt ?? run.dispatch?.at ?? run.startedAt)
    return this.ports.now().getTime() - lastProgress >= timeout
  }

  /** Reconcile overdue runs and retained terminal work in bounded batches. */
  reconcile(): Promise<void> {
    this.reconciling ??= this.reconcileRuns().finally(() => { this.reconciling = undefined })
    return this.reconciling
  }

  private async reconcileRuns(): Promise<void> {
    const entries = await readdir(join(this.root, 'runs'), { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    const ids = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    for (let offset = 0; offset < Math.min(8, ids.length); offset++) {
      const runId = ids[(this.reconcileCursor + offset) % ids.length]!
      try {
        const run = await this.read(runId)
        if (run.publicationRequest && run.state === 'starting' || this.stalled(run) || run.cancellation || run.collection && (!run.collection.log || !run.collection.artifacts)) {
          await this.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })
        }
      } catch (error) {
        log.warn({ err: error, runId }, 'Cloud CI recovery remains pending')
      }
    }
    this.reconcileCursor = ids.length ? (this.reconcileCursor + 8) % ids.length : 0
  }

  private async cancelAttempts(run: CloudRun): Promise<CloudRun> {
    const canceled = new Set(run.cancellation!.canceledIds)
    let discovered: string | null = null
    try {
      discovered = await this.provider.find(run)
    } catch (error) {
      if (!(error instanceof DomainError
        && ['CI_CLOUD_RUN_NOT_FOUND', 'CI_CLOUD_RUN_UNREADABLE', 'CI_CLOUD_RUN_ENDED'].includes(error.code))) throw error
      log.warn({ err: error, runId: run.runId }, 'Cloud CI discovery unavailable; canceling known pipelines')
    }
    const attempts = run.dispatchHistory?.map(attempt => attempt.providerRunId) ?? []
    const ids = new Set([discovered, run.providerRunId, ...attempts])
    for (const providerRunId of ids) {
      if (!providerRunId || canceled.has(providerRunId)) continue
      await this.provider.cancel({ ...run, providerRunId })
      canceled.add(providerRunId)
    }
    this.polled.set(run.runId, this.ports.now().getTime())
    return this.save({ ...run, cancellation: { ...run.cancellation!, canceledIds: [...canceled] } })
  }

  private async collect(run: CloudRun): Promise<CloudRun> {
    const collection = { ...run.collection! }
    if (!collection.log) {
      try {
        const full = Buffer.from(await this.provider.log(run)).subarray(-LOG_LIMIT)
        let contents = full
        if (run.live?.bytes) {
          const live = (await readFile(this.path(run.runId, 'log'))).subarray(0, run.live.bytes)
          contents = Buffer.concat([live, Buffer.from(`--- ${this.provider.label} log ---\n`), full])
        }
        await writeFile(this.path(run.runId, 'log'), contents, { mode: 0o600 })
        collection.log = true
      } catch (error) {
        log.warn({ err: error, runId: run.runId }, 'Final CI log remains pending')
      }
    }
    if (!collection.artifacts) {
      try {
        const artifacts = await this.provider.artifacts(run, join(this.root, 'runs', run.runId, 'artifact'))
        if (artifacts.suiteLog !== undefined) {
          const contents = Buffer.from(artifacts.suiteLog).subarray(-LOG_LIMIT)
          await writeFile(this.path(run.runId, 'log'), contents, { mode: 0o600 })
          collection.log = true
        }
        if (run.suite === 'integration' || run.suite === 'unit') {
          const durations = CiDurationsSchema.safeParse(artifacts.durations)
          if (durations.success && (run.suite === 'integration' || run.part === 'unit-api' || run.part === 'unit-web')) {
            run = { ...run, durations: durations.data }
          }
          const tests = CiTestResultsSchema.safeParse(artifacts.testResults)
          if (tests.success) run = { ...run, testResults: tests.data }
        }
        const watchdog = CiWatchdogFailureSchema.safeParse(artifacts.watchdogFailure)
        if (watchdog.success && run.state !== 'passed') {
          run = { ...run, message: watchdog.data.message,
            ...(watchdog.data.testsStarted !== undefined ? { testsStarted: watchdog.data.testsStarted } : {}) }
        }
        collection.artifacts = true
      } catch (error) {
        log.warn({ err: error, runId: run.runId }, 'Final CI artifacts remain pending')
      }
    }
    this.polled.set(run.runId, this.ports.now().getTime())
    return this.save({ ...run, collection })
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
    const passed = status.conclusion === 'success'
    const failedSetup = status.conclusion === 'failure'
      && !status.steps?.some(step => step.name === 'Suite' && step.state !== 'skipped')
      ? status.steps?.find(step => step.state === 'failed') : undefined
    let state: CloudRun['state'] = 'failed'
    if (passed) state = 'passed'
    else if (status.conclusion === 'cancelled') state = 'canceled'
    const failure = failedSetup ? `${this.provider.label}: setup failed at ${failedSetup.name}.`
      : `${this.provider.label}: ${status.conclusion}.`
    const message = passed ? run.message : [run.message, status.message ?? failure].filter(Boolean).join(' ')
    const terminal = await this.save({ ...run, state,
      exitCode: passed ? 0 : 1, finishedAt: status.finishedAt, collection: { log: false, artifacts: false },
      ...(failedSetup ? { testsStarted: false } : {}),
      message })
    return terminal
  }
}

/** GitHub Actions and CircleCI on the same public mirror. */
export function cloudCis(mainId: string, mirrors: Mirrors,
  options: { ports?: HostCiPorts; activeRuns?: () => Promise<ActiveCiRuns> } = {}): CloudCi[] {
  const ports = options.ports ?? systemHostCiPorts()
  return [new GitHubActionsProvider(ports), new CircleCiProvider(ports)].map(provider => {
    const cloud = new CloudCi(mainId, provider, mirrors)
    if (options.activeRuns) cloud.setActiveRunLookup(options.activeRuns)
    return cloud
  })
}

interface Peer { HostName?: string; TailscaleIPs?: string[] }
