import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { inTransaction, type SqlQuery } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import { CI_HOST_NAMESPACE, CI_LOG_MAX_BYTES, CI_RUN_JOBS_LIMIT, CiComputerRefSchema, CiHostReplySchema, CiListOutputSchema, CiRunRecordSchema, CiRunOutputSchema,
  WorkspaceSchema,
  requiresUserSystemd,
  type CiDurations, type CiHostRequest, type CiHostReply, type CiHostRun, type CiListOutput, type CiRunRecord, type CiRunInput,
  type CiTestResults, type CiTestStatus, type CiUserSystemd, type CiCancellation, type Workspace } from '@foreman-code/contracts'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../jobs/ciAuthority.js'
import { DomainError, databaseReadFailure } from '../errors.js'
import { requireAuthorization } from '../access/policy.js'
import { componentLogger } from '../diagnostics/logger.js'
import { ciGroupState, planCiParts, runsOnCircleCi, type CiUnitInventory } from './parts.js'
import { planIntegrationParts, type CiIntegrationInventory, type CiIntegrationSlots } from './integrationParts.js'
import { assertCiReadAccess } from './runAccess.js'
import type { CiRepositoryCapabilities } from './repository.js'
import { RUN_CI_JOBS_SQL, runCiJob, storedCiTestResults, type RunCiJobRow } from './runJobs.js'
import { fallbackOnError } from '../diagnostics/ignoredError.js'
import { CI_QUEUE_ORDER, ciQueueReason, compareCiQueue } from './priority.js'
import { prepareCiSupersession, validateCiSupersession, supersedeCiRuns } from './supersession.js'
import { gatePartStealer, gateQueueBlock, planCiGate, readCiComputerStatus } from './gate.js'
import { gateIntegrationShards } from './capacity.js'
import { ciGateReport } from './gateReport.js'
import { claimCiDispatch, releaseCiDispatch, saveQueuedCiRun, ciMessages, rejectedCiStart, withCiTicketLock } from './dispatch.js'
import { collectCiResults } from './resultCollection.js'
import { sanitizeCiText, serializeCiJson } from './text.js'
import { isGitHubComputer, supportsUserSystemd } from './computerCapabilities.js'
import { weighCiPartitions } from './partitionPlanning.js'

/** CI reads are idempotent: one retry after a lock or statement timeout, then a typed retryable error. */
async function retryRead<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) {
    if (databaseReadFailure(error) === error) throw error
    return work().catch(retry => { throw databaseReadFailure(retry) })
  }
}

type HostRef = CiRunRecord['computer'] extends infer C ? C extends { hostRef: infer H } ? H : never : never
export interface HostCiComputer {
  key: string; hostRef: HostRef; label: string; priority: number; userSystemd?: CiUserSystemd
}
export interface HostCiEndpoint {
  /** Paired computers that serve host CI now. */
  computers(): Promise<HostCiComputer[]>
  request(computer: HostCiComputer, request: CiHostRequest): Promise<CiHostReply>
}
/** Resolves the commit to test and makes sure GitHub has it, so build computers can fetch it. */
export interface CiCommits {
  infrastructureOnly?(repository: string, commit: string): Promise<boolean>
  branch?(repository: string, defaultBranch: string, commit: string): Promise<string | null>
  isAncestor?(repository: string, ancestor: string, commit: string): Promise<boolean>
  capabilities(repository: string, commit: string): Promise<CiRepositoryCapabilities>
  integrationInventory?(repository: string, commit: string): Promise<CiIntegrationInventory>
  unitInventory?(repository: string, commit: string): Promise<CiUnitInventory>
  resolve(repository: string, defaultBranch: string, commit: string | undefined,
    snapshot: { baseCommit: string; commit: string; bundle: Buffer | null } | null): Promise<string>
}
export type AgentSnapshots = (executionId: string) => Promise<{ baseCommit: string; commit: string; bundle: Buffer | null } | null>

const log = componentLogger('jobs')

interface PreparedCiRuns {
  repository: NonNullable<Workspace['repository']>
  runs: CiRunRecord[]
  durations: CiDurations | null
}

interface RunStopAudit {
  principalId: string
  source: 'http' | 'mcp'
  commandId: string
  runId: string
}

function needsSystemdExecutor(run: CiRunRecord): boolean {
  if (run.requiresBuildComputer !== undefined) return run.requiresBuildComputer
  return run.suite === 'integration' && (run.partition
    ? run.partition.hostIndexes?.includes(run.partition.index) === true
    : run.scope === 'full' || Boolean(run.deriveFiles) || run.files.some(requiresUserSystemd))
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
  private timer: NodeJS.Timeout | undefined
  private stoppingRuns = 0

  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly authority: CiAuthority, private readonly commits: CiCommits,
    private readonly endpoint: HostCiEndpoint, private readonly snapshots?: AgentSnapshots) {}

  start(intervalMs = 5000) {
    this.timer ??= setInterval(() => { void this.dispatch() }, intervalMs)
    this.timer.unref()
  }

  close() { clearInterval(this.timer); this.timer = undefined; return this.dispatching }

  async run(caller: ManagementPrincipal, input: CiRunInput & { workspaceId?: string | undefined }, source: 'mcp' | 'http' = 'mcp') {
    if ((input.gate || input.smokeComputer) && caller.audience !== 'operator') {
      if (source === 'http') await this.commands.recordDenied(caller.id, source, 'ci.run', input.workspaceId ?? 'ci')
      throw new DomainError('ACCESS_DENIED', 'Only an Operator can request a CI gate or target a smoke computer.', 403)
    }
    const actions = input.priority === 'high' && caller.audience !== 'operator'
      ? [...CI_RUN_ACTIONS, 'jobs:prioritize' as const] : CI_RUN_ACTIONS
    const scope = await this.authority.resolve(caller, input.workspaceId, actions).catch(async error => {
      if (source === 'http' && error instanceof DomainError && [401, 403, 404].includes(error.status)) {
        await this.commands.recordDenied(caller.id, source, 'ci.run', input.workspaceId ?? 'ci')
      }
      throw error
    })
    // A start already in flight must settle before admission can supersede its ticket.
    this.stoppingRuns += 1
    try {
      await this.dispatching
      const result = await this.enqueue(caller, input, source, scope, actions)
      await this.cancelSuperseded()
      return result
    } finally {
      this.stoppingRuns -= 1
      this.start()
      void this.dispatch()
    }
  }

  private async enqueue(caller: ManagementPrincipal, input: CiRunInput,
    source: 'mcp' | 'http', scope: Awaited<ReturnType<CiAuthority['resolve']>>, actions: ManagementAction[]) {
    let prepared: PreparedCiRuns | undefined
    let supersession: Map<string, boolean> | undefined
    let superseded: CiRunRecord[] = []
    const outcome = await this.commands.execute({ principal: caller, source, operation: 'ci.run',
      commandId: input.commandId, targetKey: scope.workspaceId, payload: input,
      prepare: async () => {
        prepared ??= await this.prepareRuns(caller, input, scope)
        supersession = input.gate ? undefined
          : await prepareCiSupersession(this.pool, this.commits, prepared.runs[0]!)
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
        const { runs, durations } = prepared!
        const { groupId, commit, priority, priorityReason } = runs[0]!
        const result = CiRunOutputSchema.parse({ ticketId: runs[0]!.id,
          ...(runs.length > 1 ? { partitions: runs.map(run => ({ ticketId: run.id })) } : {}) })
        if (!input.gate) await supersedeCiRuns(client, runs[0]!, superseded, { source, commandId: input.commandId })
        for (const run of runs) {
          await client.query(`insert into ci_runs(id,workspace_id,group_id,state,record,durations)
            values($1,$2,$3,$6,$4::jsonb,$5::jsonb)`, [run.id, run.workspaceId, groupId, serializeCiJson(run),
            durations ? serializeCiJson(durations) : null, run.state])
        }
        await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
          values($1,$2,'ci.priority',$3,'succeeded',$4::jsonb)`, [caller.id, source, scope.workspaceId,
          JSON.stringify({ commandId: input.commandId, groupId, commit, priority, priorityReason,
            requestedPriority: input.priority ?? 'normal',
            ...(input.smokeComputer ? { smokeComputer: input.smokeComputer } : {}) })])
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
      ? (await this.endpoint.computers()).find(computer => isDeepStrictEqual(computer.hostRef, input.smokeComputer))
      : undefined
    if (input.smokeComputer && !smokeTarget) {
      throw new DomainError('CI_SMOKE_COMPUTER_UNAVAILABLE', 'The smoke computer is disabled or unavailable.', 409)
    }
    const repository = `${workspace.repository.owner}/${workspace.repository.name}`
    const defaultBranch = workspace.repository.defaultBranch
    // An Agent's CI tests its current files; they are published to GitHub so build computers can fetch them.
    const snapshot = scope.executionId && !input.commit && this.snapshots ? await this.snapshots(scope.executionId) : null
    const commit = await this.commits.resolve(repository, defaultBranch, input.commit, snapshot)
    const [infrastructure, branch, capabilities] = await Promise.all([
      this.commits.infrastructureOnly?.(repository, commit) ?? false,
      this.commits.branch?.(repository, defaultBranch, commit),
      this.commits.capabilities(repository, commit),
    ])
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
      ['unit', 'integration'].includes(input.suite) ? this.learnedDurations(repository) : null,
      capabilities.integrationPartitions && input.suite === 'integration'
        ? this.commits.integrationInventory?.(repository, commit) : undefined,
    ])
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
    const empty = selectionScope === 'affected' && input.files?.length === 0
    const split = input.suite === 'integration' ? capabilities.integrationPartitions : capabilities.parts
    let parts: { part: CiRunRecord['part']; partition: CiRunRecord['partition']; files: string[];
      expectedDurationMs?: number; suite?: CiRunRecord['suite']; plannedHostKey?: string;
      integrationShards?: number; requiresBuildComputer?: boolean }[] = split ? planCiParts(selection, unitDurations, inventory)
      : [{ part: null, partition: null, files: selection.files ?? [] }]
    let smokeShards: number | undefined
    if (smokeTarget && input.suite === 'integration') {
      const status = await this.endpoint.request(smokeTarget, { operation: 'status' })
      if (status.operation !== 'status' || !status.ready) {
        throw new DomainError('CI_SMOKE_COMPUTER_UNAVAILABLE', 'The smoke computer is not ready.', 409)
      }
      smokeShards = gateIntegrationShards(status.cpuCount, Math.floor(status.memoryBytes * 0.9))
      const fleet = await this.endpoint.computers()
      if (integration && fleet.some(computer => computer.hostRef.kind !== 'cloud')
        && fleet.some(computer => computer.hostRef.kind === 'cloud')) {
        const smokeUnit = await this.commits.unitInventory?.(repository, commit)
        if (smokeUnit) {
          try { await planCiGate(input, integration, smokeUnit, unitDurations, this.endpoint) }
          catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'CI_GATE_CAPACITY_REQUIRED') throw error
            log.info({ reason: error.message }, 'CI smoke has no complete ready gate fleet')
          }
        }
      }
      parts = [{ part: null, partition: null, files: input.files! }]
    } else if (input.gate) {
      parts = await planCiGate(input, { ...integration!, durations: durations! }, inventory!, unitDurations, this.endpoint)
    } else if (integration) {
      parts = planIntegrationParts(selection, { ...integration, durations: durations! }, await this.integrationSlots())
    }
    const runs = parts.map(planned => CiRunRecordSchema.parse({
      ...planned,
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
      exitCode: empty ? 0 : null, message: empty ? 'No affected files for this suite.' : null,
      queuedAt: now, startedAt: empty ? now : null, finishedAt: empty ? now : null,
      initiator: { principalId: caller.id, executionId: scope.executionId ?? null } }))
    return { repository: workspace.repository, runs, durations }
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

  private async integrationSlots(): Promise<CiIntegrationSlots> {
    const active = (await this.pool.query<{ host_key: string; count: number }>(`select host_key,count(*)::int as count
      from ci_runs where state in ('starting','running') and host_key is not null group by host_key`)).rows
    const used = new Map(active.map(row => [row.host_key, row.count]))
    const slots = { host: 0, ordinary: 0 }
    await inBatches(await this.endpoint.computers(), 8, async computer => {
      const status = await this.endpoint.request(computer, { operation: 'status' }).catch(error => {
        log.warn({ err: error, computer: computer.key }, 'CI capacity unavailable while sizing integration')
        return null
      })
      if (status?.operation !== 'status' || !status.ready) return
      const free = Math.max(0, (status.slotsTotal ?? 1) - Math.max(status.slotsUsed ?? 0, used.get(computer.key) ?? 0))
      if (computer.hostRef.kind === 'cloud') slots.ordinary += free
      else slots.host += free
    })
    // Build computers can also take ordinary work after reserving the host-only slices.
    if (!slots.ordinary) slots.ordinary = Math.max(1, slots.host - 1)
    return slots
  }

  /** The repository's learned test file durations, most recently measured first, within the start request's
   * bound. Files no run has measured fall back to the commit's committed durations on the build computer. */
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

  private async queuePosition(id: string): Promise<number | undefined> {
    const rows = (await this.pool.query<{ id: string; position: number }>(`select id,position from
      (select id,row_number() over (order by ${CI_QUEUE_ORDER})::integer as position
        from ci_runs where state='queued') queue where id=$1`, [id])).rows
    return rows[0]?.position
  }

  async get(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; ticketId: string
    testStatus?: CiTestStatus[] | undefined }) {
    return retryRead(async () => {
      const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
      const row = (await this.pool.query<{ record: unknown; log_tail: string }>(
        'select record,log_tail from ci_runs where id=$1 and workspace_id=$2',
        [input.ticketId, scope.workspaceId])).rows[0]
      if (!row) throw new DomainError('CI_RUN_NOT_FOUND', 'No such CI run in this workspace.', 404)
      const run = CiRunRecordSchema.parse(row.record)
      assertCiReadAccess(caller, scope.executionId, run)
      const group = (await this.pool.query<{ record: unknown }>(
        `select record from ci_runs where group_id=$1 and workspace_id=$2
          and record->'initiator'=$3::jsonb order by created_at,id`,
        [run.groupId, scope.workspaceId, JSON.stringify(run.initiator)])).rows.map(row => CiRunRecordSchema.parse(row.record))
      const position = run.state === 'queued' ? await this.queuePosition(run.id) : undefined
      const smokeComputer = (await this.smokeTargets([run])).get(run.groupId)
      return { run: { ...run, ...(smokeComputer ? { smokeComputer } : {}) },
        partitions: group.length > 1 ? group : undefined, logTail: row.log_tail,
        queue: position ? { position, reason: ciQueueReason(run) } : null,
        group: { groupId: run.groupId, state: ciGroupState(group) },
        ...(run.gate ? { gate: ciGateReport(group) } : {}),
        ...(input.testStatus ? { tests: await this.testResults(run.id, scope.workspaceId, input.testStatus) } : {}) }
    })
  }

  /** The ticket's structured test results, limited to the given statuses; null until a finished test run reports them. */
  async tests(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; ticketId: string
    status?: CiTestStatus[] | undefined }) {
    return retryRead(async () => {
      const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
      const run = await this.read(input.ticketId, scope.workspaceId)
      assertCiReadAccess(caller, scope.executionId, run)
      return { ticketId: run.id, tests: await this.testResults(run.id, scope.workspaceId, input.status) }
    })
  }

  private async testResults(id: string, workspaceId: string, statuses?: CiTestStatus[]): Promise<CiTestResults | null> {
    const row = (await this.pool.query<{ test_results: unknown }>(
      'select test_results from ci_runs where id=$1 and workspace_id=$2', [id, workspaceId])).rows[0]
    return storedCiTestResults(row?.test_results, statuses)
  }

  /** Every CI ticket the Run's Agents requested, newest first, with the requesting Agent's node and test counts.
   * Agents read only their own tickets with ci_get; the Run-wide list is for the app and the Operator. */
  async list(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; runId: string }): Promise<CiListOutput> {
    return retryRead(async () => {
      if (caller.audience === 'worker') {
        throw new DomainError('ACCESS_DENIED', 'Agents read their own CI tickets with ci_get.', 403)
      }
      const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
      const run = (await this.pool.query<{ workflow_id: string }>('select workflow_id from runs where id=$1 and workspace_id=$2',
        [input.runId, scope.workspaceId])).rows[0]
      if (!run) throw new DomainError('RUN_NOT_FOUND', 'The Run was not found in this workspace.', 404)
      requireAuthorization(caller, 'runs:read', { workspaceId: scope.workspaceId, workflowId: run.workflow_id, runId: input.runId })
      const rows = (await this.pool.query<RunCiJobRow>(RUN_CI_JOBS_SQL, [scope.workspaceId, input.runId])).rows
      return CiListOutputSchema.parse({ runId: input.runId, jobs: rows.slice(0, CI_RUN_JOBS_LIMIT).map(runCiJob),
        truncated: rows.length > CI_RUN_JOBS_LIMIT })
    })
  }

  /** Reads the run's log from its computer; without afterOffset it returns the last maxBytes. */
  async logs(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; ticketId: string
    afterOffset?: number | undefined; maxBytes?: number | undefined; group?: boolean | undefined }) {
    return retryRead(async () => {
      const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
      const run = await this.read(input.ticketId, scope.workspaceId)
      assertCiReadAccess(caller, scope.executionId, run)
      const maxBytes = Math.min(input.maxBytes ?? CI_LOG_MAX_BYTES, CI_LOG_MAX_BYTES)
      if (input.group) {
        const group = (await this.pool.query<{ record: unknown }>(
          `select record from ci_runs where group_id=$1 and workspace_id=$2
            and record->'initiator'=$3::jsonb order by created_at,id`,
          [run.groupId, scope.workspaceId, JSON.stringify(run.initiator)])).rows.map(row => CiRunRecordSchema.parse(row.record))
        const partMaxBytes = Math.floor(maxBytes / group.length)
        const remainder = maxBytes % group.length
        const parts = await Promise.all(group.map(async (part, index) => ({ run: part,
          ...await this.readLog(part, { afterOffset: input.afterOffset,
            maxBytes: partMaxBytes + Number(index < remainder) }) })))
        const own = parts.find(part => part.run.id === run.id)!
        return { text: own.text, nextOffset: own.nextOffset, logBytes: own.logBytes, maxBytes, parts }
      }
      if (!run.computer) throw new DomainError('CI_NOT_STARTED', 'This CI run is still queued.', 409)
      return this.readLog(run, { afterOffset: input.afterOffset, maxBytes })
    })
  }

  private async readLog(run: CiRunRecord, input: { afterOffset?: number | undefined; maxBytes?: number | undefined }) {
    const maxBytes = input.maxBytes ?? CI_LOG_MAX_BYTES
    if (!run.computer) return { text: '', nextOffset: 0, logBytes: 0, maxBytes }
    const computer = await this.computer(run.computer.hostRef)
    if (maxBytes === 0) {
      const state = await this.endpoint.request(computer, { operation: 'read', runId: run.id, afterOffset: 0, maxBytes: 0 })
      if (state.operation !== 'read') throw new DomainError('CI_HOST_REPLY_INVALID', 'The build computer replied out of order.', 502)
      return { text: '', nextOffset: input.afterOffset ?? state.run.logBytes, logBytes: state.run.logBytes, maxBytes }
    }
    let afterOffset = input.afterOffset
    if (afterOffset === undefined) {
      const state = await this.endpoint.request(computer, { operation: 'read', runId: run.id, afterOffset: 0, maxBytes: 0 })
      afterOffset = state.operation === 'read' ? Math.max(0, state.run.logBytes - maxBytes) : 0
    }
    const reply = await this.endpoint.request(computer, { operation: 'read', runId: run.id, afterOffset, maxBytes })
    if (reply.operation !== 'read') throw new DomainError('CI_HOST_REPLY_INVALID', 'The build computer replied out of order.', 502)
    return { text: sanitizeCiText(reply.text), nextOffset: reply.nextOffset, logBytes: reply.run.logBytes, maxBytes }
  }

  async cancel(caller: ManagementPrincipal,
    input: { workspaceId?: string | undefined; ticketId: string; commandId?: string | undefined },
    source: 'http' | 'mcp' = 'mcp'): Promise<{ run: CiRunRecord }> {
    const scope = await this.authority.resolve(caller, input.workspaceId, ['jobs:cancel'])
    const run = await this.read(input.ticketId, scope.workspaceId)
    assertCiReadAccess(caller, scope.executionId, run)
    this.stoppingRuns += 1
    try {
      await this.dispatching
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
      const results = await Promise.allSettled(tickets.map(ticket =>
        this.cancelTicket(intent.workspace_id, ticket.id, { ...intent.record, reason: 'run_stop' })))
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
    if (run.dispatchRequest) {
      // A start with an unknown reply is retried on its owner before cancellation can confirm closure.
      try {
        const start = await this.endpoint.request(computer, run.dispatchRequest)
        if (start.operation !== 'start') {
          throw new DomainError('CI_HOST_REPLY_INVALID', 'The build computer replied out of order.', 502)
        }
      } catch (error) {
        if (!rejectedCiStart(error)) throw error
        const now = new Date().toISOString()
        await this.settle(run, computer, { state: 'canceled', step: null, exitCode: null,
          startedAt: now, finishedAt: now, message: 'Canceled before execution.' }, { client, audit })
        return
      }
    }
    const reply = await this.endpoint.request(computer, { operation: 'cancel', runId: run.id })
    if (reply.operation !== 'cancel') {
      throw new DomainError('CI_HOST_REPLY_INVALID', 'The build computer replied out of order.', 502)
    }
    await this.settle(run, computer, reply.run, { client, audit })
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
      const active = (await this.pool.query<{ id: string; host_key: string }>(
        `select id,host_key from ci_runs where state in ('starting','running') and host_key is not null
          order by created_at,id`)).rows
      const result = []
      for (const computer of await this.endpoint.computers()) {
        const running = active.filter(run => run.host_key === computer.key).map(run => run.id)
        const status = await this.endpoint.request(computer, { operation: 'status' }).catch(error => error as Error)
        result.push(status instanceof Error
          ? { label: computer.label, hostRef: computer.hostRef, priority: computer.priority,
            ready: false, reasons: [status.message], running, slotsUsed: running.length,
            slotsTotal: Math.max(1, running.length) }
          : status.operation === 'status' ? { label: computer.label, hostRef: computer.hostRef, priority: computer.priority,
            ready: status.ready, reasons: status.reasons, cpuCount: status.cpuCount, memoryBytes: status.memoryBytes,
            availableMemoryBytes: status.availableMemoryBytes,
            ...(status.userSystemd ? { userSystemd: status.userSystemd } : {}),
            slotsUsed: Math.max(running.length, status.slotsUsed ?? 0), slotsTotal: status.slotsTotal ?? 1,
            running } : null)
      }
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
    exitCode: number | null; startedAt: string; finishedAt: string | null; message: string | null
    collection?: CiHostRun['collection']; provenance?: CiHostRun['provenance'] },
    options: { logTail?: string | undefined; audit?: CiCancellation | undefined; client?: pg.PoolClient | undefined } = {}) {
    const { logTail, audit, client } = options
    const requeued = state.state === 'queued' && computer.hostRef.kind === 'cloud'
    const unstartedProviders = new Set(run.unstartedProviders ?? [])
    if (requeued && computer.hostRef.provider) unstartedProviders.add(computer.hostRef.provider)
    const messages = ciMessages(run, state.message === null ? null : sanitizeCiText(state.message))
    const terminal = !['queued', 'starting', 'running'].includes(state.state)
    const next = CiRunRecordSchema.parse({ ...run, state: state.state, step: state.step, exitCode: state.exitCode,
      computer: requeued ? null : { hostRef: computer.hostRef, label: computer.label },
      startedAt: requeued ? null : run.startedAt ?? state.startedAt,
      finishedAt: state.finishedAt, ...messages, dispatchRequest: undefined,
      cancellation: terminal ? undefined : run.cancellation,
      ...(state.collection ? { collection: state.collection } : {}),
      ...(state.provenance ? { provenance: state.provenance } : {}),
      ...(unstartedProviders.size ? { unstartedProviders: [...unstartedProviders] } : {}) })
    const hostKey = ['starting', 'running'].includes(next.state) ? computer.key : null
    const saved = await this.saveCancellation(`update ci_runs set state=$2, host_key=$3, record=$4::jsonb,
        log_tail=coalesce($6,log_tail)
      where id=$1 and (state in ('queued','starting','running') or state=$8 and record->>'collection'='pending')
        and host_key is not distinct from $5
        and record->>'supersededBy' is not distinct from $7
        and record=$9::jsonb
        and (state is distinct from $2 or host_key is distinct from $3
          or record is distinct from $4::jsonb or ($6::text is not null and log_tail is distinct from $6))`,
      [run.id, next.state, hostKey, serializeCiJson(next), ['starting', 'running'].includes(run.state) ? computer.key : null,
        logTail === undefined ? null : sanitizeCiText(logTail), run.supersededBy ?? null, run.state, JSON.stringify(run)],
      next, run.cancellation ?? audit, client)
    if (requeued && saved.rowCount) log.warn({ runId: run.id, provider: computer.hostRef.provider, message: messages.message },
      'CI dispatch created no work; ticket queued for another computer')
    return Boolean(saved.rowCount)
  }

  /** One pass: refresh running runs, then give queued runs to free CI slots in priority order. */
  dispatch(): Promise<void> {
    if (this.stoppingRuns) return this.dispatching ?? Promise.resolve()
    this.dispatching ??= this.dispatchOnce().catch(error => log.warn({ err: error }, 'CI dispatch failed'))
      .finally(() => { this.dispatching = undefined })
    return this.dispatching
  }

  /** Slow-tier parts wait until every other part of their request passed; if any of those did not pass, the slow
   * tier is skipped (canceled with the reason) because its result could not make the request green. */
  private async releaseSlowTier(queued: CiRunRecord[]): Promise<CiRunRecord[]> {
    const deferred = queued.filter(run => run.deferred)
    if (!deferred.length) return queued
    const groups = [...new Set(deferred.map(run => run.groupId))]
    const rows = (await this.pool.query<{ group_id: string; state: string }>(
      `select record->>'groupId' as group_id, state from ci_runs
        where record->>'groupId' = any($1::text[]) and coalesce((record->>'deferred')::boolean, false) = false`,
      [groups])).rows
    const waiting = new Set<string>()
    for (const groupId of groups) {
      const states = rows.filter(row => row.group_id === groupId).map(row => row.state)
      if (states.some(state => ['failed', 'canceled', 'lost'].includes(state))) {
        const now = new Date().toISOString()
        for (const run of deferred.filter(value => value.groupId === groupId)) {
          const skipped = { ...run, state: 'canceled' as const, finishedAt: now,
            message: 'Skipped: slow tests run only after every other test of this request passed, and some did not.' }
          await saveQueuedCiRun(this.pool, run, skipped)
        }
        waiting.add(groupId)
      } else if (states.some(state => state !== 'passed')) waiting.add(groupId)
    }
    return queued.filter(run => !run.deferred || !waiting.has(run.groupId))
  }

  private async queuedRuns() {
    // Check parts must remain visible even behind more than one batch of integration partitions.
    const queuedRows = (await this.pool.query<{ record: unknown; durations: CiDurations | null }>(
      `select record,durations from ci_runs where id in
        (select id from ci_runs where state='queued' and record->>'supersededBy' is null order by ${CI_QUEUE_ORDER} limit 50)
        or id in (select id from ci_runs where state='queued' and record->>'supersededBy' is null
          and record->>'suite'<>'integration'
          order by ${CI_QUEUE_ORDER} limit 50)
        order by ${CI_QUEUE_ORDER}`)).rows
    const parsed = queuedRows.map(row => CiRunRecordSchema.parse(row.record))
    const durations = new Map(queuedRows.map((row, index) => [parsed[index]!.id, row.durations]))
    return { parsed, durations }
  }

  private async gateReservation() {
    const rows = (await this.pool.query<{ record: unknown }>(`select record from ci_runs
      where state in ('queued','starting','running','failed','lost') and record->>'gate'='true'
      order by record->>'queuedAt',group_id,id`)).rows
    const runs = rows.map(row => CiRunRecordSchema.parse(row.record))
    // A gate with a failed or lost part cannot pass, so it no longer holds the barrier or host reservations.
    const doomed = new Set(runs.filter(run => run.state === 'failed' || run.state === 'lost').map(run => run.groupId))
    const live = runs.filter(run => !doomed.has(run.groupId) && ['queued', 'starting', 'running'].includes(run.state))
    const gate = live[0]
    const reservedHosts = new Set(live.filter(run => run.groupId === gate?.groupId && run.suite === 'integration')
      .map(run => run.plannedHostKey))
    return { gate, reservedHosts }
  }

  private async sendDispatch(run: CiRunRecord, computer: HostCiComputer) {
    const outcome = await withCiTicketLock(this.pool, run.id, async client => {
      const current = await this.read(run.id, run.workspaceId, client)
      if (current.cancellation) return 'pending'
      if (!current.dispatchRequest
        || JSON.stringify(current.computer?.hostRef) !== JSON.stringify(computer.hostRef)) return 'settled'
      return this.sendAssignedDispatch(current, computer, client)
    })
    return outcome ?? 'pending'
  }

  private async sendAssignedDispatch(run: CiRunRecord, computer: HostCiComputer, client: pg.PoolClient) {
    if (!run.dispatchRequest) throw new Error('CI dispatch request is missing.')
    let reply: Extract<CiHostReply, { operation: 'start' }>
    try {
      const response = CiHostReplySchema.parse(await this.endpoint.request(computer, run.dispatchRequest))
      if (response.operation !== 'start') {
        throw new DomainError('CI_HOST_REPLY_INVALID', 'The build computer replied out of order.', 502)
      }
      reply = response
    } catch (error) {
      if (!rejectedCiStart(error)) {
        log.warn({ err: error, runId: run.id, computer: computer.key }, 'CI start reply unknown; retrying assigned executor')
        return 'pending'
      }
      if ((error as DomainError).code === 'CI_MIRROR_PRIVATE_DATA') {
        const now = new Date().toISOString()
        await this.settle(run, computer, { state: 'failed', step: null, exitCode: null,
          startedAt: now, finishedAt: now, message: (error as Error).message }, { client })
        return 'settled'
      }
      if (!await releaseCiDispatch(client, run, computer, (error as Error).message)) return 'pending'
      return (error as DomainError).code === 'CI_HOST_BUSY' ? 'busy' : 'rejected'
    }
    // A persistence failure keeps the pre-dispatch assignment for same-executor recovery.
    await this.settle(run, computer, reply.run, { client })
    return 'settled'
  }

  private async refreshRun(row: { record: unknown; host_key: string | null }, computers: HostCiComputer[]) {
    const run = CiRunRecordSchema.parse(row.record)
    const computer = computers.find(value => value.key === row.host_key)
      ?? computers.find(value => run.collection === 'pending' && run.computer
        && value.hostRef.kind === run.computer.hostRef.kind && value.hostRef.mainId === run.computer.hostRef.mainId
        && value.hostRef.deviceId === run.computer.hostRef.deviceId && value.hostRef.provider === run.computer.hostRef.provider
        && value.hostRef.slot === run.computer.hostRef.slot)
      ?? (run.computer && run.computer.hostRef.kind !== 'cloud' ? await this.computer(run.computer.hostRef) : null)
    if (!computer) return
    if (run.cancellation) {
      await this.cancelTicket(run.workspaceId, run.id, run.cancellation)
      return
    }
    if (run.dispatchRequest) {
      await this.sendDispatch(run, computer)
      return
    }
    const reply = await this.endpoint.request(computer, { operation: 'read', runId: run.id, afterOffset: 0, maxBytes: 32_768,
      ...(['integration', 'unit'].includes(run.suite) ? { durations: true } : {}) })
      .catch(fallbackOnError(null, 'jobs', 'read CI run from computer', { runId: run.id }))
    if (reply?.operation !== 'read') return
    let logTail = reply.text
    if (reply.run.logBytes > 32_768) {
      const tail = await this.endpoint.request(computer, { operation: 'read', runId: run.id,
        afterOffset: reply.run.logBytes - 32_768, maxBytes: 32_768 }).catch(error => {
          log.warn({ err: error, runId: run.id }, 'CI log tail not refreshed; retrying')
          return null
        })
      if (tail?.operation !== 'read') return
      logTail = tail.text
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
    await this.settle(run, computer, collected.run, { logTail })
  }

  private async dispatchOnce() {
    await this.cancelSuperseded()
    const computers = await this.endpoint.computers()
    const active = (await this.pool.query<{ id: string; record: unknown; host_key: string | null }>(
      `select id,record,host_key from ci_runs where state in ('starting','running') or record->>'collection'='pending'`)).rows
    // Runs are read concurrently, a few at a time: a cloud read waits on the service's API, and each read also
    // writes, so reading every part at once would exhaust the database pool.
    await inBatches(active, 8, async row => {
      try {
        await this.refreshRun(row, computers)
      } catch (error) {
        log.warn({ err: error, runId: row.id }, 'CI run refresh failed; retrying')
      }
    })
    const busyRows = (await this.pool.query<{ host_key: string; record: unknown }>(
      `select host_key,record from ci_runs where state in ('starting','running')`)).rows
    const used = new Map<string, number>()
    for (const row of busyRows) used.set(row.host_key, (used.get(row.host_key) ?? 0) + 1)
    const { gate, reservedHosts } = await this.gateReservation()
    const { parsed, durations } = await this.queuedRuns()
    const hasQueuedGate = parsed.some(run => run.gate)
    const totals = new Map<string, number>()
    const gateShards = new Map<string, number>()
    await inBatches(computers, 8, async computer => {
      if (computer.hostRef.kind === 'cloud' && !hasQueuedGate) {
        totals.set(computer.key, 1)
        return
      }
      const status = await readCiComputerStatus(this.endpoint, computer)
      totals.set(computer.key, computer.hostRef.kind === 'cloud' ? 1 : status?.slotsTotal ?? 1)
      if (status) {
        used.set(computer.key, Math.max(used.get(computer.key) ?? 0, status.slotsUsed ?? 0))
        if (status.ready) {
          gateShards.set(computer.key, gateIntegrationShards(status.cpuCount, Math.floor(status.memoryBytes * 0.9)))
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
    let queued = await this.releaseSlowTier(parsed)
    // Reserve four GitHub slots while checks wait, including integration already using GitHub.
    const githubIntegrationLimit = Math.max(0, github.length - (queued.some(run => run.suite !== 'integration') ? 4 : 0))
    queued = await weighCiPartitions(this.pool, this.endpoint, queued, computers.flatMap(computer =>
      Array.from({ length: freeSlots(computer) }, () => computer)), (id, workspaceId) => this.read(id, workspaceId))
    queued.sort((left, right) => (left.priority === right.priority
      && !left.gate && !right.gate
      ? Number(needsSystemdExecutor(right)) - Number(needsSystemdExecutor(left)) : 0) || compareCiQueue(left, right))
    const stealsGatePart = gatePartStealer(computers, queued)
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
        if (computer.hostRef.kind !== 'cloud') return 3
        if (run.suite !== 'integration') return Number(isGitHubComputer(computer))
        return isGitHubComputer(computer) ? 1 : 2
      }
      const affectedFiles = run.scope === 'affected' && !run.deriveFiles ? { files: run.files } : {}
      const selection = (run.gate || smokeTarget) && run.suite === 'integration'
        ? { gate: true, integrationShards: run.integrationShards!, files: run.files } : affectedFiles
      const plannedGateReady = run.plannedHostKey && gateShards.has(run.plannedHostKey)
      const order = computers.filter(computer => runsOnCircleCi(run)
        || computer.hostRef.kind !== 'cloud' || computer.hostRef.provider !== 'circleci')
        .filter(computer => !hostRequired || supportsUserSystemd(computer))
        .filter(computer => !smokeTarget || isDeepStrictEqual(computer.hostRef, smokeTarget))
        .filter(computer => !run.gate || gateShards.has(computer.key)
          && (!plannedGateReady || computer.key === run.plannedHostKey || stealsGatePart(run, computer)))
        .filter(computer => run.gate || computer.hostRef.kind === 'cloud' || !reservedHosts.has(computer.key))
        .filter(computer => computer.hostRef.kind !== 'cloud' || !computer.hostRef.provider
          || !run.unstartedProviders?.includes(computer.hostRef.provider))
        .sort((left, right) => Number(right.key === run.plannedHostKey) - Number(left.key === run.plannedHostKey)
          || preferred(right) - preferred(left)
          || right.priority - left.priority)
      for (const computer of order) {
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
        const shards = run.gate && run.suite === 'integration' && computer.key !== run.plannedHostKey
          ? { integrationShards: gateShards.get(computer.key)! } : {}
        const assigned = await claimCiDispatch(this.pool, run, computer, {
          operation: 'start', runId: run.id, workspaceId: run.workspaceId, ciMirror: run.ciMirror ?? null,
          repository: run.repository, commit: run.commit, suite: run.suite,
          ...(run.part ? { part: run.part } : {}),
          ...(run.partition ? { partition: run.partition } : {}),
          scope: run.scope, ...selection, ...shards,
          ...(run.expectedDurationMs !== undefined ? { expectedDurationMs: run.expectedDurationMs } : {}),
          ...(run.defaultBranch ? { defaultBranch: run.defaultBranch } : {}),
          ...(run.baseCommit ? { baseCommit: run.baseCommit } : {}),
          ...(durations.get(run.id) ? { durations: durations.get(run.id)! } : {}),
        })
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
