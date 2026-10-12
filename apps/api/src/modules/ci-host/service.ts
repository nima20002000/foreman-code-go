import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CI_HOST_NAMESPACE, CI_RUN_JOBS_LIMIT, CiHostReplySchema, CiListOutputSchema, CiRunRecordSchema, WorkspaceSchema,
  type CiDurations, type CiHostRequest, type CiHostReply, type CiListOutput, type CiRunRecord, type CiRunInput,
  type CiTestResults, type CiTestStatus } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../jobs/ciAuthority.js'
import { DomainError } from '../errors.js'
import { requireAuthorization } from '../access/policy.js'
import { componentLogger } from '../diagnostics/logger.js'
import { ciGroupState, planCiParts, type CiUnitInventory } from './parts.js'
import { assertCiReadAccess } from './runAccess.js'
import type { CiRepositoryCapabilities } from './repository.js'
import { RUN_CI_JOBS_SQL, runCiJob, storedCiTestResults, type RunCiJobRow } from './runJobs.js'

type HostRef = CiRunRecord['computer'] extends infer C ? C extends { hostRef: infer H } ? H : never : never
export interface HostCiComputer { key: string; hostRef: HostRef; label: string; priority: number }
export interface HostCiEndpoint {
  /** Paired computers that serve host CI now. */
  computers(): Promise<HostCiComputer[]>
  request(computer: HostCiComputer, request: CiHostRequest): Promise<CiHostReply>
}
/** Resolves the commit to test and makes sure GitHub has it, so build computers can fetch it. */
export interface CiCommits {
  capabilities(repository: string, commit: string): Promise<CiRepositoryCapabilities>
  unitInventory?(repository: string, commit: string): Promise<CiUnitInventory>
  resolve(repository: string, defaultBranch: string, commit: string | undefined,
    snapshot: { baseCommit: string; commit: string; bundle: Buffer | null } | null): Promise<string>
}
export type AgentSnapshots = (executionId: string) => Promise<{ baseCommit: string; commit: string; bundle: Buffer | null } | null>

const log = componentLogger('jobs')

function isGitHubComputer(computer: HostCiComputer): boolean {
  return computer.hostRef.kind === 'cloud' && computer.hostRef.provider === 'github'
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

  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly authority: CiAuthority, private readonly commits: CiCommits,
    private readonly endpoint: HostCiEndpoint, private readonly snapshots?: AgentSnapshots) {}

  start(intervalMs = 5000) {
    this.timer ??= setInterval(() => { void this.dispatch() }, intervalMs)
    this.timer.unref()
  }

  close() { clearInterval(this.timer); this.timer = undefined; return this.dispatching }

  async run(caller: ManagementPrincipal, input: CiRunInput & { workspaceId?: string | undefined }, source: 'mcp' | 'http' = 'mcp') {
    const scope = await this.authority.resolve(caller, input.workspaceId, CI_RUN_ACTIONS).catch(async error => {
      if (source === 'http' && error instanceof DomainError && [401, 403, 404].includes(error.status)) {
        await this.commands.recordDenied(caller.id, source, 'ci.run', input.workspaceId ?? 'ci')
      }
      throw error
    })
    const outcome = await this.commands.execute({ principal: caller, source, operation: 'ci.run',
      commandId: input.commandId, targetKey: scope.workspaceId, payload: input,
      authorize: async () => { await this.authority.resolve(caller, scope.workspaceId, CI_RUN_ACTIONS) },
      perform: async client => {
        const workspace = WorkspaceSchema.parse((await client.query<{ record: unknown }>(
          'select record from workspaces where id=$1', [scope.workspaceId])).rows[0]?.record)
        if (!workspace.repository) throw new DomainError('SOURCE_REPOSITORY_REQUIRED',
          'CI runs on build computers from GitHub. Set the workspace GitHub repository (workspace_update).', 409)
        const repository = `${workspace.repository.owner}/${workspace.repository.name}`
        const defaultBranch = workspace.repository.defaultBranch
        // An Agent's CI tests its current files; they are published to GitHub so build computers can fetch them.
        const snapshot = scope.executionId && !input.commit && this.snapshots ? await this.snapshots(scope.executionId) : null
        const commit = await this.commits.resolve(repository, defaultBranch, input.commit, snapshot)
        const groupId = randomUUID(), now = new Date().toISOString()
        const capabilities = await this.commits.capabilities(repository, commit)
        const inventory = capabilities.parts && input.suite === 'unit'
          ? await this.commits.unitInventory?.(repository, commit) : undefined
        const learned = ['unit', 'integration'].includes(input.suite) ? await this.learnedDurations(repository) : null
        const durations = input.suite === 'integration' ? learned : null
        const unitDurations = { ...inventory?.durations, ...learned }
        const supportsSelection = input.suite === 'integration' ? capabilities.integrationPartitions : capabilities.affected
        const selectionScope = supportsSelection ? input.scope ?? 'affected' : 'full'
        const deriveFiles = selectionScope === 'affected' && input.files === undefined
        const selection = { ...input, scope: selectionScope, files: selectionScope === 'affected' ? input.files : [] }
        const empty = selectionScope === 'affected' && input.files?.length === 0
        const split = input.suite === 'integration' ? capabilities.integrationPartitions : capabilities.parts
        const parts = split ? planCiParts(selection, unitDurations, inventory)
          : [{ part: null, partition: null, files: selection.files ?? [] }]
        const runs = parts.map(({ part, partition, files }) => CiRunRecordSchema.parse({
          id: randomUUID(), workspaceId: scope.workspaceId,
          suite: input.suite, part, scope: selectionScope, files, commit, repository, partition, groupId,
          ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
          ...(deriveFiles ? { deriveFiles, defaultBranch } : {}),
          state: empty ? 'passed' : 'queued', computer: null, step: empty ? input.suite : null,
          exitCode: empty ? 0 : null, message: empty ? 'No affected files for this suite.' : null,
          queuedAt: now, startedAt: empty ? now : null, finishedAt: empty ? now : null,
          initiator: { principalId: caller.id, executionId: scope.executionId ?? null } }))
        for (const run of runs) {
          await client.query(`insert into ci_runs(id,workspace_id,group_id,state,record,durations)
            values($1,$2,$3,$6,$4::jsonb,$5::jsonb)`, [run.id, run.workspaceId, groupId, JSON.stringify(run),
            durations ? JSON.stringify(durations) : null, run.state])
        }
        return { ticketId: runs[0]!.id, ...(runs.length > 1 ? { partitions: runs.map(run => ({ ticketId: run.id })) } : {}) }
      },
    })
    this.start()
    void this.dispatch()
    return outcome.value
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
      const ordered = [...free].sort((left, right) => Number(isGitHubComputer(left)) - Number(isGitHubComputer(right))
        || right.priority - left.priority
        || (speed.get(right.key) ?? 0) - (speed.get(left.key) ?? 0)).slice(0, count)
      const known = ordered.map(computer => speed.get(computer.key)).filter((value): value is number => value !== undefined)
      const mean = known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : 1
      const weights = group.map((_, index) => {
        const computer = ordered[index]
        return Number((computer ? speed.get(computer.key) ?? mean : mean).toPrecision(6))
      })
      for (const [index, run] of group.sort((left, right) => left.partition!.index - right.partition!.index).entries()) {
        const next = CiRunRecordSchema.parse({ ...run, partition: { ...run.partition!, weights },
          plannedHostKey: ordered[index]?.key ?? null })
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
      const weights = run.partition!.weights
      const share = weights ? weights[run.partition!.index]! / weights.reduce((sum, value) => sum + value, 0) : 1 / run.partition!.count
      speed.set(key, share / seconds)
    }
    for (const computer of computers) {
      if (speed.has(computer.key)) continue
      // No measurement yet: CPU count relative to the measured computers' typical speed per CPU.
      const status = await this.endpoint.request(computer, { operation: 'status' }).catch(() => null)
      if (status?.operation === 'status' && speed.size) {
        const perCpu = [...speed.values()].reduce((sum, value) => sum + value, 0) / speed.size / 12
        speed.set(computer.key, perCpu * status.cpuCount)
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

  async get(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; ticketId: string
    testStatus?: CiTestStatus[] | undefined }) {
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
    return { run, partitions: group.length > 1 ? group : undefined, logTail: row.log_tail,
      group: { groupId: run.groupId, state: ciGroupState(group) },
      ...(input.testStatus ? { tests: await this.testResults(run.id, scope.workspaceId, input.testStatus) } : {}) }
  }

  /** The ticket's structured test results, limited to the given statuses; null until a finished test run reports them. */
  async tests(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; ticketId: string
    status?: CiTestStatus[] | undefined }) {
    const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
    const run = await this.read(input.ticketId, scope.workspaceId)
    assertCiReadAccess(caller, scope.executionId, run)
    return { ticketId: run.id, tests: await this.testResults(run.id, scope.workspaceId, input.status) }
  }

  private async testResults(id: string, workspaceId: string, statuses?: CiTestStatus[]): Promise<CiTestResults | null> {
    const row = (await this.pool.query<{ test_results: unknown }>(
      'select test_results from ci_runs where id=$1 and workspace_id=$2', [id, workspaceId])).rows[0]
    return storedCiTestResults(row?.test_results, statuses)
  }

  /** Every CI ticket the Run's Agents requested, newest first, with the requesting Agent's node and test counts.
   * Agents read only their own tickets with ci_get; the Run-wide list is for the app and the Operator. */
  async list(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; runId: string }): Promise<CiListOutput> {
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
  }

  /** Reads the run's log from its computer; without afterOffset it returns the last maxBytes. */
  async logs(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; ticketId: string
    afterOffset?: number | undefined; maxBytes?: number | undefined; group?: boolean | undefined }) {
    const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
    const run = await this.read(input.ticketId, scope.workspaceId)
    assertCiReadAccess(caller, scope.executionId, run)
    if (input.group) {
      const group = (await this.pool.query<{ record: unknown }>(
        `select record from ci_runs where group_id=$1 and workspace_id=$2
          and record->'initiator'=$3::jsonb order by created_at,id`,
        [run.groupId, scope.workspaceId, JSON.stringify(run.initiator)])).rows.map(row => CiRunRecordSchema.parse(row.record))
      const maxBytes = Math.max(1, Math.floor((input.maxBytes ?? 65_536) / group.length))
      const parts = await Promise.all(group.map(async part => ({ run: part,
        ...await this.readLog(part, { afterOffset: input.afterOffset, maxBytes }) })))
      const own = parts.find(part => part.run.id === run.id)!
      return { text: own.text, nextOffset: own.nextOffset, logBytes: own.logBytes, parts }
    }
    if (!run.computer) throw new DomainError('CI_NOT_STARTED', 'This CI run is still queued.', 409)
    return this.readLog(run, input)
  }

  private async readLog(run: CiRunRecord, input: { afterOffset?: number | undefined; maxBytes?: number | undefined }) {
    if (!run.computer) return { text: '', nextOffset: 0, logBytes: 0 }
    const computer = await this.computer(run.computer.hostRef)
    const maxBytes = input.maxBytes ?? 65_536
    let afterOffset = input.afterOffset
    if (afterOffset === undefined) {
      const state = await this.endpoint.request(computer, { operation: 'read', runId: run.id, afterOffset: 0, maxBytes: 1 })
      afterOffset = state.operation === 'read' ? Math.max(0, state.run.logBytes - maxBytes) : 0
    }
    const reply = await this.endpoint.request(computer, { operation: 'read', runId: run.id, afterOffset, maxBytes })
    if (reply.operation !== 'read') throw new DomainError('CI_HOST_REPLY_INVALID', 'The build computer replied out of order.', 502)
    return { text: reply.text, nextOffset: reply.nextOffset, logBytes: reply.run.logBytes }
  }

  async cancel(caller: ManagementPrincipal,
    input: { workspaceId?: string | undefined; ticketId: string }): Promise<{ run: CiRunRecord }> {
    const scope = await this.authority.resolve(caller, input.workspaceId, ['jobs:cancel'])
    const run = await this.read(input.ticketId, scope.workspaceId)
    assertCiReadAccess(caller, scope.executionId, run)
    if (run.state === 'queued') {
      const canceled = { ...run, state: 'canceled' as const, finishedAt: new Date().toISOString(), message: 'Canceled.' }
      const saved = await this.pool.query(`update ci_runs set state='canceled', host_key=null, record=$2::jsonb
        where id=$1 and state='queued'`, [run.id, JSON.stringify(canceled)])
      if (!saved.rowCount) return this.cancel(caller, input)
      return { run: canceled }
    }
    if (run.computer && ['starting', 'running'].includes(run.state)) {
      const computer = await this.computer(run.computer.hostRef)
      const reply = await this.endpoint.request(computer, { operation: 'cancel', runId: run.id })
      if (reply.operation === 'cancel') await this.settle(run, computer, reply.run)
    }
    const current = await this.read(run.id, scope.workspaceId)
    const reassigned = ['starting', 'running'].includes(current.state)
      && JSON.stringify(current.computer) !== JSON.stringify(run.computer)
    if (current.state === 'queued' || reassigned) return this.cancel(caller, input)
    return { run: current }
  }

  async computers(caller: ManagementPrincipal, input: { workspaceId?: string | undefined }) {
    await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
    const result = []
    for (const computer of await this.endpoint.computers()) {
      const status = await this.endpoint.request(computer, { operation: 'status' }).catch(error => error as Error)
      result.push(status instanceof Error
        ? { label: computer.label, hostRef: computer.hostRef, priority: computer.priority, ready: false, reasons: [status.message] }
        : status.operation === 'status' ? { label: computer.label, hostRef: computer.hostRef, priority: computer.priority,
          ready: status.ready, reasons: status.reasons, cpuCount: status.cpuCount, memoryBytes: status.memoryBytes,
          running: status.runs.filter(run => ['starting', 'running'].includes(run.state)).map(run => run.runId) } : null)
    }
    return { computers: result.filter(Boolean) }
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
    exitCode: number | null; startedAt: string; finishedAt: string | null; message: string | null }, logTail?: string) {
    const requeued = state.state === 'queued' && computer.hostRef.kind === 'cloud'
    const unstartedProviders = new Set(run.unstartedProviders ?? [])
    if (requeued && computer.hostRef.provider) unstartedProviders.add(computer.hostRef.provider)
    const message = [...new Set([run.message, state.message].filter(Boolean))].join(' ') || null
    const next = CiRunRecordSchema.parse({ ...run, state: state.state, step: state.step, exitCode: state.exitCode,
      computer: requeued ? null : { hostRef: computer.hostRef, label: computer.label },
      startedAt: requeued ? null : run.startedAt ?? state.startedAt,
      finishedAt: state.finishedAt, message,
      ...(unstartedProviders.size ? { unstartedProviders: [...unstartedProviders] } : {}) })
    const hostKey = ['starting', 'running'].includes(next.state) ? computer.key : null
    const saved = await this.pool.query(`update ci_runs set state=$2, host_key=$3, record=$4::jsonb,
        log_tail=coalesce($6,log_tail)
      where id=$1 and state in ('queued','starting','running') and host_key is not distinct from $5`,
      [run.id, next.state, hostKey, JSON.stringify(next), run.state === 'queued' ? null : computer.key, logTail ?? null])
    if (requeued && saved.rowCount) log.warn({ runId: run.id, provider: computer.hostRef.provider, message },
      'CI dispatch created no work; ticket queued for another computer')
    return Boolean(saved.rowCount)
  }

  /** One pass: refresh running runs, then give queued runs to idle computers in priority order. */
  dispatch(): Promise<void> {
    this.dispatching ??= this.dispatchOnce().catch(error => log.warn({ err: error }, 'CI dispatch failed'))
      .finally(() => { this.dispatching = undefined })
    return this.dispatching
  }

  private async dispatchOnce() {
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
        ...(['integration', 'unit'].includes(run.suite) ? { durations: true } : {}) }).catch(() => null)
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
          testResults: true }).catch(() => null)
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
    const busy = new Set(busyRows.map(row => row.host_key))
    const github = computers.filter(isGitHubComputer)
    const githubKeys = new Set(github.map(computer => computer.key))
    const integrationOnGitHub = new Set(busyRows.filter(row => githubKeys.has(row.host_key)
      && CiRunRecordSchema.parse(row.record).suite === 'integration').map(row => row.host_key))
    // Check parts must remain visible even behind more than one batch of integration partitions.
    const queuedRows = (await this.pool.query<{ record: unknown; durations: CiDurations | null }>(
      `select record,durations from ci_runs where id in
        (select id from ci_runs where state='queued' order by created_at,id limit 50)
        or id in (select id from ci_runs where state='queued' and record->>'suite'<>'integration'
          order by created_at,id limit 50)
        order by created_at,id`)).rows
    let queued = queuedRows.map(row => CiRunRecordSchema.parse(row.record))
    // Reserve four GitHub slots while checks wait, including integration already using GitHub.
    const githubIntegrationLimit = Math.max(0, github.length - (queued.some(run => run.suite !== 'integration') ? 4 : 0))
    const durations = new Map(queuedRows.map((row, index) => [queued[index]!.id, row.durations]))
    queued = await this.weighPartitions(queued, computers.filter(computer => !busy.has(computer.key)))
    // Runs start at once, in queue order: each claims its computer before waiting, so none is given twice.
    await Promise.all(queued.map(async run => {
      const preferred = (computer: HostCiComputer) => Number(run.suite === 'integration'
        ? !isGitHubComputer(computer) : isGitHubComputer(computer))
      const order = computers.filter(computer => run.suite === 'integration'
        || computer.hostRef.kind !== 'cloud' || computer.hostRef.provider !== 'circleci')
        .filter(computer => computer.hostRef.kind !== 'cloud' || !computer.hostRef.provider
          || !run.unstartedProviders?.includes(computer.hostRef.provider))
        .sort((left, right) => preferred(right) - preferred(left)
          || Number(right.key === run.plannedHostKey) - Number(left.key === run.plannedHostKey)
          || right.priority - left.priority)
      for (const computer of order) {
        if (computer.hostRef.kind === 'cloud' && computer.hostRef.provider
          && run.unstartedProviders?.includes(computer.hostRef.provider)) continue
        if (busy.has(computer.key)) continue
        const usesGitHubIntegration = run.suite === 'integration' && isGitHubComputer(computer)
        if (usesGitHubIntegration && integrationOnGitHub.size >= githubIntegrationLimit) continue
        busy.add(computer.key)
        if (usesGitHubIntegration) integrationOnGitHub.add(computer.key)
        try {
          const reply = CiHostReplySchema.parse(await this.endpoint.request(computer, { operation: 'start', runId: run.id,
            repository: run.repository, commit: run.commit, suite: run.suite, ...(run.part ? { part: run.part } : {}), ...(run.partition ? { partition: run.partition } : {}),
            scope: run.scope, ...(run.scope === 'affected' && !run.deriveFiles ? { files: run.files } : {}),
            ...(run.defaultBranch ? { defaultBranch: run.defaultBranch } : {}),
            ...(run.baseCommit ? { baseCommit: run.baseCommit } : {}),
            ...(durations.get(run.id) ? { durations: durations.get(run.id)! } : {}) }))
          if (reply.operation !== 'start') {
            busy.delete(computer.key)
            if (usesGitHubIntegration) integrationOnGitHub.delete(computer.key)
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
            busy.delete(computer.key)
            if (usesGitHubIntegration) integrationOnGitHub.delete(computer.key)
            run = await this.read(run.id, run.workspaceId)
            if (run.state !== 'queued') return
            continue
          }
          return
        } catch (error) {
          // A busy or unready computer is skipped; the run stays queued for the next free one.
          const code = (error as { code?: unknown } | null)?.code
          if (code !== 'CI_HOST_BUSY') {
            busy.delete(computer.key)
            if (usesGitHubIntegration) integrationOnGitHub.delete(computer.key)
          }
          if (code === 'CI_HOST_BUSY' || code === 'COMPUTER_GITHUB_REQUIRED' || code === 'CI_CLOUD_UNAVAILABLE'
            || code === 'BUILD_COMPUTER_DISABLED') continue
          log.warn({ err: error, runId: run.id, computer: computer.key }, 'CI start failed')
        }
      }
    }))
  }
}

export { CI_HOST_NAMESPACE }
