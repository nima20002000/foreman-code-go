import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { withTransaction } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import { CI_HOST_NAMESPACE, CI_LOG_MAX_BYTES, CI_RUN_JOBS_LIMIT, CiComputerRefSchema, CiHostReplySchema, CiListOutputSchema, CiRunRecordSchema,
  WorkspaceSchema,
  requiresUserSystemd, userSystemdIntegrationFiles,
  type CiDurations, type CiHostRequest, type CiHostReply, type CiListOutput, type CiRunRecord, type CiRunInput,
  type CiTestResults, type CiTestStatus, type CiUserSystemd } from '@foreman-code/contracts'
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
import { supersedeCiRuns } from './supersession.js'
import { gateQueueBlock, planCiGate } from './gate.js'
import { gateIntegrationShards } from './capacity.js'
import { ciGateReport } from './gateReport.js'

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

interface RunStopAudit {
  principalId: string
  source: 'http' | 'mcp'
  commandId: string
  runId: string
}

function isGitHubComputer(computer: HostCiComputer): boolean {
  return computer.hostRef.kind === 'cloud' && computer.hostRef.provider === 'github'
}

function supportsUserSystemd(computer: HostCiComputer): boolean {
  return computer.hostRef.kind !== 'cloud' || computer.userSystemd?.supported === true
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
    const outcome = await this.commands.execute({ principal: caller, source, operation: 'ci.run',
      commandId: input.commandId, targetKey: scope.workspaceId, payload: input,
      resourceLock: `ci-admission:${scope.workspaceId}:${scope.executionId ?? caller.id}`,
      authorize: async () => { await this.authority.resolve(caller, scope.workspaceId, actions) },
      perform: async client => {
        const workspace = WorkspaceSchema.parse((await client.query<{ record: unknown }>(
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
        const infrastructure = await this.commits.infrastructureOnly?.(repository, commit) ?? false
        const priority = input.gate || infrastructure || input.priority === 'high' ? 'high' : 'normal'
        let priorityReason: CiRunRecord['priorityReason'] = 'normal'
        if (input.gate) priorityReason = 'gate'
        else if (infrastructure) priorityReason = 'ci-infrastructure'
        else if (input.priority === 'high') priorityReason = 'requested'
        const branch = await this.commits.branch?.(repository, defaultBranch, commit)
        const groupId = randomUUID(), now = new Date().toISOString()
        const capabilities = await this.commits.capabilities(repository, commit)
        const inventory = capabilities.parts && (input.suite === 'unit' || input.gate)
          ? await this.commits.unitInventory?.(repository, commit) : undefined
        const learned = ['unit', 'integration'].includes(input.suite) ? await this.learnedDurations(repository) : null
        const integration = capabilities.integrationPartitions && input.suite === 'integration'
          ? await this.commits.integrationInventory?.(repository, commit) : undefined
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
          ...(smokeTarget ? { plannedHostKey: smokeTarget.key,
            ...(smokeShards !== undefined ? { integrationShards: smokeShards } : {}) } : {}),
          id: randomUUID(), workspaceId: scope.workspaceId,
          suite: planned.suite ?? input.suite, scope: selectionScope, commit, repository, groupId,
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
        if (!input.gate) await supersedeCiRuns(client, this.commits, runs[0]!, { source, commandId: input.commandId })
        for (const run of runs) {
          await client.query(`insert into ci_runs(id,workspace_id,group_id,state,record,durations)
            values($1,$2,$3,$6,$4::jsonb,$5::jsonb)`, [run.id, run.workspaceId, groupId, JSON.stringify(run),
            durations ? JSON.stringify(durations) : null, run.state])
        }
        await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
          values($1,$2,'ci.priority',$3,'succeeded',$4::jsonb)`, [caller.id, source, scope.workspaceId,
          JSON.stringify({ commandId: input.commandId, groupId, commit, priority, priorityReason,
            requestedPriority: input.priority ?? 'normal',
            ...(smokeTarget ? { smokeComputer: input.smokeComputer } : {}) })])
        return { ticketId: runs[0]!.id, ...(runs.length > 1 ? { partitions: runs.map(run => ({ ticketId: run.id })) } : {}) }
      },
    })
    return outcome.value
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

  /** Sizes a partitioned run's slices by the measured speed of the computers that will run them, so they finish
   * together: each free computer takes one slice, weighted by its throughput; slices without a computer yet get the
   * mean. Throughput is share of the suite per wall second from that computer's last integration slice. */
  private async weighPartitions(queued: CiRunRecord[], free: HostCiComputer[]): Promise<CiRunRecord[]> {
    const groups = new Map<string, CiRunRecord[]>()
    for (const run of queued) {
      if (run.suite === 'integration' && run.partition && !run.partition.weights) groups.set(run.groupId, [...groups.get(run.groupId) ?? [], run])
    }
    if (!groups.size) return queued
    const speed = await this.throughput(free)
    const replaced = new Map<string, CiRunRecord>()
    for (const group of groups.values()) {
      const count = group[0]!.partition!.count
      if (group.length !== count) continue
      const ordered = [...free].sort((left, right) =>
        Number(isGitHubComputer(left)) - Number(isGitHubComputer(right))
        || right.priority - left.priority
        || (speed.get(right.key) ?? 0) - (speed.get(left.key) ?? 0))
      const systemdComputers = ordered.filter(supportsUserSystemd).sort((left, right) =>
        Number(right.hostRef.kind === 'cloud') - Number(left.hostRef.kind === 'cloud'))
      const selection = group[0]!
      const knownFiles = selection.scope === 'affected' && !selection.deriveFiles
      const hostFiles = knownFiles ? selection.files.filter(requiresUserSystemd).length : userSystemdIntegrationFiles.size
      const ordinaryFiles = knownFiles ? selection.files.length - hostFiles : count
      const hostCount = hostFiles ? Math.min(hostFiles, ordinaryFiles ? count - 1 : count,
        Math.max(1, systemdComputers.length, count - ordinaryFiles)) : 0
      const hostIndexes = Array.from({ length: hostCount }, (_, index) => index)
      // Keep systemd files separate so executors without a user manager can take ordinary slices.
      const planned: (HostCiComputer | undefined)[] = [
        ...hostIndexes.map(index => systemdComputers[index]),
        ...ordered.filter(computer => computer.hostRef.kind === 'cloud'
          && !systemdComputers.slice(0, hostCount).includes(computer)),
        ...systemdComputers.slice(hostCount).filter(computer => computer.hostRef.kind !== 'cloud'),
      ]
      const known = ordered.map(computer => speed.get(computer.key)).filter((value): value is number => value !== undefined)
      const mean = known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : 1
      const weights = group.map((_, index) => {
        const computer = planned[index]
        return Number((computer ? speed.get(computer.key) ?? mean : mean).toPrecision(6))
      })
      for (const [index, run] of group.sort((left, right) => left.partition!.index - right.partition!.index).entries()) {
        const next = CiRunRecordSchema.parse({ ...run, partition: { ...run.partition!, weights,
          ...(hostIndexes.length ? { hostIndexes } : {}) },
          plannedHostKey: planned[index]?.key ?? null })
        await this.save(next, null)
        replaced.set(run.id, next)
      }
    }
    return queued.map(run => replaced.get(run.id) ?? run)
  }

  private async throughput(computers: HostCiComputer[]): Promise<Map<string, number>> {
    const rows = (await this.pool.query<{ record: unknown }>(`select record from ci_runs
      where state in ('passed','failed') and record->>'suite'='integration' and record->'partition' is not null
        and record->>'finishedAt' is not null order by created_at desc limit 200`)).rows
      .map(row => CiRunRecordSchema.parse(row.record))
    const speed = new Map<string, number>()
    for (const run of rows) {
      const key = computers.find(value => JSON.stringify(value.hostRef) === JSON.stringify(run.computer?.hostRef))?.key
      if (!key || speed.has(key) || !run.startedAt || !run.finishedAt || run.step !== 'integration' || run.scope === 'affected') continue
      const seconds = (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000
      // Fail-fast runs say nothing about speed.
      if (seconds < 120) continue
      const partition = run.partition!
      if (partition.hostIndexes?.includes(partition.index)) continue
      const weights = partition.weights ?? Array.from({ length: partition.count }, () => 1)
      const ordinaryWeight = weights.reduce((sum, value, index) =>
        sum + (partition.hostIndexes?.includes(index) ? 0 : value), 0)
      const share = weights[partition.index]! / ordinaryWeight
      speed.set(key, share / seconds)
    }
    for (const computer of computers) {
      if (speed.has(computer.key)) continue
      // No measurement yet: CPU count relative to the measured computers' typical speed per CPU.
      const status = await this.endpoint.request(computer, { operation: 'status' })
        .catch(fallbackOnError(null, 'jobs', 'read CI computer status', { computer: computer.key }))
      if (status?.operation === 'status' && speed.size) {
        const perCpu = [...speed.values()].reduce((sum, value) => sum + value, 0) / speed.size / 12
        speed.set(computer.key, perCpu * Math.max(1, Math.floor(status.cpuCount / (status.slotsTotal ?? 1))))
      }
    }
    return speed
  }

  private async read(id: string, workspaceId: string): Promise<CiRunRecord> {
    const row = (await this.pool.query<{ record: unknown }>('select record from ci_runs where id=$1 and workspace_id=$2',
      [id, workspaceId])).rows[0]
    if (!row) throw new DomainError('CI_RUN_NOT_FOUND', 'No such CI run in this workspace.', 404)
    return CiRunRecordSchema.parse(row.record)
  }

  private async save(run: CiRunRecord, hostKey: string | null) {
    await this.pool.query('update ci_runs set state=$2, host_key=$3, record=$4::jsonb where id=$1',
      [run.id, run.state, hostKey, JSON.stringify(run)])
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
        const partMaxBytes = Math.max(1, Math.floor(maxBytes / group.length))
        const parts = await Promise.all(group.map(async part => ({ run: part,
          ...await this.readLog(part, { afterOffset: input.afterOffset, maxBytes: partMaxBytes }) })))
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
    let afterOffset = input.afterOffset
    if (afterOffset === undefined) {
      const state = await this.endpoint.request(computer, { operation: 'read', runId: run.id, afterOffset: 0, maxBytes: 1 })
      afterOffset = state.operation === 'read' ? Math.max(0, state.run.logBytes - maxBytes) : 0
    }
    const reply = await this.endpoint.request(computer, { operation: 'read', runId: run.id, afterOffset, maxBytes })
    if (reply.operation !== 'read') throw new DomainError('CI_HOST_REPLY_INVALID', 'The build computer replied out of order.', 502)
    return { text: reply.text, nextOffset: reply.nextOffset, logBytes: reply.run.logBytes, maxBytes }
  }

  async cancel(caller: ManagementPrincipal,
    input: { workspaceId?: string | undefined; ticketId: string }): Promise<{ run: CiRunRecord }> {
    const scope = await this.authority.resolve(caller, input.workspaceId, ['jobs:cancel'])
    const run = await this.read(input.ticketId, scope.workspaceId)
    assertCiReadAccess(caller, scope.executionId, run)
    return this.cancelTicket(scope.workspaceId, run.id)
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
        this.cancelTicket(intent.workspace_id, ticket.id, intent.record)))
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Run CI cancellation is incomplete.')
    } finally {
      this.stoppingRuns -= 1
    }
  }

  private async cancelTicket(workspaceId: string, ticketId: string,
    audit?: RunStopAudit): Promise<{ run: CiRunRecord }> {
    const run = await this.read(ticketId, workspaceId)
    if (run.state === 'queued') {
      const message = run.supersededBy ? `superseded by ${run.supersededBy}` : 'Canceled.'
      const canceled = { ...run, state: 'canceled' as const, finishedAt: new Date().toISOString(), message }
      const saved = await this.saveCancellation(`update ci_runs set state='canceled', host_key=null, record=$2::jsonb
        where id=$1 and state='queued' and record->>'supersededBy' is not distinct from $3`,
      [run.id, JSON.stringify(canceled), run.supersededBy ?? null], canceled, audit)
      if (!saved.rowCount) return this.cancelTicket(workspaceId, ticketId, audit)
      return { run: canceled }
    }
    if (run.computer && ['starting', 'running'].includes(run.state)) {
      const computer = await this.computer(run.computer.hostRef)
      const reply = await this.endpoint.request(computer, { operation: 'cancel', runId: run.id })
      if (reply.operation !== 'cancel') {
        throw new DomainError('CI_HOST_REPLY_INVALID', 'The build computer replied out of order.', 502)
      }
      await this.settle(run, computer, reply.run, undefined, audit)
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

  private async saveCancellation(sql: string, parameters: unknown[], run: CiRunRecord, audit?: RunStopAudit) {
    if (!audit || run.state !== 'canceled') return this.pool.query(sql, parameters)
    return withTransaction(this.pool, async (client) => {
      const saved = await client.query(sql, parameters)
      if (saved.rowCount) {
        await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
          values($1,$2,'ci.cancel',$3,'succeeded',$4::jsonb)`,
        [audit.principalId, audit.source, `ci:${run.id}`, JSON.stringify({
          commandId: audit.commandId, runId: audit.runId, ticketId: run.id,
          executionId: run.initiator.executionId, reason: 'run_stop',
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
    throw new DomainError('CI_COMPUTER_OFFLINE', 'The build computer running this CI run is offline.', 409)
  }

  private async settle(run: CiRunRecord, computer: HostCiComputer, state: { state: string; step: string | null
    exitCode: number | null; startedAt: string; finishedAt: string | null; message: string | null },
    logTail?: string, audit?: RunStopAudit) {
    const requeued = state.state === 'queued' && computer.hostRef.kind === 'cloud'
    const unstartedProviders = new Set(run.unstartedProviders ?? [])
    if (requeued && computer.hostRef.provider) unstartedProviders.add(computer.hostRef.provider)
    const previousMessage = run.state === 'queued' && state.state !== 'queued' ? null : run.message
    const message = run.supersededBy ? `superseded by ${run.supersededBy}`
      : [...new Set([previousMessage, state.message].filter(Boolean))].join(' ') || null
    const next = CiRunRecordSchema.parse({ ...run, state: state.state, step: state.step, exitCode: state.exitCode,
      computer: requeued ? null : { hostRef: computer.hostRef, label: computer.label },
      startedAt: requeued ? null : run.startedAt ?? state.startedAt,
      finishedAt: state.finishedAt, message,
      ...(unstartedProviders.size ? { unstartedProviders: [...unstartedProviders] } : {}) })
    const hostKey = ['starting', 'running'].includes(next.state) ? computer.key : null
    const saved = await this.saveCancellation(`update ci_runs set state=$2, host_key=$3, record=$4::jsonb,
        log_tail=coalesce($6,log_tail)
      where id=$1 and state in ('queued','starting','running') and host_key is not distinct from $5
        and record->>'supersededBy' is not distinct from $7
        and ($6::text is null or state is distinct from $2 or host_key is distinct from $3
          or record is distinct from $4::jsonb or log_tail is distinct from $6)`,
      [run.id, next.state, hostKey, JSON.stringify(next), run.state === 'queued' ? null : computer.key,
        logTail ?? null, run.supersededBy ?? null],
      next, audit)
    if (requeued && saved.rowCount) log.warn({ runId: run.id, provider: computer.hostRef.provider, message },
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
          await this.save(skipped, null)
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
      where state in ('queued','starting','running') and record->>'gate'='true'
      order by record->>'queuedAt',group_id,id`)).rows
    const runs = rows.map(row => CiRunRecordSchema.parse(row.record))
    const gate = runs[0]
    const reservedHosts = new Set(runs.filter(run => run.groupId === gate?.groupId && run.suite === 'integration')
      .map(run => run.plannedHostKey))
    return { gate, reservedHosts }
  }

  private async dispatchOnce() {
    await this.cancelSuperseded()
    const computers = await this.endpoint.computers()
    const active = (await this.pool.query<{ record: unknown; host_key: string }>(
      `select record,host_key from ci_runs where state in ('starting','running')`)).rows
    // Runs are read concurrently, a few at a time: a cloud read waits on the service's API, and each read also
    // writes, so reading every part at once would exhaust the database pool.
    await inBatches(active, 8, async row => {
      const run = CiRunRecordSchema.parse(row.record)
      const computer = computers.find(value => value.key === row.host_key)
        ?? (run.computer && run.computer.hostRef.kind !== 'cloud' ? await this.computer(run.computer.hostRef) : null)
      if (!computer) return
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
      // Test results are asked for apart from the read above: a Worker from before them rejects the flag, and its
      // run must still settle. They land before the finished state, so a reader that sees the outcome also sees its
      // tests; if they cannot be saved, the run stays active and the next pass tries again.
      if (['integration', 'unit'].includes(run.suite) && !['starting', 'running'].includes(reply.run.state)) {
        const results = await this.endpoint.request(computer, { operation: 'read', runId: run.id, afterOffset: 0, maxBytes: 1,
          testResults: true })
          .catch(fallbackOnError(null, 'jobs', 'read CI test results from computer', { runId: run.id }))
        if (results?.operation === 'read' && results.testResults) {
          const saved = await this.pool.query('update ci_runs set test_results=$2::jsonb where id=$1',
            [run.id, JSON.stringify(results.testResults)]).then(() => true,
            (error: unknown) => { log.warn({ err: error, runId: run.id }, 'CI test results not recorded; retrying'); return false })
          if (!saved) return
        }
      }
      await this.settle(run, computer, reply.run, logTail)
      // A run is read here until it finishes, so its measured durations are learned once.
      if (reply.durations && !['starting', 'running'].includes(reply.run.state)) {
        await this.learnDurations(run.repository, reply.durations)
          .catch(error => log.warn({ err: error, runId: run.id }, 'CI durations not recorded'))
      }
    })
    const busyRows = (await this.pool.query<{ host_key: string; record: unknown }>(
      `select host_key,record from ci_runs where state in ('starting','running')`)).rows
    const used = new Map<string, number>()
    for (const row of busyRows) used.set(row.host_key, (used.get(row.host_key) ?? 0) + 1)
    const { gate, reservedHosts } = await this.gateReservation()
    const totals = new Map<string, number>()
    await inBatches(computers, 8, async computer => {
      if (computer.hostRef.kind === 'cloud') {
        totals.set(computer.key, 1)
        return
      }
      const status = await this.endpoint.request(computer, { operation: 'status' }).catch(() => null)
      totals.set(computer.key, status?.operation === 'status' ? status.slotsTotal ?? 1 : 1)
      if (status?.operation === 'status') {
        used.set(computer.key, Math.max(used.get(computer.key) ?? 0, status.slotsUsed ?? 0))
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
    const { parsed, durations } = await this.queuedRuns()
    const smokeTargets = await this.smokeTargets(parsed)
    let queued = await this.releaseSlowTier(parsed)
    // Reserve four GitHub slots while checks wait, including integration already using GitHub.
    const githubIntegrationLimit = Math.max(0, github.length - (queued.some(run => run.suite !== 'integration') ? 4 : 0))
    queued = await this.weighPartitions(queued, computers.flatMap(computer =>
      Array.from({ length: freeSlots(computer) }, () => computer)))
    queued.sort((left, right) => (left.priority === right.priority
      && !left.gate && !right.gate
      ? Number(needsSystemdExecutor(right)) - Number(needsSystemdExecutor(left)) : 0) || compareCiQueue(left, right))
    // Reserve slots before awaiting a start so concurrent dispatches cannot spend the same capacity.
    await Promise.all(queued.map(async run => {
      const smokeTarget = smokeTargets.get(run.groupId)
      const blocked = gateQueueBlock(run, gate)
      if (blocked) {
        if (run.message !== blocked) await this.save({ ...run, message: blocked }, null)
        return
      }
      if (run.suite === 'integration' && run.partition && !run.partition.weights) return
      const hostRequired = needsSystemdExecutor(run)
      const integrationLimit = run.priority === 'high'
        && !queued.some(check => check.suite !== 'integration' && compareCiQueue(check, run) < 0)
        ? github.length : githubIntegrationLimit
      const reasons = (run.unstartedProviders ?? []).map(provider => `${provider}: dispatch retries exhausted`)
      const preferred = (computer: HostCiComputer) => {
        if (run.suite !== 'integration') return Number(isGitHubComputer(computer))
        if (computer.hostRef.kind !== 'cloud') return 0
        return isGitHubComputer(computer) ? 1 : 2
      }
      const affectedFiles = run.scope === 'affected' && !run.deriveFiles ? { files: run.files } : {}
      const selection = (run.gate || smokeTarget) && run.suite === 'integration'
        ? { gate: true, integrationShards: run.integrationShards!, files: run.files } : affectedFiles
      const order = computers.filter(computer => runsOnCircleCi(run)
        || computer.hostRef.kind !== 'cloud' || computer.hostRef.provider !== 'circleci')
        .filter(computer => !hostRequired || supportsUserSystemd(computer))
        .filter(computer => !smokeTarget || isDeepStrictEqual(computer.hostRef, smokeTarget))
        .filter(computer => !run.gate || computer.key === run.plannedHostKey)
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
        try {
          const reply = CiHostReplySchema.parse(await this.endpoint.request(computer, { operation: 'start', runId: run.id,
            repository: run.repository, commit: run.commit, suite: run.suite, ...(run.part ? { part: run.part } : {}), ...(run.partition ? { partition: run.partition } : {}),
            scope: run.scope, ...selection,
            ...(run.defaultBranch ? { defaultBranch: run.defaultBranch } : {}),
            ...(run.baseCommit ? { baseCommit: run.baseCommit } : {}),
            ...(durations.get(run.id) ? { durations: durations.get(run.id)! } : {}) }))
          if (reply.operation !== 'start') {
            releaseSlot(computer)
            if (usesGitHubIntegration) integrationOnGitHub.delete(computer.key)
            reasons.push(`${computer.label}: no start reply`)
            continue
          }
          const saved = await this.settle(run, computer, reply.run)
          if (!saved) {
            if (['starting', 'running'].includes(reply.run.state)) {
              await this.endpoint.request(computer, { operation: 'cancel', runId: run.id })
                .catch(error => log.warn({ err: error, runId: run.id }, 'CI canceled during dispatch; remote stop failed'))
            }
            return
          }
          if (reply.run.state === 'queued') {
            releaseSlot(computer)
            if (usesGitHubIntegration) integrationOnGitHub.delete(computer.key)
            run = await this.read(run.id, run.workspaceId)
            if (run.state !== 'queued') return
            reasons.push(`${computer.label}: ${reply.run.message ?? 'dispatch created no work'}`)
            continue
          }
          if (!['starting', 'running'].includes(reply.run.state)) {
            releaseSlot(computer)
            if (usesGitHubIntegration) integrationOnGitHub.delete(computer.key)
          }
          return
        } catch (error) {
          // A busy or unready computer is skipped; the run stays queued for the next free one.
          const code = (error as { code?: unknown } | null)?.code
          reasons.push(`${computer.label}: ${(error as Error).message}`)
          if (code === 'CI_HOST_BUSY') {
            used.set(computer.key, totals.get(computer.key) ?? 1)
          } else {
            releaseSlot(computer)
            if (usesGitHubIntegration) integrationOnGitHub.delete(computer.key)
          }
          if (code === 'CI_HOST_BUSY' || code === 'COMPUTER_GITHUB_REQUIRED' || code === 'CI_CLOUD_UNAVAILABLE'
            || code === 'BUILD_COMPUTER_DISABLED') continue
          // The commit itself names private machines; no retry can publish it, so the caller learns why at once.
          if (code === 'CI_MIRROR_PRIVATE_DATA') {
            const now = new Date().toISOString()
            await this.settle(run, computer, { state: 'failed', step: null, exitCode: null, startedAt: now, finishedAt: now,
              message: (error as Error).message })
            return
          }
          log.warn({ err: error, runId: run.id, computer: computer.key }, 'CI start failed')
        }
      }
      const systemdCloud = computers.some(computer => computer.hostRef.kind === 'cloud' && supportsUserSystemd(computer))
      let prefix = `No ready computer for ${run.part ?? run.suite}`
      if (hostRequired) {
        prefix = systemdCloud ? 'Waiting for a systemd-capable executor'
          : 'Waiting for a build computer: this integration slice needs one'
      }
      const message = `${prefix}; ${reasons.join('; ') || 'no eligible computers'}`.slice(0, 2000)
      if (message !== run.message) {
        await this.pool.query(`update ci_runs set record=$4::jsonb
          where id=$1 and state=$2 and host_key is not distinct from $3
            and record->>'message' is distinct from $5`,
        [run.id, 'queued', null, JSON.stringify({ ...run, message }), message])
      }
    }))
  }
}

export { CI_HOST_NAMESPACE }
