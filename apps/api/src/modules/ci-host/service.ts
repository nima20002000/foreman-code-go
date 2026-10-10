import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CI_HOST_NAMESPACE, CiHostReplySchema, CiRunRecordSchema, WorkspaceSchema,
  type CiHostRequest, type CiHostReply, type CiPartition, type CiRunRecord, type CiSuite } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresSourceService } from '../sources/service.js'
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
export type AgentSnapshots = (executionId: string) => Promise<{ baseCommit: string; commit: string; bundle: Buffer } | null>

const log = componentLogger('jobs')

/** CI runs directly on build computers: Main resolves the commit, makes sure GitHub has it, queues one run per
 * suite or integration partition and hands each to an idle computer, which fetches and runs it. */
export class HostCiService {
  private dispatching: Promise<void> | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly authority: CiAuthority, private readonly sources: PostgresSourceService,
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
        const approved = await this.sources.approveProject(scope.principal, { workspaceId: scope.workspaceId,
          commandId: `${input.commandId}:source`, ...(input.commit ? { commit: input.commit } : {}),
          ...(snapshot ? { snapshot } : {}) })
        const commit = approved.manifest.git!.commit
        await this.sources.publish(repository, commit, AbortSignal.timeout(120_000))
        const groupId = randomUUID(), now = new Date().toISOString()
        const partitions: (CiPartition | null)[] = input.partitions
          ? Array.from({ length: input.partitions }, (_, index) => ({ index, count: input.partitions! })) : [null]
        const runs = partitions.map(partition => CiRunRecordSchema.parse({ id: randomUUID(), workspaceId: scope.workspaceId,
          suite: input.suite, commit, repository, partition, groupId, state: 'queued', computer: null, step: null,
          exitCode: null, message: null, queuedAt: now, startedAt: null, finishedAt: null,
          initiator: { principalId: caller.id, executionId: scope.executionId ?? null } }))
        for (const run of runs) {
          await this.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record) values($1,$2,$3,'queued',$4::jsonb)`,
            [run.id, run.workspaceId, groupId, JSON.stringify(run)])
        }
        return { ticketId: runs[0]!.id, ...(input.partitions ? { partitions: runs.map(run => ({ ticketId: run.id })) } : {}) }
      },
    })
    void this.dispatch()
    return outcome.value
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
      const reply = await this.endpoint.request(computer, { operation: 'read', runId: run.id, afterOffset: 0, maxBytes: 1 })
        .catch(() => null)
      if (reply?.operation === 'read') await this.settle(run, computer, reply.run)
    }
    const busy = new Set((await this.pool.query<{ host_key: string }>(
      `select host_key from ci_runs where state in ('starting','running')`)).rows.map(row => row.host_key))
    const queued = (await this.pool.query<{ record: unknown }>(
      `select record from ci_runs where state='queued' order by created_at,id limit 50`)).rows.map(row => CiRunRecordSchema.parse(row.record))
    for (const run of queued) {
      for (const computer of [...computers].sort((left, right) => right.priority - left.priority)) {
        if (busy.has(computer.key)) continue
        try {
          const reply = CiHostReplySchema.parse(await this.endpoint.request(computer, { operation: 'start', runId: run.id,
            repository: run.repository, commit: run.commit, suite: run.suite, ...(run.partition ? { partition: run.partition } : {}) }))
          if (reply.operation !== 'start') continue
          await this.settle({ ...run, computer: { hostRef: computer.hostRef, label: computer.label } }, computer, reply.run)
          busy.add(computer.key)
          break
        } catch (error) {
          // A busy or unready computer is skipped; the run stays queued for the next free one.
          const code = (error as { code?: unknown } | null)?.code
          if (code === 'CI_HOST_BUSY' || code === 'COMPUTER_GITHUB_REQUIRED') {
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
