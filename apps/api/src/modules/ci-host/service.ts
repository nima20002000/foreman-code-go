import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { inTransaction, type SqlQuery } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import { withProviderPoll } from './providerPoll.js'
import { CI_HOST_NAMESPACE, CiComputerRefSchema, CiRunRecordSchema, CiRunOutputSchema,
  WorkspaceSchema,
  type CiDurations, type CiHostRequest, type CiHostRun, type CiHostStatus, type CiRunRecord, type CiRunInput,
  type CiCancellation, type Workspace } from '@foreman-code/contracts'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../jobs/ciAuthority.js'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import { planCiParts, runsOnCircleCi, unitPartOf } from './parts.js'
import { planIntegrationParts } from './integrationParts.js'
import { readCiSlots } from './planningCapacity.js'
import { CiPlanningSnapshot } from './planningSnapshot.js'
import { HostCiReads, retryRead } from './readQueries.js'
import { CI_QUEUE_ORDER, ciQueueReason, compareCiQueue } from './priority.js'
import { prepareCiSupersession, validateCiSupersession, supersedeCiRuns } from './supersession.js'
import { gatePartStealer, gateQueueBlock, planCiGate, readCiComputerStatus } from './gate.js'
import { buildComputerGatePart, splitUnavailableGateParts } from './gateFallback.js'
import { buildComputerIntegrationShards, gateDispatchShards } from './capacity.js'
import { saveQueuedCiRun, ciMessages, withCiTicketLock } from './dispatch.js'
import { reconcileCiHostStart, sendCiDispatch, type CiDispatchState } from './dispatchRecovery.js'
import { collectCiResults } from './resultCollection.js'
import { sanitizeCiText, serializeCiJson } from './text.js'
import { isGitHubComputer, needsSystemdExecutor, supportsUserSystemd } from './computerCapabilities.js'
import { weighCiPartitions } from './partitionPlanning.js'
import { readExecutorSpeeds } from './executorSpeed.js'
import { readCiGateReservation, readQueuedCiRuns, releaseCiSlowTier } from './queuedRuns.js'
import { expireCloudDispatch, requestCloud } from './cloudDispatch.js'
import { claimCiSlot, reservedCloudSlotKeys } from './cloudSlots.js'
import { cancelAssignedCiTicket } from './assignedCancellation.js'
import { ciExecutionRunId } from './executionAttempt.js'
import { ciCachedNotice, planCachedSelection, recordCiResultCache, type CachedSelection } from './resultCacheStore.js'
import type { AgentSnapshots, CiCommits, HostCiComputer, HostCiEndpoint, HostRef } from './serviceTypes.js'

export type { AgentSnapshots, CiCommits, HostCiComputer, HostCiEndpoint } from './serviceTypes.js'

const log = componentLogger('jobs')

/** Elapsed milliseconds per named phase, each measured from the previous mark. */
function phaseTimer() {
  let last = performance.now()
  const phases: Record<string, number> = {}
  return { phases, mark(name: string) { const now = performance.now(); phases[name] = Math.round(now - last); last = now } }
}

type CiRunPhase = 'dispatchWaitMs' | 'prepareMs' | 'insertMs' | 'postMs'

interface PreparedCiRuns {
  repository: NonNullable<Workspace['repository']>
  runs: CiRunRecord[]
  durations: CiDurations | null
  /** Result cache keys of the files the runs execute, and the log tail of a request the cache completed. */
  cacheKeys?: Record<string, string>
  logTail?: string
}

interface RunStopAudit {
  principalId: string
  source: 'http' | 'mcp'
  commandId: string
  runId: string
}

/** Runs work over every item with at most `limit` in flight. */
async function inBatches<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!)
  }))
}

/** Main resolves and publishes the commit, then queues suite parts and integration partitions for idle CI computers. */
export class HostCiService {
  private dispatching: Promise<void> | undefined
  private dispatchRequested = false
  private timer: NodeJS.Timeout | undefined
  private stoppingRuns = 0
  private readonly endpoint: HostCiEndpoint
  private readonly planningEndpoint: CiPlanningSnapshot
  /** Cloud slots kept free for non-gate tickets while a gate is queued or running. */
  private readonly reservedCloudSlots: number
  private readonly reads: HostCiReads

  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly authority: CiAuthority, private readonly commits: CiCommits,
    endpoint: HostCiEndpoint, private readonly snapshots?: AgentSnapshots, options: { reservedCloudSlots?: number } = {}) {
    this.reservedCloudSlots = options.reservedCloudSlots ?? 0
    this.planningEndpoint = new CiPlanningSnapshot(endpoint)
    this.endpoint = {
      computers: async () => {
        const computers = await endpoint.computers()
        this.planningEndpoint.observeComputers(computers)
        return computers
      },
      ...(endpoint.publishMirror ? { publishMirror: endpoint.publishMirror.bind(endpoint) } : {}),
      request: async (computer, request, options) => {
        const send = () => options ? endpoint.request(computer, request, options) : endpoint.request(computer, request)
        if (request.operation !== 'status' || computer.hostRef.kind === 'cloud') {
          try {
            const reply = await send()
            this.planningEndpoint.observeStatus(computer, reply)
            return reply
          } catch (error) {
            this.planningEndpoint.invalidate(computer)
            throw error
          }
        }
        const assigned = (await this.pool.query<{ record: unknown; host_key: string }>(
          `select record,host_key from ci_runs where state in ('starting','running')`)).rows
          .filter(row => row.host_key === computer.key)
        let status: CiHostStatus | null = null
        try {
          const reply = await send()
          if (reply.operation === 'status') status = reply
          this.planningEndpoint.observeStatus(computer, reply)
          return reply
        } catch (error) {
          this.planningEndpoint.invalidate(computer)
          throw error
        } finally {
          for (const row of assigned) {
            await this.reconcileHostStart(CiRunRecordSchema.parse(row.record), computer, status)
          }
        }
      },
    }
    this.reads = new HostCiReads(pool, authority, {
      endpoint: this.endpoint,
      readRun: (id, workspaceId) => this.read(id, workspaceId),
      computer: hostRef => this.computer(hostRef),
      smokeTargets: runs => this.smokeTargets(runs),
    })
  }

  start(intervalMs = 1000) {
    if (this.timer) return
    this.timer = setInterval(() => { void this.dispatch() }, intervalMs)
    this.timer.unref()
    void this.dispatch()
  }

  close() {
    clearInterval(this.timer)
    this.timer = undefined
    this.reads.close()
    return this.dispatching
  }

  async run(caller: ManagementPrincipal, input: CiRunInput & { workspaceId?: string | undefined }, source: 'mcp' | 'http' = 'mcp') {
    const started = performance.now()
    const timings = { dispatchWaitMs: 0, prepareMs: 0, insertMs: 0, postMs: 0 }
    let phase: CiRunPhase = 'prepareMs'
    let phaseStarted = started
    const markPhase = (next: CiRunPhase) => {
      const now = performance.now()
      timings[phase] += now - phaseStarted
      phase = next
      phaseStarted = now
    }
    let pausedDispatch = false
    let authorized = false
    let ticketId: string | undefined
    try {
      if ((input.gate || input.smokeComputer) && caller.audience !== 'operator') {
        if (source === 'http') await this.commands.recordDenied(caller.id, source, 'ci.run', input.workspaceId ?? 'ci')
        throw new DomainError('ACCESS_DENIED', 'Only an Operator can request a CI gate or target a smoke computer.', 403)
      }
      const actions = CI_RUN_ACTIONS
      const scope = await this.authority.resolve(caller, input.workspaceId, actions).catch(async error => {
        if (source === 'http' && error instanceof DomainError && [401, 403, 404].includes(error.status)) {
          await this.commands.recordDenied(caller.id, source, 'ci.run', input.workspaceId ?? 'ci')
        }
        throw error
      })
      authorized = true
      const result = await this.enqueue(caller, input, source, scope, actions, markPhase, async () => {
        if (pausedDispatch) return
        // Drain an active start only when admission can supersede its ticket.
        pausedDispatch = true
        this.stoppingRuns += 1
        markPhase('dispatchWaitMs')
        try {
          await this.dispatching
        } finally {
          markPhase('prepareMs')
        }
      })
      markPhase('postMs')
      ticketId = result.ticketId
      return result
    } finally {
      if (pausedDispatch) this.stoppingRuns -= 1
      if (authorized) {
        // Dispatch owns executor cleanup; the request returns its persisted tickets.
        this.start()
        void this.dispatch()
      }
      markPhase('postMs')
      log.info({ operation: 'ci_run', source, workspaceId: input.workspaceId, commandId: input.commandId,
        ticketId, suite: input.suite, gate: input.gate ?? false, outcome: ticketId ? 'succeeded' : 'failed',
        ...timings, totalMs: performance.now() - started }, 'CI run admission timing')
    }
  }

  private async enqueue(caller: ManagementPrincipal, input: CiRunInput,
    source: 'mcp' | 'http', scope: Awaited<ReturnType<CiAuthority['resolve']>>, actions: ManagementAction[],
    markPhase: (phase: CiRunPhase) => void, pauseDispatch: () => Promise<void>) {
    const commandId = input.commandId ?? randomUUID()
    let prepared: PreparedCiRuns | undefined
    let supersession: Map<string, boolean> | undefined
    let superseded: CiRunRecord[] = []
    markPhase('insertMs')
    const outcome = await this.commands.execute({ principal: caller, source, operation: 'ci.run',
      commandId, targetKey: scope.workspaceId, payload: input,
      prepare: async () => {
        markPhase('prepareMs')
        try {
          prepared ??= await this.prepareRuns(caller, input, scope)
          supersession = input.gate ? undefined
            : await prepareCiSupersession(this.pool, this.commits, prepared.runs[0]!)
          if (supersession && [...supersession.values()].some(Boolean)) await pauseDispatch()
        } finally {
          markPhase('insertMs')
        }
      },
      preparedMutation: {
        resourceLock: `ci-admission:${scope.workspaceId}:${scope.executionId ?? caller.id}`,
        validate: async client => {
          const workspace = WorkspaceSchema.parse((await client.query<{ record: unknown }>(
            'select record from workspaces where id=$1 for share', [scope.workspaceId])).rows[0]?.record)
          if (!isDeepStrictEqual(workspace.repository, prepared!.repository)) {
            throw new DomainError('REVISION_CONFLICT', 'The workspace repository changed while preparing CI. Retry the request.', 409)
          }
          if (scope.executionId) {
            // Hold the Run lock through ticket insertion so Stop sees every admitted ticket.
            const row = (await client.query<{ stopped: boolean }>(`select
              r.stop_requested_at is not null or r.worker_credentials_closed_at is not null
                or r.execution_state='completed' as stopped
              from runs r join harness_executions e on e.run_id=r.id
              where e.id=$1 and r.workspace_id=$2 for share of r`,
            [scope.executionId, scope.workspaceId])).rows[0]
            if (!row || row.stopped) {
              throw new DomainError('GRAPH_STOP_CONFLICT', 'The Run no longer accepts CI tickets.', 409)
            }
          }
          const candidates = await validateCiSupersession(client, prepared!.runs[0]!, supersession)
          if (!candidates) return false
          superseded = candidates
          return true
        },
      },
      authorize: async () => { await this.authority.resolve(caller, scope.workspaceId, actions) },
      perform: async client => {
        const { runs, durations, cacheKeys, logTail } = prepared!
        const { groupId, commit, priority, priorityReason, cachedFiles } = runs[0]!
        const result = CiRunOutputSchema.parse({ ticketId: runs[0]!.id,
          ...(runs.length > 1 ? { partitions: runs.map(run => ({ ticketId: run.id })) } : {}),
          ...(cachedFiles?.length ? { cachedFiles } : {}) })
        if (!input.gate) await supersedeCiRuns(client, runs[0]!, superseded, { source, commandId })
        for (const run of runs) {
          await client.query(`insert into ci_runs(id,workspace_id,group_id,state,record,durations,result_cache_keys,log_tail)
            values($1,$2,$3,$6,$4::jsonb,$5::jsonb,$7::jsonb,$8)`, [run.id, run.workspaceId, groupId, serializeCiJson(run),
            durations ? serializeCiJson(durations) : null, run.state,
            cacheKeys && Object.keys(cacheKeys).length ? JSON.stringify(cacheKeys) : null, logTail ?? ''])
        }
        await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
          values($1,$2,'ci.priority',$3,'succeeded',$4::jsonb)`, [caller.id, source, scope.workspaceId,
          JSON.stringify({ commandId, groupId, commit, priority, priorityReason,
            requestedPriority: input.priority ?? 'normal',
            ...(input.smokeComputer ? { smokeComputer: input.smokeComputer } : {}) })])
        // Receipts, commit and coordinator cleanup are visible in the post-insert phase.
        markPhase('postMs')
        return result
      },
    })
    return outcome.value
  }

  private async prepareRuns(caller: ManagementPrincipal, input: CiRunInput,
    scope: Awaited<ReturnType<CiAuthority['resolve']>>): Promise<PreparedCiRuns> {
    const workspace = WorkspaceSchema.parse((await this.pool.query<{ record: unknown }>(
      'select record from workspaces where id=$1', [scope.workspaceId])).rows[0]?.record)
    if (!workspace.repository) throw new DomainError('SOURCE_REPOSITORY_REQUIRED',
      'CI runs on build computers from GitHub. Set the workspace GitHub repository (workspace_update).', 409)
    const smokeTarget = input.smokeComputer
      ? (await this.planningEndpoint.computers()).find(computer => isDeepStrictEqual(computer.hostRef, input.smokeComputer))
      : undefined
    if (input.smokeComputer && !smokeTarget) {
      // An enabled computer drops out of the list while its Worker reconnects, for example after an API restart.
      const enabled = (await this.pool.query<{ build_enabled: boolean }>(
        "select build_enabled from build_computer_preferences where target->'hostRef'=$1::jsonb",
        [JSON.stringify(input.smokeComputer)])).rows[0]?.build_enabled
      if (enabled) throw new DomainError('CI_SMOKE_COMPUTER_UNAVAILABLE',
        'The smoke computer is not connected yet. Retry shortly.', 503, { retryable: true })
      throw new DomainError('CI_SMOKE_COMPUTER_UNAVAILABLE', 'The smoke computer is disabled or unavailable.', 409)
    }
    const repository = `${workspace.repository.owner}/${workspace.repository.name}`
    const defaultBranch = workspace.repository.defaultBranch
    // An Agent's CI tests its current files; they are published to GitHub so build computers can fetch them.
    const timing = phaseTimer()
    const snapshot = scope.executionId && !input.commit && this.snapshots ? await this.snapshots(scope.executionId) : null
    const commit = await this.commits.resolve(repository, defaultBranch, input.commit, snapshot)
    timing.mark('commitMs')
    const inventories = Promise.all([
      ['unit', 'integration'].includes(input.suite) ? this.learnedDurations(repository) : null,
      input.suite === 'integration' ? this.commits.integrationInventory?.(repository, commit) : undefined,
    ])
    if (workspace.ciMirror && this.endpoint.publishMirror) {
      const publish = this.endpoint.publishMirror.bind(this.endpoint)
      const mirror = `${workspace.ciMirror.owner}/${workspace.ciMirror.name}`
      void inventories.then(async ([learned, integration]) => {
        const merged = { ...integration?.durations, ...learned }
        const durations = input.suite === 'integration' && integration
          ? Object.fromEntries(integration.files.filter(file => merged[file] !== undefined)
            .map(file => [file, merged[file]!])) : learned ?? {}
        const deriveFiles = !input.gate && (input.scope ?? 'affected') === 'affected' && input.files === undefined
        await publish({ repository, mirror, commit,
          ...(deriveFiles && !input.baseCommit ? { defaultBranch } : {}),
          ...(deriveFiles && input.baseCommit ? { baseCommit: input.baseCommit } : {}),
          durations: input.suite === 'integration' ? durations : {} })
      }).catch(error => {
        log.warn({ err: error, commit, mirror }, 'Early CI mirror publication failed; dispatch will retry')
      })
    }
    const [infrastructure, branch, capabilities, [earlyLearned, earlyIntegration]] = await Promise.all([
      this.commits.infrastructureOnly?.(repository, commit) ?? false,
      this.commits.branch?.(repository, defaultBranch, commit),
      this.commits.capabilities(repository, commit),
      inventories,
    ])
    timing.mark('commitFactsMs')
    const priority = input.gate || infrastructure || input.priority === 'high' ? 'high' : 'normal'
    let priorityReason: CiRunRecord['priorityReason'] = 'normal'
    if (input.gate) priorityReason = 'gate'
    else if (infrastructure) priorityReason = 'ci-infrastructure'
    else if (input.priority === 'high') priorityReason = 'requested'
    const groupId = randomUUID()
    const now = new Date().toISOString()
    const [inventory, learned, integration] = await Promise.all([
      capabilities.parts && (input.suite === 'unit' || input.gate)
        ? this.commits.unitInventory?.(repository, commit) : undefined,
      earlyLearned,
      capabilities.integrationPartitions ? earlyIntegration : undefined,
    ])
    timing.mark('inventoryMs')
    if (input.gate && (!capabilities.parts || !integration || !inventory)) {
      throw new DomainError('CI_GATE_UNSUPPORTED', 'This repository must provide CI suite hooks and complete test inventories for a gate.', 409)
    }
    let durations = input.suite === 'integration' ? learned : null
    if (integration) {
      const merged = { ...integration.durations, ...learned }
      durations = Object.fromEntries(integration.files.filter(file => merged[file] !== undefined)
        .map(file => [file, merged[file]!]))
    }
    const unitDurations = { ...inventory?.durations, ...learned }
    const supportsSelection = input.suite === 'integration' ? capabilities.integrationPartitions : capabilities.affected
    if (smokeTarget && !supportsSelection) {
      throw new DomainError('CI_SMOKE_UNSUPPORTED', 'CI smoke requires a repository with affected test selection.', 409)
    }
    const selectionScope = supportsSelection ? input.scope ?? 'affected' : 'full'
    const deriveFiles = selectionScope === 'affected' && input.files === undefined
    const selection = { ...input, scope: selectionScope, files: selectionScope === 'affected' ? input.files : [] }
    // Gates, full scope and smoke runs always run every file; only explicit affected test selections use the cache.
    let cache: CachedSelection | undefined
    if (!input.gate && !smokeTarget && selectionScope === 'affected' && input.files?.length && this.commits.testTree
      && (input.suite === 'unit' || input.suite === 'integration')) {
      const testTree = this.commits.testTree.bind(this.commits)
      cache = await planCachedSelection(this.pool, { workspaceId: scope.workspaceId, repository, commit,
        suite: input.suite, files: input.files, tree: () => testTree(repository, commit),
        partOf: file => input.suite === 'unit' && capabilities.parts ? unitPartOf(file, inventory?.heavy ?? []) : input.suite })
      selection.files = cache.files
    }
    const cachedFiles = cache?.cached.length ? cache.cached : undefined
    const empty = selectionScope === 'affected' && selection.files?.length === 0
    const split = input.suite === 'integration' ? capabilities.integrationPartitions : capabilities.parts
    let parts: { part: CiRunRecord['part']; partition: CiRunRecord['partition']; files: string[];
      expectedDurationMs?: number; suite?: CiRunRecord['suite']; plannedHostKey?: string;
      integrationShards?: number; requiresBuildComputer?: boolean }[] = split ? planCiParts(selection, unitDurations, inventory)
      : [{ part: null, partition: null, files: selection.files ?? [] }]
    let smokeShards: number | undefined
    if (smokeTarget && input.suite === 'integration') {
      const status = await this.planningEndpoint.request(smokeTarget, { operation: 'status' }).catch(error => {
        if (error instanceof DomainError) throw error
        // A Worker that is still reconnecting after a restart is temporarily unavailable, not an API failure.
        throw new DomainError('CI_SMOKE_COMPUTER_UNAVAILABLE', 'The smoke computer is not reachable yet. Retry shortly.', 503,
          { retryable: true })
      })
      if (status.operation !== 'status' || !status.ready) {
        throw new DomainError('CI_SMOKE_COMPUTER_UNAVAILABLE', 'The smoke computer is not ready.', 409)
      }
      smokeShards = buildComputerIntegrationShards(status, smokeTarget.buildAllowancePercent)
      const fleet = await this.planningEndpoint.computers()
      if (integration && fleet.some(computer => computer.hostRef.kind !== 'cloud')
        && fleet.some(computer => computer.hostRef.kind === 'cloud')) {
        const smokeUnit = await this.commits.unitInventory?.(repository, commit)
        if (smokeUnit) {
          try { await planCiGate(input, integration, smokeUnit, unitDurations, this.planningEndpoint, new Map(), this.reservedCloudSlots) }
          catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'CI_GATE_CAPACITY_REQUIRED') throw error
            log.info({ reason: error.message }, 'CI smoke has no complete ready gate fleet')
          }
        }
      }
      parts = [{ part: null, partition: null, files: input.files! }]
    } else if (input.gate) {
      const speeds = await readExecutorSpeeds(this.pool, this.planningEndpoint)
      timing.mark('speedsMs')
      const slots = await readCiSlots(this.pool, this.planningEndpoint)
      timing.mark('slotsMs')
      parts = await planCiGate(input, { ...integration!, durations: durations! }, inventory!, unitDurations, this.planningEndpoint,
        speeds, this.reservedCloudSlots, slots.ordinary, slots.usedByComputer)
    } else if (integration) {
      parts = planIntegrationParts(selection, { ...integration, durations: durations! }, await readCiSlots(this.pool, this.planningEndpoint))
    }
    if (!input.gate && input.suite === 'unit' && split) {
      parts = planCiParts(selection, unitDurations, inventory, (await readCiSlots(this.pool, this.planningEndpoint)).ordinary)
    }
    timing.mark('planMs')
    log.info({ gate: input.gate === true, suite: input.suite, ...timing.phases }, 'CI run preparation timing')
    const runs = parts.map((planned, index) => CiRunRecordSchema.parse({
      ...planned,
      ...(index === 0 && cachedFiles ? { cachedFiles } : {}),
      expectedDurationMs: planned.expectedDurationMs ?? (input.suite === 'unit' ? 210_000 : 150_000),
      ...(smokeTarget ? { plannedHostKey: smokeTarget.key,
        ...(smokeShards !== undefined ? { integrationShards: smokeShards } : {}) } : {}),
      id: randomUUID(), workspaceId: scope.workspaceId,
      suite: planned.suite ?? input.suite, scope: selectionScope, commit, repository, groupId,
      ciMirror: workspace.ciMirror ? `${workspace.ciMirror.owner}/${workspace.ciMirror.name}` : null,
      priority, priorityReason,
      ...(input.gate ? { gate: true, noSupersede: true } : {}),
      defaultBranch,
      ...(branch !== undefined ? { branch } : {}),
      ...(!input.gate && input.noSupersede !== undefined ? { noSupersede: input.noSupersede } : {}),
      ...(smokeTarget ? { noSupersede: true } : {}),
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
      ...(deriveFiles ? { deriveFiles } : {}),
      state: empty ? 'passed' : 'queued', computer: null, step: empty ? input.suite : null,
      exitCode: empty ? 0 : null,
      message: empty ? (cachedFiles ? `All ${cachedFiles.length} selected files already passed with identical inputs; `
        + 'see cachedFiles.' : 'No affected files for this suite.') : null,
      queuedAt: now, startedAt: empty ? now : null, finishedAt: empty ? now : null,
      initiator: { principalId: caller.id, executionId: scope.executionId ?? null } }))
    const measuredUnitDurations = Object.fromEntries((inventory?.files ?? []).filter(file => unitDurations[file] !== undefined)
      .map(file => [file, unitDurations[file]!]))
    if (Object.keys(measuredUnitDurations).length) durations = { ...durations, ...measuredUnitDurations }
    return { repository: workspace.repository, runs, durations,
      ...(cache && !empty ? { cacheKeys: cache.keys } : {}),
      ...(empty && cachedFiles ? { logTail: ciCachedNotice(cachedFiles) } : {}) }
  }

  private async smokeTargets(runs: CiRunRecord[]): Promise<Map<string, HostRef>> {
    const groups = [...new Set(runs.filter(run => run.noSupersede && run.plannedHostKey && !run.gate)
      .map(run => run.groupId))]
    if (!groups.length) return new Map()
    // Audit details preserve the target without changing the record shape read by a retained release.
    const rows = (await this.pool.query<{ group_id: string; target: unknown }>(`select
      details->>'groupId' as group_id, details->'smokeComputer' as target from management_audit
      where action='ci.priority' and details->>'groupId'=any($1::text[]) and details ? 'smokeComputer'`,
    [groups])).rows
    return new Map(rows.map(row => [row.group_id, CiComputerRefSchema.parse(row.target)]))
  }

  /** The repository's learned test file durations, most recently measured first, within the start request's
   * bound. Files no run has measured use the planner's median or equal-weight fallback. */
  private async learnedDurations(repository: string): Promise<CiDurations | null> {
    const rows = (await this.pool.query<{ file: string; duration_ms: number }>(`select file,duration_ms from ci_file_durations
      where repository=$1 order by updated_at desc,file limit 1000`, [repository])).rows
    return rows.length ? Object.fromEntries(rows.map(row => [row.file, row.duration_ms])) : null
  }

  /** Folds a finished run's measured file durations into the repository's history: an exponential moving
   * average per file, so one slow run moves the expectation only halfway. Files not measured for 30 days are dropped. */
  private async learnDurations(repository: string, durations: CiDurations) {
    const files = Object.keys(durations)
    if (!files.length) return
    await this.pool.query(`insert into ci_file_durations(repository,file,duration_ms)
      select $1,file,greatest(1,round(ms))::integer from unnest($2::text[],$3::double precision[]) as measured(file,ms)
      on conflict (repository,file) do update set
        duration_ms=greatest(1,round((ci_file_durations.duration_ms+excluded.duration_ms)/2.0))::integer,
        samples=ci_file_durations.samples+1, updated_at=now()`, [repository, files, files.map(file => durations[file])])
    await this.pool.query(`delete from ci_file_durations where repository=$1 and updated_at < now() - interval '30 days'`,
      [repository])
  }

  private async read(id: string, workspaceId: string, sql: SqlQuery = this.pool): Promise<CiRunRecord> {
    const row = (await sql.query<{ record: unknown }>('select record from ci_runs where id=$1 and workspace_id=$2',
      [id, workspaceId])).rows[0]
    if (!row) throw new DomainError('CI_RUN_NOT_FOUND', 'No such CI run in this workspace.', 404)
    return CiRunRecordSchema.parse(row.record)
  }

  get(caller: ManagementPrincipal, input: Parameters<HostCiReads['get']>[1], signal?: AbortSignal) {
    return this.reads.get(caller, input, signal)
  }

  tests(caller: ManagementPrincipal, input: Parameters<HostCiReads['tests']>[1]) {
    return this.reads.tests(caller, input)
  }

  list(caller: ManagementPrincipal, input: Parameters<HostCiReads['list']>[1]) {
    return this.reads.list(caller, input)
  }

  logs(caller: ManagementPrincipal, input: Parameters<HostCiReads['logs']>[1]) {
    return this.reads.logs(caller, input)
  }

  async cancel(caller: ManagementPrincipal,
    input: { workspaceId?: string | undefined; ticketId: string; commandId?: string | undefined },
    source: 'http' | 'mcp' = 'mcp'): Promise<{ run: CiRunRecord }> {
    const scope = await this.authority.resolve(caller, input.workspaceId, CI_RUN_ACTIONS)
    const run = await this.read(input.ticketId, scope.workspaceId)
    this.stoppingRuns += 1
    try {
      // Persist intent before trying the executor lock, even while its start reply is pending.
      return await this.cancelTicket(scope.workspaceId, run.id, {
        principalId: caller.id, source, commandId: input.commandId ?? randomUUID(), reason: 'direct',
      })
    } finally {
      this.stoppingRuns -= 1
    }
  }

  /** The persisted, authorized Stop intent authorizes cleanup of its Agents' tickets. */
  async cancelStoppedRun(runId: string): Promise<void> {
    const intent = (await this.pool.query<{ workspace_id: string; record: RunStopAudit }>(
      `select workspace_id,record from workflow_stop_intents where run_id=$1
        order by principal_id,command_id limit 1`, [runId])).rows[0]
    if (!intent) return
    this.stoppingRuns += 1
    try {
      // Drain dispatch before selecting tickets, including starts awaiting their provider reply.
      await this.dispatching
      const tickets = (await this.pool.query<{ id: string }>(`select c.id from ci_runs c
        join harness_executions e on e.id=c.record#>>'{initiator,executionId}'
        where e.run_id=$1 and c.workspace_id=$2 and c.state in ('queued','starting','running')
        order by c.id`, [runId, intent.workspace_id])).rows
      const audit: CiCancellation = {
        principalId: intent.record.principalId,
        source: intent.record.source,
        commandId: intent.record.commandId,
        runId,
        reason: 'run_stop',
      }
      const results = await Promise.allSettled(tickets.map(ticket =>
        this.cancelTicket(intent.workspace_id, ticket.id, audit)))
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Run CI cancellation is incomplete.')
    } finally {
      this.stoppingRuns -= 1
    }
  }

  private async cancelTicket(workspaceId: string, ticketId: string,
    audit?: CiCancellation): Promise<{ run: CiRunRecord }> {
    let run = await this.read(ticketId, workspaceId)
    audit = run.cancellation ?? audit
    if (run.state === 'queued') {
      const message = run.supersededBy ? `superseded by ${run.supersededBy}` : 'Canceled.'
      const canceled = { ...run, state: 'canceled' as const, finishedAt: new Date().toISOString(), message,
        cancellation: undefined, dispatchRequest: undefined }
      const saved = await this.saveCancellation(`update ci_runs set state='canceled', host_key=null, record=$2::jsonb
        where id=$1 and state='queued' and record->>'supersededBy' is not distinct from $3`,
      [run.id, serializeCiJson(canceled), run.supersededBy ?? null], canceled, audit)
      if (!saved.rowCount) return this.cancelTicket(workspaceId, ticketId, audit)
      return { run: canceled }
    }
    if (run.computer && ['starting', 'running'].includes(run.state)) {
      if (!run.cancellation) {
        const cancellation = audit ?? { principalId: run.initiator.principalId, source: 'mcp' as const,
          commandId: randomUUID(), reason: 'superseded' as const }
        const pending = { ...run, cancellation }
        const saved = await this.pool.query(`update ci_runs set record=$2::jsonb
          where id=$1 and state in ('starting','running') and record=$3::jsonb`,
        [run.id, JSON.stringify(pending), JSON.stringify(run)])
        if (!saved.rowCount) return this.cancelTicket(workspaceId, ticketId, audit)
        run = pending
        audit = cancellation
      }
      await withCiTicketLock(this.pool, run.id, async client => {
        const current = await this.read(run.id, workspaceId, client)
        if (current.computer && ['starting', 'running'].includes(current.state)) {
          await this.cancelAssignedTicket(current, client, current.cancellation ?? audit)
        }
      })
    }
    const current = await this.read(run.id, workspaceId)
    const reassigned = ['starting', 'running'].includes(current.state)
      && JSON.stringify(current.computer) !== JSON.stringify(run.computer)
    if (current.state === 'queued' || reassigned) return this.cancelTicket(workspaceId, ticketId, audit)
    if ((audit || run.supersededBy) && ['starting', 'running'].includes(current.state)) {
      throw new DomainError('CI_CANCEL_PENDING', 'The build computer has not canceled the CI ticket.', 409)
    }
    return { run: current }
  }

  private async cancelAssignedTicket(run: CiRunRecord, client: pg.PoolClient, audit?: CiCancellation) {
    const computer = await this.computer(run.computer!.hostRef)
    const state = await cancelAssignedCiTicket(this.endpoint, computer, run)
    await this.settle(run, computer, state, { client, audit })
  }

  private async cancelSuperseded() {
    const rows = (await this.pool.query<{ record: unknown }>(`select record from ci_runs
      where state in ('queued','starting','running') and record->>'supersededBy' is not null`)).rows
    const runs = rows.map(row => CiRunRecordSchema.parse(row.record)).filter(run => run.supersededBy)
    await inBatches(runs, 8, async run => {
      try {
        await this.cancelTicket(run.workspaceId, run.id)
      } catch (error) {
        log.warn({ err: error, runId: run.id }, 'Superseded CI cleanup failed; retrying')
      }
    })
  }

  private async saveCancellation(sql: string, parameters: unknown[], run: CiRunRecord,
    audit?: CiCancellation, client?: pg.PoolClient) {
    if (!audit || run.state !== 'canceled') return (client ?? this.pool).query(sql, parameters)
    return inTransaction(this.pool, client, async client => {
      const saved = await client.query(sql, parameters)
      if (saved.rowCount) {
        await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
          values($1,$2,'ci.cancel',$3,'succeeded',$4::jsonb)`,
        [audit.principalId, audit.source, `ci:${run.id}`, JSON.stringify({
          commandId: audit.commandId, runId: audit.runId, ticketId: run.id,
          executionId: run.initiator.executionId, reason: audit.reason,
        })])
      }
      return saved
    })
  }

  async computers(caller: ManagementPrincipal, input: { workspaceId?: string | undefined }) {
    return retryRead(async () => {
      const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
      const queued = (await this.pool.query<{ record: unknown; position: number }>(`select record,position from
        (select record,row_number() over (order by ${CI_QUEUE_ORDER})::integer as position
          from ci_runs where state='queued') queue where record->>'workspaceId'=$1
          and ($2::text is null or record#>>'{initiator,executionId}'=$2)
        order by position limit 501`, [scope.workspaceId,
        caller.audience === 'worker' ? scope.executionId ?? '' : null])).rows
      const queue = queued.slice(0, 500).map(row => {
        const run = CiRunRecordSchema.parse(row.record)
        return { ticketId: run.id, priority: run.priority, priorityReason: run.priorityReason,
          position: row.position, reason: ciQueueReason(run) }
      })
      const active = (await this.pool.query<{ id: string; host_key: string; record: unknown }>(
        `select id,host_key,record from ci_runs where state in ('starting','running') and host_key is not null
          order by created_at,id`)).rows
      // Ask every computer at once: one slow or offline host must not serialize the whole listing.
      // Share the short-lived status snapshot that admission and dispatch keep fresh.
      const result = await Promise.all((await this.planningEndpoint.computers()).map(async computer => {
        const assigned = active.filter(run => run.host_key === computer.key)
        // A starting ticket needs a live status: it can acknowledge a start whose reply was lost.
        const starting = assigned.some(run => CiRunRecordSchema.parse(run.record).state === 'starting')
        const status = await (starting ? this.endpoint : this.planningEndpoint).request(computer, { operation: 'status' })
          .catch(error => error as Error)
        const running = []
        for (const row of assigned) {
          const previous = CiRunRecordSchema.parse(row.record)
          const current = previous.state === 'starting' && !previous.startedAt
            ? await this.read(row.id, previous.workspaceId) : previous
          if (['starting', 'running'].includes(current.state)) running.push(row.id)
        }
        return status instanceof Error
          ? { label: computer.label, hostRef: computer.hostRef, priority: computer.priority,
            buildAllowancePercent: computer.buildAllowancePercent ?? 100,
            ready: false, reasons: [status.message], running, slotsUsed: running.length,
            slotsTotal: Math.max(1, running.length) }
          : status.operation === 'status' ? { label: computer.label, hostRef: computer.hostRef, priority: computer.priority,
            buildAllowancePercent: status.buildAllowancePercent ?? computer.buildAllowancePercent ?? 100,
            allowedCpuCount: status.cpuCount,
            ready: status.ready, reasons: status.reasons, cpuCount: status.cpuCount, memoryBytes: status.memoryBytes,
            availableMemoryBytes: status.availableMemoryBytes,
            ...(status.userSystemd ? { userSystemd: status.userSystemd } : {}),
            slotsUsed: Math.max(running.length, status.slotsUsed ?? 0), slotsTotal: status.slotsTotal ?? 1,
            running } : null
      }))
      return { computers: result.filter(Boolean), queue, queueTruncated: queued.length > 500 }
    })
  }

  private async computer(hostRef: HostRef) {
    const computer = (await this.endpoint.computers()).find(value => JSON.stringify(value.hostRef) === JSON.stringify(hostRef))
    if (computer) return computer
    // Disabling future builds does not prevent reading or cancelling an assigned run.
    if (hostRef.kind === 'main') {
      return { key: `${hostRef.mainId}:main`, hostRef, label: 'Main computer', priority: 0 }
    }
    if (hostRef.kind === 'device' && hostRef.deviceId) {
      return { key: `${hostRef.mainId}:${hostRef.deviceId}`, hostRef,
        label: `Computer ${hostRef.deviceId.slice(0, 8)}`, priority: 0 }
    }
    if (hostRef.kind === 'cloud' && hostRef.provider) {
      return { key: `${hostRef.mainId}:cloud:${hostRef.provider}:${hostRef.slot ?? 0}`, hostRef,
        label: hostRef.provider === 'github' ? 'GitHub Actions' : 'CircleCI', priority: 0 }
    }
    throw new DomainError('CI_COMPUTER_OFFLINE', 'The build computer running this CI run is offline.', 409)
  }

  private async settle(run: CiRunRecord, computer: HostCiComputer, state: { state: string; step: string | null
    exitCode: number | null; startedAt: string | null; finishedAt: string | null; message: string | null
    collection?: CiHostRun['collection']; provenance?: CiHostRun['provenance'];
    mirrorPublication?: CiHostRun['mirrorPublication']; testsStarted?: CiHostRun['testsStarted'];
    transport?: CiHostRun['transport'] },
    options: { logTail?: string | undefined; audit?: CiCancellation | undefined;
      client?: pg.PoolClient | undefined; observation?: CiRunRecord['observation'] } = {}) {
    const { logTail, audit, client } = options
    const setupRequeue = computer.hostRef.kind === 'cloud' && state.state === 'failed'
      && state.testsStarted === false && !run.setupRetry && !run.cancellation && !run.supersededBy
    let setupRetry = run.setupRetry
    if (setupRequeue) {
      const reason = sanitizeCiText(state.message ?? 'Cloud setup failed before the first test started.').slice(0, 2000)
      setupRetry = { runId: randomUUID(), failedComputer: computer.hostRef, reason }
      state = { state: 'queued', step: null, exitCode: null, startedAt: null, finishedAt: null,
        message: `Queued once on another slot after setup failure: ${reason}`.slice(0, 2000) }
    }
    const requeued = state.state === 'queued'
    const unstartedProviders = new Set(run.unstartedProviders ?? [])
    if (requeued && !setupRequeue && computer.hostRef.provider) unstartedProviders.add(computer.hostRef.provider)
    const messages = ciMessages(run, state.message === null ? null : sanitizeCiText(state.message))
    const terminal = !['queued', 'starting', 'running'].includes(state.state)
    const next = CiRunRecordSchema.parse({ ...run, state: state.state, step: state.step, exitCode: state.exitCode,
      computer: requeued ? null : { hostRef: computer.hostRef, label: computer.label },
      startedAt: requeued ? null : run.startedAt ?? state.startedAt,
      finishedAt: state.finishedAt, ...messages, dispatchRequest: undefined,
      dispatchedAt: undefined, dispatchHostKey: undefined,
      setupRetry,
      ...(options.observation ? { observation: options.observation } : {}),
      ...(state.transport ? { transport: state.transport } : {}),
      ...(setupRequeue ? { dispatchAttempts: undefined, collection: undefined, provenance: undefined,
        mirrorPublication: undefined } : {}),
      cancellation: terminal ? undefined : run.cancellation,
      ...(state.collection ? { collection: state.collection } : {}),
      ...(state.provenance ? { provenance: state.provenance } : {}),
      ...(state.mirrorPublication ? { mirrorPublication: state.mirrorPublication } : {}),
      ...(unstartedProviders.size ? { unstartedProviders: [...unstartedProviders] } : {}) })
    const hostKey = ['starting', 'running'].includes(next.state) ? computer.key : null
    let savedLogTail = logTail === undefined ? null : sanitizeCiText(logTail)
    if (setupRequeue) savedLogTail = ''
    const saved = await this.saveCancellation(`update ci_runs set state=$2, host_key=$3, record=$4::jsonb,
        log_tail=coalesce($6,log_tail),
        test_results=case when $10 then null else test_results end,
        durations=case when $10 then null else durations end
      where id=$1 and (state in ('queued','starting','running') or state=$8 and record->>'collection'='pending')
        and host_key is not distinct from $5
        and record->>'supersededBy' is not distinct from $7
        and record=$9::jsonb
        and (state is distinct from $2 or host_key is distinct from $3
          or record is distinct from $4::jsonb or ($6::text is not null and log_tail is distinct from $6))`,
      [run.id, next.state, hostKey, serializeCiJson(next), ['starting', 'running'].includes(run.state) ? computer.key : null,
        savedLogTail,
        run.supersededBy ?? null, run.state, JSON.stringify(run), setupRequeue],
      next, run.cancellation ?? audit, client)
    if (requeued && saved.rowCount) log.warn({ runId: run.id, provider: computer.hostRef.provider, message: messages.message },
      'CI ticket queued for another computer')
    return Boolean(saved.rowCount)
  }

  /** Refresh running runs and dispatch queued work, retaining wake-ups during an active pass. */
  dispatch(): Promise<void> {
    this.dispatchRequested = true
    if (this.stoppingRuns) return this.dispatching ?? Promise.resolve()
    this.dispatching ??= (async () => {
      while (this.dispatchRequested && !this.stoppingRuns) {
        this.dispatchRequested = false
        await withProviderPoll(() => this.dispatchOnce())
      }
    })().catch(error => log.warn({ err: error }, 'CI dispatch failed'))
      .finally(() => { this.dispatching = undefined })
    return this.dispatching
  }

  private dispatchServices() {
    return { pool: this.pool, endpoint: this.endpoint,
      read: (id: string, workspaceId: string, client: pg.PoolClient) => this.read(id, workspaceId, client),
      settle: (run: CiRunRecord, computer: HostCiComputer, state: CiDispatchState,
        options: { client: pg.PoolClient }) => this.settle(run, computer, state, options),
    }
  }

  private sendDispatch(run: CiRunRecord, computer: HostCiComputer) {
    return sendCiDispatch(this.dispatchServices(), run, computer)
  }

  private reconcileHostStart(run: CiRunRecord, computer: HostCiComputer, status: CiHostStatus | null) {
    return reconcileCiHostStart(this.dispatchServices(), run, computer, status)
  }

  private async refreshRun(row: { record: unknown; host_key: string | null }, computers: HostCiComputer[]) {
    const run = CiRunRecordSchema.parse(row.record)
    if (!run.cancellation && run.observation?.nextAttemptAt
      && Date.now() < Date.parse(run.observation.nextAttemptAt)) return
    let computer = computers.find(value => value.key === row.host_key)
      ?? computers.find(value => run.collection === 'pending' && run.computer
        && value.hostRef.kind === run.computer.hostRef.kind && value.hostRef.mainId === run.computer.hostRef.mainId
        && value.hostRef.deviceId === run.computer.hostRef.deviceId && value.hostRef.provider === run.computer.hostRef.provider
        && value.hostRef.slot === run.computer.hostRef.slot)
      ?? (run.computer ? await this.computer(run.computer.hostRef) : null)
    if (!computer) throw new DomainError('CI_COMPUTER_OFFLINE', 'The CI executor is unavailable.', 503)
    if (row.host_key) computer = { ...computer, key: row.host_key }
    if (run.cancellation) {
      await this.cancelTicket(run.workspaceId, run.id, run.cancellation)
      return
    }
    if (computer.hostRef.kind !== 'cloud' && run.state === 'starting' && !run.startedAt) {
      await readCiComputerStatus(this.endpoint, computer)
      return
    }
    if (run.dispatchRequest || computer.hostRef.kind === 'cloud' && run.state === 'starting' && !run.startedAt) {
      await this.sendDispatch(run, computer)
      return
    }
    const request: CiHostRequest = { operation: 'read', runId: ciExecutionRunId(run), afterOffset: 0, maxBytes: 32_768,
      ...(['integration', 'unit'].includes(run.suite) ? { durations: true } : {}) }
    const reply = await (computer.hostRef.kind === 'cloud'
      ? requestCloud(this.endpoint, computer, request)
      : this.endpoint.request(computer, request, { priority: 'background' }))
    if (computer.hostRef.kind === 'cloud' && run.state === 'starting') {
      const recovered = await expireCloudDispatch(this.endpoint, computer, run,
        reply?.operation === 'read' ? reply.run : undefined)
      if (recovered && !['queued', 'starting', 'running'].includes(recovered.state)) {
        await this.settle(run, computer, recovered)
        return
      }
    }
    if (reply.operation !== 'read') {
      throw new DomainError('CI_HOST_REPLY_INVALID', 'Expected a CI run observation.', 502)
    }
    let logError: unknown
    let logTail: string | undefined = reply.text
    if (reply.run.logBytes > 32_768) {
      const tail = await this.endpoint.request(computer, { operation: 'read', runId: ciExecutionRunId(run),
        afterOffset: reply.run.logBytes - 32_768, maxBytes: 32_768 }, { priority: 'background' }).catch(error => {
          logError = error
          return null
        })
      if (tail?.operation === 'read') logTail = tail.text
      else {
        logTail = undefined
        logError ??= new DomainError('CI_HOST_REPLY_INVALID', 'Expected a CI log tail.', 502)
      }
    }
    const observation: CiRunRecord['observation'] = logError ? undefined : { status: 'available',
      lastSuccessAt: new Date().toISOString(), lastError: null, consecutiveFailures: 0, nextAttemptAt: null }
    if (computer.hostRef.kind === 'cloud' && reply.run.state === 'failed') {
      if (reply.run.testsStarted === false && !run.setupRetry && !run.cancellation && !run.supersededBy) {
        await this.settle(run, computer, reply.run, { logTail, observation })
        if (logError) throw logError
        return
      }
      // Wait for the failure metadata before deciding whether this attempt used its setup retry.
      if (reply.run.testsStarted === undefined && reply.run.collection === 'pending') {
        if (logError) throw logError
        return
      }
    }
    const terminal = !['queued', 'starting', 'running'].includes(reply.run.state)
    let collected = { run: reply.run, durations: reply.durations }
    if (terminal) collected = await collectCiResults(this.pool, this.endpoint, computer, run, reply)
    if (!['queued', 'starting', 'running'].includes(run.state)) {
      collected.run = { ...collected.run, state: run.state, exitCode: run.exitCode, finishedAt: run.finishedAt }
    }
    if (terminal && collected.durations && collected.run.collection !== 'pending') {
      try {
        await this.learnDurations(run.repository, collected.durations)
      } catch (error) {
        collected.run = { ...collected.run, collection: 'pending' }
        log.warn({ err: error, runId: run.id }, 'CI durations remain pending')
      }
    }
    if (terminal && collected.run.collection === 'complete') {
      try {
        await recordCiResultCache(this.pool, run, collected.run.state)
      } catch (error) {
        collected.run = { ...collected.run, collection: 'pending' }
        log.warn({ err: error, runId: run.id }, 'CI result cache recording remains pending')
      }
    }
    await this.settle(run, computer, collected.run, { logTail, observation })
    if (logError) throw logError
  }

  private async recordObservationFailure(id: string, workspaceId: string, error: unknown) {
    const run = await this.read(id, workspaceId)
    const consecutiveFailures = (run.observation?.consecutiveFailures ?? 0) + 1
    const code = error && typeof error === 'object' && 'code' in error
      && typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? ` (${error.code})` : ''
    const lastError = `CI observation unavailable${code}; ownership retained.`
    const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(consecutiveFailures - 1, 6))
    const observation: CiRunRecord['observation'] = { status: 'unavailable',
      lastSuccessAt: run.observation?.lastSuccessAt ?? null, lastError, consecutiveFailures,
      nextAttemptAt: new Date(Date.now() + delayMs).toISOString() }
    const next = CiRunRecordSchema.parse({ ...run, observation,
      message: lastError })
    log.warn({ runId: id, observation }, 'CI observation unavailable; retry scheduled')
    await this.pool.query(`update ci_runs set record=$4::jsonb
      where id=$1 and state=$2 and workspace_id=$3 and record=$5::jsonb`,
    [run.id, run.state, workspaceId, serializeCiJson(next), JSON.stringify(run)])
  }

  private async refreshActiveRuns(active: { id: string; record: unknown; host_key: string | null }[],
    computers: HostCiComputer[]) {
    const refresh = async (row: typeof active[number]) => {
      try {
        await this.refreshRun(row, computers)
      } catch (error) {
        try {
          await this.recordObservationFailure(row.id, CiRunRecordSchema.parse(row.record).workspaceId, error)
        } catch {
          log.warn({ runId: row.id }, 'CI observation failed and its status could not be persisted')
        }
      }
    }
    const cloud = active.filter(row => CiRunRecordSchema.parse(row.record).computer?.hostRef.kind === 'cloud')
    const local = active.filter(row => CiRunRecordSchema.parse(row.record).computer?.hostRef.kind !== 'cloud')
    const expectedEnd = (row: typeof active[number]) => {
      const run = CiRunRecordSchema.parse(row.record)
      if (!run.startedAt || !run.expectedDurationMs) return Infinity
      return Date.parse(run.startedAt) + run.expectedDurationMs
    }
    cloud.sort((left, right) => expectedEnd(left) - expectedEnd(right))
    // Provider reads cover the cloud fleet together; local host reads retain their bounded batch.
    await Promise.all([inBatches(cloud, 48, refresh), inBatches(local, 8, refresh)])
  }

  private async dispatchOnce() {
    await this.cancelSuperseded()
    const computers = await this.endpoint.computers()
    const active = (await this.pool.query<{ id: string; record: unknown; host_key: string | null }>(
      `select id,record,host_key from ci_runs where state in ('starting','running') or record->>'collection'='pending'
        or (state in ('passed','failed','canceled','lost') and record#>>'{observation,status}'='unavailable')`)).rows
    await this.refreshActiveRuns(active, computers)
    const busyRows = (await this.pool.query<{ host_key: string; record: unknown }>(
      `select host_key,record from ci_runs where state in ('starting','running')`)).rows
    const used = new Map<string, number>()
    for (const row of busyRows) used.set(row.host_key, (used.get(row.host_key) ?? 0) + 1)
    const { gate, reservedHosts } = await readCiGateReservation(this.pool)
    const { parsed, durations } = await readQueuedCiRuns(this.pool)
    const hasQueuedGate = parsed.some(run => run.gate)
    const totals = new Map<string, number>()
    const unavailable = new Map<string, string>()
    const gateShards = new Map<string, number>()
    await inBatches(computers, 8, async computer => {
      if (computer.hostRef.kind === 'cloud' && !hasQueuedGate) {
        totals.set(computer.key, 1)
        return
      }
      const status = await readCiComputerStatus(this.endpoint, computer)
      const slots = computer.hostRef.kind === 'cloud' ? 1 : status?.slotsTotal ?? 1
      totals.set(computer.key, status?.ready ? slots : 0)
      if (!status?.ready) unavailable.set(computer.key, status?.reasons.join('; ') || 'Worker CI status unavailable')
      if (status) {
        used.set(computer.key, Math.max(used.get(computer.key) ?? 0, status.slotsUsed ?? 0))
        if (status.ready) {
          gateShards.set(computer.key, buildComputerIntegrationShards(status, computer.buildAllowancePercent))
        }
      }
    })
    const freeSlots = (computer: HostCiComputer) => Math.max(0,
      (totals.get(computer.key) ?? 1) - (used.get(computer.key) ?? 0))
    const releaseSlot = (computer: HostCiComputer) => {
      used.set(computer.key, Math.max(0, (used.get(computer.key) ?? 0) - 1))
    }
    const github = computers.filter(isGitHubComputer)
    const githubKeys = new Set(github.map(computer => computer.key))
    const integrationOnGitHub = new Set(busyRows.filter(row => githubKeys.has(row.host_key)
      && CiRunRecordSchema.parse(row.record).suite === 'integration').map(row => row.host_key))
    const smokeTargets = await this.smokeTargets(parsed)
    let queued = await releaseCiSlowTier(this.pool, parsed)
    // Reserve four GitHub slots while checks wait, including integration already using GitHub.
    const githubIntegrationLimit = Math.max(0, github.length - (queued.some(run => run.suite !== 'integration') ? 4 : 0))
    queued = await weighCiPartitions(this.pool, this.endpoint, queued, computers.flatMap(computer =>
      Array.from({ length: freeSlots(computer) }, () => computer)), (id, workspaceId) => this.read(id, workspaceId))
    queued.sort((left, right) => (left.priority === right.priority
      && !left.gate && !right.gate
      ? Number(needsSystemdExecutor(right)) - Number(needsSystemdExecutor(left)) : 0) || compareCiQueue(left, right))
    const stealsGatePart = gatePartStealer(computers, queued)
    const reservedCloud = reservedCloudSlotKeys(computers, this.reservedCloudSlots)
    const canTakeGatePart = (run: CiRunRecord, computer: HostCiComputer) => {
      if (!gateShards.has(computer.key)) return false
      if (run.setupRetry) return true
      if (computer.key === run.plannedHostKey) return true
      if (buildComputerGatePart(run, computers)) {
        return computer.hostRef.kind !== 'cloud'
          && gateShards.get(computer.key)! >= run.integrationShards!
          && stealsGatePart(run, computer)
      }
      return !run.plannedHostKey || !gateShards.has(run.plannedHostKey) || stealsGatePart(run, computer)
    }
    queued = await splitUnavailableGateParts(this.pool, queued, { computers, shards: gateShards, durations,
      reservedCloud, gate, freeSlots, canTake: canTakeGatePart,
      idle: computer => (used.get(computer.key) ?? 0) === 0 })
    // Reserve slots before awaiting a start so concurrent dispatches cannot spend the same capacity.
    await Promise.all(queued.map(async run => {
      const smokeTarget = smokeTargets.get(run.groupId)
      const blocked = gateQueueBlock(run, gate)
      if (blocked) {
        if (run.message !== blocked) await saveQueuedCiRun(this.pool, run, { ...run, message: blocked })
        return
      }
      if (run.suite === 'integration' && run.partition && !run.partition.weights) return
      const hostRequired = needsSystemdExecutor(run)
      const integrationLimit = run.priority === 'high'
        && !queued.some(check => check.suite !== 'integration' && compareCiQueue(check, run) < 0)
        ? github.length : githubIntegrationLimit
      const reasons = (run.unstartedProviders ?? []).map(provider => `${provider}: dispatch retries exhausted`)
      const preferred = (computer: HostCiComputer) => {
        if (run.gate && run.suite !== 'integration') return Number(computer.hostRef.kind === 'cloud')
        if (computer.hostRef.kind !== 'cloud') return 3
        if (run.suite !== 'integration') return Number(isGitHubComputer(computer))
        return isGitHubComputer(computer) ? 1 : 2
      }
      const affectedFiles = run.scope === 'affected' && !run.deriveFiles ? { files: run.files } : {}
      const selection = (run.gate || smokeTarget) && run.suite === 'integration'
        ? { gate: true, scope: 'full' as const, integrationShards: run.integrationShards!, files: run.files }
        : affectedFiles
      const order = computers.filter(computer => runsOnCircleCi(run)
        || computer.hostRef.kind !== 'cloud' || computer.hostRef.provider !== 'circleci')
        .filter(computer => !hostRequired || supportsUserSystemd(computer))
        .filter(computer => !run.dispatchHostKey || computer.key === run.dispatchHostKey)
        .filter(computer => !run.setupRetry || !isDeepStrictEqual(computer.hostRef, run.setupRetry.failedComputer))
        .filter(computer => !smokeTarget || isDeepStrictEqual(computer.hostRef, smokeTarget))
        .filter(computer => !run.gate || canTakeGatePart(run, computer))
        .filter(computer => run.gate || computer.hostRef.kind === 'cloud' || !reservedHosts.has(computer.key))
        .filter(computer => computer.hostRef.kind !== 'cloud' || !computer.hostRef.provider
          || !run.unstartedProviders?.includes(computer.hostRef.provider))
        .sort((left, right) => Number(right.key === run.plannedHostKey) - Number(left.key === run.plannedHostKey)
          || preferred(right) - preferred(left)
          || Number(reservedCloud.has(left.key)) - Number(reservedCloud.has(right.key))
          || right.priority - left.priority)
      for (const computer of order) {
        const reason = unavailable.get(computer.key)
        if (reason) {
          reasons.push(`${computer.label}: ${reason}`)
          continue
        }
        if (run.gate && reservedCloud.has(computer.key)) {
          reasons.push(`${computer.label}: reserved for non-gate CI while a gate runs`)
          continue
        }
        const exclusiveGate = run.gate && computer.hostRef.kind !== 'cloud'
        if (exclusiveGate && (used.get(computer.key) ?? 0) > 0) {
          reasons.push(`${computer.label}: gate waits for exclusive use of this build computer`)
          continue
        }
        if (computer.hostRef.kind === 'cloud' && computer.hostRef.provider
          && run.unstartedProviders?.includes(computer.hostRef.provider)) continue
        if (!freeSlots(computer)) {
          reasons.push(`${computer.label}: all CI slots in use (${used.get(computer.key) ?? 0}/${totals.get(computer.key) ?? 1})`)
          continue
        }
        const usesGitHubIntegration = run.suite === 'integration' && isGitHubComputer(computer)
        if (usesGitHubIntegration && !run.gate && integrationOnGitHub.size >= integrationLimit) {
          reasons.push(`${computer.label}: slots reserved for queued checks`)
          continue
        }
        used.set(computer.key, (used.get(computer.key) ?? 0) + (exclusiveGate ? totals.get(computer.key) ?? 1 : 1))
        if (usesGitHubIntegration) integrationOnGitHub.add(computer.key)
        const shards = gateDispatchShards(run, computer.key, gateShards.get(computer.key)!)
        const assigned = await claimCiSlot(this.pool, run, computer, {
          operation: 'start', runId: ciExecutionRunId(run), workspaceId: run.workspaceId, ciMirror: run.ciMirror ?? null,
          repository: run.repository, commit: run.commit, suite: run.suite,
          ...(run.part ? { part: run.part } : {}),
          ...(run.partition ? { partition: run.partition } : {}),
          scope: run.scope, ...selection, ...shards,
          ...(run.expectedDurationMs !== undefined ? { expectedDurationMs: run.expectedDurationMs } : {}),
          ...(run.defaultBranch ? { defaultBranch: run.defaultBranch } : {}),
          ...(run.baseCommit ? { baseCommit: run.baseCommit } : {}),
          ...(run.cachedFiles?.length ? { notice: ciCachedNotice(run.cachedFiles) } : {}),
          ...(durations.get(run.id) ? { durations: durations.get(run.id)! } : {}),
        })
        if (assigned === 'busy') {
          used.set(computer.key, totals.get(computer.key) ?? 1)
          if (usesGitHubIntegration) integrationOnGitHub.delete(computer.key)
          reasons.push(`${computer.label}: slot is busy with another CI ticket`)
          continue
        }
        if (!assigned) {
          releaseSlot(computer)
          if (usesGitHubIntegration) integrationOnGitHub.delete(computer.key)
          return
        }
        const outcome = await this.sendDispatch(assigned, computer)
        if (outcome === 'pending') return
        run = await this.read(run.id, run.workspaceId)
        if (run.state !== 'queued') return
        if (outcome === 'busy') used.set(computer.key, totals.get(computer.key) ?? 1)
        else releaseSlot(computer)
        if (usesGitHubIntegration) integrationOnGitHub.delete(computer.key)
        reasons.push(`${computer.label}: ${run.message ?? outcome}`)
      }
      const systemdCloud = computers.some(computer => computer.hostRef.kind === 'cloud' && supportsUserSystemd(computer))
      let prefix = `No ready computer for ${run.part ?? run.suite}`
      if (hostRequired) {
        prefix = systemdCloud ? 'Waiting for a systemd-capable executor'
          : 'Waiting for a build computer: this integration slice needs one'
      }
      const message = sanitizeCiText(`${prefix}; ${reasons.join('; ') || 'no eligible computers'}`.slice(0, 2000))
      if (message !== run.message) await saveQueuedCiRun(this.pool, run, { ...run, message })
    }))
  }
}

export { CI_HOST_NAMESPACE }
