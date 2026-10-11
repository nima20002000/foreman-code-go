import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CI_HOST_NAMESPACE, CiHostReplySchema, CiRunRecordSchema, WorkspaceSchema,
  type CiDurations, type CiHostRequest, type CiHostReply, type CiPartition, type CiRunRecord, type CiSuite } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../jobs/ciAuthority.js'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'

type HostRef = CiRunRecord['computer'] extends infer C ? C extends { hostRef: infer H } ? H : never : never
export interface HostCiComputer { key: string; hostRef: HostRef; label: string; priority: number }
export interface HostCiEndpoint {
  /** Paired computers that serve host CI now. */
  computers(): Promise<HostCiComputer[]>
  request(computer: HostCiComputer, request: CiHostRequest): Promise<CiHostReply>
}
/** Resolves the commit to test and makes sure GitHub has it, so build computers can fetch it. */
export interface CiCommits {
  resolve(repository: string, defaultBranch: string, commit: string | undefined,
    snapshot: { baseCommit: string; commit: string; bundle: Buffer } | null): Promise<string>
}
export type AgentSnapshots = (executionId: string) => Promise<{ baseCommit: string; commit: string; bundle: Buffer } | null>

const log = componentLogger('jobs')

/** CI runs directly on build computers: Main resolves the commit, makes sure GitHub has it, queues one run per
 * suite or integration partition and hands each to an idle computer, which fetches and runs it. */
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

  async run(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; suite: CiSuite; commit?: string | undefined
    commandId: string; partitions?: number | undefined }) {
    const scope = await this.authority.resolve(caller, input.workspaceId, CI_RUN_ACTIONS)
    const outcome = await this.commands.execute({ principal: caller, source: 'mcp', operation: 'ci.run',
      commandId: input.commandId, targetKey: scope.workspaceId, payload: input,
      authorize: async () => { await this.authority.resolve(caller, scope.workspaceId, CI_RUN_ACTIONS) },
      perform: async () => {
        const workspace = WorkspaceSchema.parse((await this.pool.query<{ record: unknown }>(
          'select record from workspaces where id=$1', [scope.workspaceId])).rows[0]?.record)
        if (!workspace.repository) throw new DomainError('SOURCE_REPOSITORY_REQUIRED',
          'CI runs on build computers from GitHub. Set the workspace GitHub repository (workspace_update).', 409)
        const repository = `${workspace.repository.owner}/${workspace.repository.name}`
        // An Agent's CI tests its current files; they are published to GitHub so build computers can fetch them.
        const snapshot = scope.executionId && !input.commit && this.snapshots ? await this.snapshots(scope.executionId) : null
        const commit = await this.commits.resolve(repository, workspace.repository.defaultBranch, input.commit, snapshot)
        const groupId = randomUUID(), now = new Date().toISOString()
        // Every partition of the run splits and times its files by the same snapshot of learned durations.
        const durations = input.suite === 'integration' ? await this.learnedDurations(repository) : null
        const partitions: (CiPartition | null)[] = input.partitions
          ? Array.from({ length: input.partitions }, (_, index) => ({ index, count: input.partitions! })) : [null]
        const runs = partitions.map(partition => CiRunRecordSchema.parse({ id: randomUUID(), workspaceId: scope.workspaceId,
          suite: input.suite, commit, repository, partition, groupId, state: 'queued', computer: null, step: null,
          exitCode: null, message: null, queuedAt: now, startedAt: null, finishedAt: null,
          initiator: { principalId: caller.id, executionId: scope.executionId ?? null } }))
        for (const run of runs) {
          await this.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,durations)
            values($1,$2,$3,'queued',$4::jsonb,$5::jsonb)`, [run.id, run.workspaceId, groupId, JSON.stringify(run),
            durations ? JSON.stringify(durations) : null])
        }
        return { ticketId: runs[0]!.id, ...(input.partitions ? { partitions: runs.map(run => ({ ticketId: run.id })) } : {}) }
      },
    })
    void this.dispatch()
    return outcome.value
  }

  /** The repository's learned integration file durations, most recently measured first, within the start request's
   * bound. Files no run has measured fall back to the commit's committed durations on the build computer. */
  private async learnedDurations(repository: string): Promise<CiDurations | null> {
    const rows = (await this.pool.query<{ file: string; duration_ms: number }>(`select file,duration_ms from ci_file_durations
      where repository=$1 order by updated_at desc,file limit 1000`, [repository])).rows
    return rows.length ? Object.fromEntries(rows.map(row => [row.file, row.duration_ms])) : null
  }

  /** Folds a finished integration run's measured file durations into the repository's history: an exponential moving
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
      if (run.partition && !run.partition.weights) groups.set(run.groupId, [...groups.get(run.groupId) ?? [], run])
    }
    if (!groups.size) return queued
    const speed = await this.throughput(free)
    const replaced = new Map<string, CiRunRecord>()
    for (const group of groups.values()) {
      const count = group[0]!.partition!.count
      if (group.length !== count) continue
      const ordered = [...free].sort((left, right) => (speed.get(right.key) ?? 0) - (speed.get(left.key) ?? 0)
        || right.priority - left.priority).slice(0, count)
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
      if (!key || speed.has(key) || !run.startedAt || !run.finishedAt || run.step !== 'integration') continue
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

  async get(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; ticketId: string }) {
    const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
    await this.dispatch()
    const run = await this.read(input.ticketId, scope.workspaceId)
    const group = (await this.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1 order by created_at,id',
      [run.groupId])).rows.map(row => CiRunRecordSchema.parse(row.record))
    let logTail = ''
    if (run.computer && run.state !== 'queued') {
      const tail = await this.logs(caller, { ...input, afterOffset: undefined, maxBytes: 32_768 }).catch(() => null)
      logTail = tail?.text ?? ''
    }
    return { run, partitions: group.length > 1 ? group : undefined, logTail }
  }

  /** Reads the run's log from its computer; without afterOffset it returns the last maxBytes. */
  async logs(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; ticketId: string
    afterOffset?: number | undefined; maxBytes?: number | undefined }) {
    const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
    const run = await this.read(input.ticketId, scope.workspaceId)
    if (!run.computer) throw new DomainError('CI_NOT_STARTED', 'This CI run is still queued.', 409)
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

  async cancel(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; ticketId: string }) {
    const scope = await this.authority.resolve(caller, input.workspaceId, ['jobs:cancel'])
    const run = await this.read(input.ticketId, scope.workspaceId)
    if (run.state === 'queued') {
      const canceled = { ...run, state: 'canceled' as const, finishedAt: new Date().toISOString(), message: 'Canceled.' }
      await this.save(canceled, null)
      return { run: canceled }
    }
    if (run.computer && ['starting', 'running'].includes(run.state)) {
      const computer = await this.computer(run.computer.hostRef)
      const reply = await this.endpoint.request(computer, { operation: 'cancel', runId: run.id })
      if (reply.operation === 'cancel') await this.settle(run, computer, reply.run)
    }
    return { run: await this.read(run.id, scope.workspaceId) }
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
    if (!computer) throw new DomainError('CI_COMPUTER_OFFLINE', 'The build computer running this CI run is offline.', 409)
    return computer
  }

  private async settle(run: CiRunRecord, computer: HostCiComputer, state: { state: string; step: string | null
    exitCode: number | null; startedAt: string; finishedAt: string | null; message: string | null }) {
    const next = CiRunRecordSchema.parse({ ...run, state: state.state, step: state.step, exitCode: state.exitCode,
      startedAt: run.startedAt ?? state.startedAt, finishedAt: state.finishedAt, message: state.message })
    await this.save(next, ['starting', 'running'].includes(next.state) ? computer.key : null)
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
    for (const row of active) {
      const run = CiRunRecordSchema.parse(row.record)
      const computer = computers.find(value => value.key === row.host_key)
      if (!computer) continue
      const reply = await this.endpoint.request(computer, { operation: 'read', runId: run.id, afterOffset: 0, maxBytes: 1,
        ...(run.suite === 'integration' ? { durations: true } : {}) }).catch(() => null)
      if (reply?.operation !== 'read') continue
      await this.settle(run, computer, reply.run)
      // A run is read here until it finishes, so its measured durations are learned once.
      if (reply.durations && !['starting', 'running'].includes(reply.run.state)) {
        await this.learnDurations(run.repository, reply.durations)
          .catch(error => log.warn({ err: error, runId: run.id }, 'CI durations not recorded'))
      }
    }
    const busy = new Set((await this.pool.query<{ host_key: string }>(
      `select host_key from ci_runs where state in ('starting','running')`)).rows.map(row => row.host_key))
    const queuedRows = (await this.pool.query<{ record: unknown; durations: CiDurations | null }>(
      `select record,durations from ci_runs where state='queued' order by created_at,id limit 50`)).rows
    let queued = queuedRows.map(row => CiRunRecordSchema.parse(row.record))
    const durations = new Map(queuedRows.map((row, index) => [queued[index]!.id, row.durations]))
    queued = await this.weighPartitions(queued, computers.filter(computer => !busy.has(computer.key)))
    for (const run of queued) {
      const order = [...computers].sort((left, right) => Number(right.key === run.plannedHostKey)
        - Number(left.key === run.plannedHostKey) || right.priority - left.priority)
      for (const computer of order) {
        if (busy.has(computer.key)) continue
        try {
          const reply = CiHostReplySchema.parse(await this.endpoint.request(computer, { operation: 'start', runId: run.id,
            repository: run.repository, commit: run.commit, suite: run.suite, ...(run.partition ? { partition: run.partition } : {}),
            ...(durations.get(run.id) ? { durations: durations.get(run.id)! } : {}) }))
          if (reply.operation !== 'start') continue
          await this.settle({ ...run, computer: { hostRef: computer.hostRef, label: computer.label } }, computer, reply.run)
          busy.add(computer.key)
          break
        } catch (error) {
          // A busy or unready computer is skipped; the run stays queued for the next free one.
          const code = (error as { code?: unknown } | null)?.code
          if (code === 'CI_HOST_BUSY' || code === 'COMPUTER_GITHUB_REQUIRED' || code === 'CI_CLOUD_UNAVAILABLE') {
            if (code === 'CI_HOST_BUSY') busy.add(computer.key)
            continue
          }
          log.warn({ err: error, runId: run.id, computer: computer.key }, 'CI start failed')
        }
      }
    }
  }
}

export { CI_HOST_NAMESPACE }
