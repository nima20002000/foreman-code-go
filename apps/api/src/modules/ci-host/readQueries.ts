import type pg from 'pg'
import { CI_LOG_MAX_BYTES, CI_RUN_JOBS_LIMIT, CiListOutputSchema, CiRunRecordSchema,
  type CiListOutput, type CiRunRecord, type CiTestResults, type CiTestStatus,
  type OperatorCiListInput } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { DomainError, databaseReadFailure } from '../errors.js'
import { CI_GET_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { ciGroupState } from './parts.js'
import { CI_QUEUE_ORDER, ciQueueReason } from './priority.js'
import { ciGateReport } from './gateReport.js'
import { assertCiReadAccess } from './runAccess.js'
import { RUN_CI_JOBS_SQL, runCiJob, storedCiTestResults, type RunCiJobRow } from './runJobs.js'
import type { HostCiComputer, HostCiEndpoint } from './serviceTypes.js'
import { readHostCiLog } from './logRead.js'

/** CI reads are idempotent: one retry after a lock or statement timeout, then a typed retryable error. */
export async function retryRead<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (databaseReadFailure(error) === error) throw error
    try {
      return await work()
    } catch (retryError) {
      throw databaseReadFailure(retryError)
    }
  }
}

type HostRef = HostCiComputer['hostRef']
interface CiReadHost {
  endpoint: HostCiEndpoint
  readRun(id: string, workspaceId: string): Promise<CiRunRecord>
  computer(hostRef: HostRef): Promise<HostCiComputer>
  smokeTargets(runs: CiRunRecord[]): Promise<Map<string, HostRef>>
}

/** Authorized ticket, test and log reads shared by HTTP and Operator MCP. */
export class HostCiReads {
  constructor(private readonly pool: pg.Pool, private readonly authority: CiAuthority,
    private readonly host: CiReadHost) {}

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
          and record->'initiator'=$3::jsonb
          order by record->>'suite',record->>'part',(record->'partition'->>'index')::integer,created_at,id`,
        [run.groupId, scope.workspaceId, JSON.stringify(run.initiator)])).rows.map(row => CiRunRecordSchema.parse(row.record))
      const position = run.state === 'queued' ? await this.queuePosition(run.id) : undefined
      const smokeComputer = (await this.host.smokeTargets([run])).get(run.groupId)
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
      const run = await this.host.readRun(input.ticketId, scope.workspaceId)
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
  async list(caller: ManagementPrincipal,
    input: Omit<OperatorCiListInput, 'workspaceId'> & { workspaceId?: string | undefined }): Promise<CiListOutput> {
    return retryRead(async () => {
      if (caller.audience === 'worker') {
        throw new DomainError('ACCESS_DENIED', 'Agents read their own CI tickets with ci_get.', 403)
      }
      const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
      const run = (await this.pool.query<{ workflow_id: string }>('select workflow_id from runs where id=$1 and workspace_id=$2',
        [input.runId, scope.workspaceId])).rows[0]
      if (!run) throw new DomainError('RUN_NOT_FOUND', 'The Run was not found in this workspace.', 404)
      requireAuthorization(caller, 'runs:read', {
        workspaceId: scope.workspaceId, workflowId: run.workflow_id, runId: input.runId,
      })
      const rows = (await this.pool.query<RunCiJobRow>(RUN_CI_JOBS_SQL,
        [scope.workspaceId, input.runId, input.executionId ?? null])).rows
      return CiListOutputSchema.parse({ runId: input.runId, jobs: rows.slice(0, CI_RUN_JOBS_LIMIT).map(runCiJob),
        truncated: rows.length > CI_RUN_JOBS_LIMIT })
    })
  }

  /** Reads the run's log from its computer; without afterOffset it returns the last maxBytes. */
  async logs(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; ticketId: string
    afterOffset?: number | undefined; maxBytes?: number | undefined; group?: boolean | undefined }) {
    return retryRead(async () => {
      const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
      const run = await this.host.readRun(input.ticketId, scope.workspaceId)
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
    const computer = await this.host.computer(run.computer.hostRef)
    return readHostCiLog(this.host.endpoint, computer, run.id, { ...input, maxBytes })
  }
}
