import { randomUUID } from 'node:crypto'

import {
  HarnessExecutionSchema,
  HarnessNativeEventSchema,
  RunActivitySchema,
  WorkflowRunSchema,
  type ActivityKind,
  type ActivitySource,
  type ExecutionResult,
  type HarnessExecution,
  type HarnessNativeEvent,
  type RunActivity,
  type RunInput,
  type WorkflowRun,
  type WorkflowRunSummary,
} from '@graphql/contracts'
import type pg from 'pg'
import { readRunDetails } from './liveSnapshot.js'

import { DomainError } from '../errors.js'
import { assertWorkflowRecovered } from './recoveryPolicy.js'
import type { RepeatRepositoryActivation, RepositoryExecutionSemantics, RepositoryWorkflowRun, RunRepository, RunStateUpdate } from './port.js'
import { acceptedRunApproval } from '../workflows/approval.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import { validateWorkflowApproval } from '../workflows/approval.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import { RunOwnership } from './ownership.js'
import { OneShotRunRepository } from './oneShotPostgres.js'
import { assertWave25Admission, CompatibleWorkflowRunSchema, WorkflowVersionV2Schema } from '@graphql/contracts/wave25'
import { changeOneShotLifecycle, type AuthorizeOneShotStop } from './oneShotLifecycle.js'
import { appendNativeEvent } from './nativeEvents.js'
import { appendWorkflowNativeGraphEvent, type WorkflowApprovalCorrelation, type WorkflowContinuationProof,
  type WorkflowNativeLease } from './workflowNativeGraph.js'
import { validateExecutableTopology } from './topology.js'
import { requiredLocationAccess, type WorkspaceLocationService } from '../workspaces/location.js'
import { beforeGraphCommit, withExclusiveGraphConnection, type GraphTransactionSql } from '../run-graph/connection.js'
import { openRepeatCanonicalPublicationLocked } from '../run-graph/repeatPublication.js'
import { RepeatRepositoryFactory } from './repeatRepositoryHost.js'
import { readRepeatExecutionLocked, readRepeatAcceptedResultLocked } from './repeatPostgres.js'
import { readAcceptedRepeatRunLocked, type AcceptedRepeatRunSnapshot } from './repeatStartRead.js'
import { captureRepeatNativeEvidence, type RepeatLaunchPaths, type RepeatNativeBoundaryEvidence,
  type RepeatNativeEvidence } from './repeatNativeRepository.js'
import { sameRepeatValue, type RepeatNodeRef } from './repeatResolution.js'

/** The JSON tag itself must be a known literal. ->> would silently accept "3"
 * and conflate explicit null with legacy absence. Parsing remains arm-specific. */
export function runRepositorySemantics(record: unknown): RepositoryExecutionSemantics {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new DomainError('EXECUTION_SEMANTICS_UNSUPPORTED', 'Invalid Run/version record.', 409)
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'executionSemanticsVersion')) return 1
  const tag = (record as { executionSemanticsVersion: unknown }).executionSemanticsVersion
  if (tag === 1 || tag === 2 || tag === 3) return tag
  throw new DomainError('EXECUTION_SEMANTICS_UNSUPPORTED', 'Unknown execution semantics cannot use a legacy fallback.', 409)
}
function repeatLifecycleRequired(): never {
  throw new DomainError('REPEAT_LIFECYCLE_PUBLICATION_REQUIRED',
    'The existing v3 Run/Stop/cleanup lifecycle producer must be composed before activation.', 409)
}

export class PostgresRunRepository implements RunRepository {
  private readonly oneShotStores = new WeakMap<RunOwnership, OneShotRunRepository>()
  private readonly repeatFactory: RepeatRepositoryFactory | undefined
  constructor(
    private readonly pool: pg.Pool,
    private readonly workflows: PostgresWorkflowRepository,
    private readonly locations: WorkspaceLocationService,
    repeat?: RepeatRepositoryActivation,
  ) {
    // A single factory for the repository, a single store per actual owner. The
    // producer receives that owner and its existing transaction, never a pool.
    if (repeat) {
      const services = repeat.services
      if (!services || ['assertNativeBoundaryLocked', 'assertNativeUpdateLocked', 'assertSettlementLocked',
        'allowTechnicalRetryLocked', 'completeRunLocked'].some((key) => typeof services[key as keyof typeof services] !== 'function')) {
        throw new DomainError('REPEAT_NATIVE_HOST_REQUIRED', 'Every real native/lifecycle proof service is required.', 409)
      }
      this.repeatFactory = new RepeatRepositoryFactory(locations, repeat.runtimeRoot, {
        openPublicationLocked: openRepeatCanonicalPublicationLocked,
        assertNativeBoundaryLocked: services.assertNativeBoundaryLocked.bind(services),
        assertNativeUpdateLocked: services.assertNativeUpdateLocked.bind(services),
        assertSettlementLocked: services.assertSettlementLocked.bind(services),
        allowTechnicalRetryLocked: services.allowTechnicalRetryLocked.bind(services),
        completeRunLocked: services.completeRunLocked.bind(services),
      })
    }
  }

  private assertOwnerScope(runId: string, owner?: RunOwnership): void {
    owner?.assertOwned()
    if (owner && owner.runId !== runId) throw new DomainError('GRAPH_SCOPE_MISMATCH', 'Run ownership cannot cross Run identities.', 409)
  }

  private requireOwner(runId: string, owner?: RunOwnership): RunOwnership {
    this.assertOwnerScope(runId, owner)
    if (!owner) throw new DomainError('RUN_OWNERSHIP_REQUIRED', 'Repeat writes require the existing Run owner.', 409)
    return owner
  }

  private async readSemantics(runId: string, owner?: RunOwnership, client?: Pick<pg.ClientBase, 'query'>): Promise<RepositoryExecutionSemantics> {
    this.assertOwnerScope(runId, owner)
    const rows = await (client ?? owner?.client ?? this.pool).query<{ record: unknown; version: unknown; execution_semantics_version: number }>(
      `select r.record,v.record as version,v.execution_semantics_version from runs r
       join workflow_versions v on v.id=r.workflow_version_id where r.id=$1`, [runId])
    const row = rows.rows[0]
    if (!row) throw new DomainError('RUN_NOT_FOUND', `Run '${runId}' or its immutable version was not found.`, 404)
    const semantics = runRepositorySemantics(row.record)
    if ((row.record as { id?: unknown }).id !== runId || row.execution_semantics_version !== semantics
      || runRepositorySemantics(row.version) !== semantics) {
      throw new DomainError('RUN_PIN_CONFLICT', 'The physical immutable version and Run semantics disagree.', 409)
    }
    return semantics
  }

  executionSemantics(runId: string, owner?: RunOwnership): Promise<RepositoryExecutionSemantics> {
    return this.readSemantics(runId, owner)
  }

  /** Internal engine composition only. This is not proof that Start is ready. */
  repeatRepositoryFactory(): RepeatRepositoryFactory {
    if (!this.repeatFactory) throw new DomainError('REPEAT_NATIVE_HOST_REQUIRED', 'Real native/lifecycle proof services are not composed.', 409)
    return this.repeatFactory
  }

  private async repeatRead<T>(runId: string, owner: RunOwnership | undefined,
    read: (sql: GraphTransactionSql, snapshot: AcceptedRepeatRunSnapshot) => Promise<T>): Promise<T> {
    this.assertOwnerScope(runId, owner)
    const work = async (sql: GraphTransactionSql) => {
      const fence = owner ? await owner.readOneShotFence(sql) : undefined
      const snapshot = await readAcceptedRepeatRunLocked(sql, runId)
      const result = await read(sql, snapshot)
      if (owner) beforeGraphCommit(sql, async () => {
        if (!sameRepeatValue(fence, await owner.readOneShotFence(sql))) {
          throw new DomainError('RUN_OWNERSHIP_LOST', 'The exact Run owner changed before COMMIT.', 409)
        }
      })
      return result
    }
    // Uses FOR SHARE; not a READ ONLY transaction. No second owner or pool is created.
    return owner ? owner.oneShotConnection().transaction(work)
      : withExclusiveGraphConnection(this.pool, (connection) => connection.transaction(work))
  }

  getRepeatSnapshot(runId: string, owner?: RunOwnership): Promise<AcceptedRepeatRunSnapshot> {
    return this.repeatRead(runId, owner, async (_sql, snapshot) => snapshot)
  }

  async getRepeatVersion(runId: string, workflowVersionId: string, owner?: RunOwnership) {
    const snapshot = await this.getRepeatSnapshot(runId, owner)
    if (snapshot.version.id !== workflowVersionId) throw new DomainError('RUN_PIN_CONFLICT', 'Read only the exact immutable Run version.', 409)
    return snapshot.version
  }

  async repeat(owner: RunOwnership) {
    owner.assertOwned()
    const factory = this.repeatRepositoryFactory()
    const { version } = await this.getRepeatSnapshot(owner.runId, owner)
    return factory.forOwner(owner, version)
  }

  async admitRepeatExecution(ref: RepeatNodeRef, candidate: () => HarnessExecution, owner: RunOwnership) {
    const captured = structuredClone(ref)
    return (await this.repeat(owner)).admit(captured, candidate)
  }

  async claimRepeatLaunch(executionId: string, paths: RepeatLaunchPaths, owner: RunOwnership) {
    const captured = { ...paths }
    return (await this.repeat(owner)).claimLaunch(executionId, captured)
  }

  consumeRepeatLaunch(executionId: string, owner: RunOwnership): boolean {
    owner.assertOwned()
    return this.repeatFactory?.consumeLaunchPermit(owner, executionId) === true
  }

  async recoverRepeatSession(executionId: string, owner: RunOwnership) {
    return (await this.repeat(owner)).recoverSession(executionId)
  }

  async exactRepeatSession(executionId: string, owner: RunOwnership) {
    return (await this.repeat(owner)).exactSession(executionId)
  }

  async assertRepeatNativeBoundary(executionId: string, owner: RunOwnership, evidence: RepeatNativeBoundaryEvidence): Promise<void> {
    const captured = evidence.kind === 'first_launch' ? { kind: 'first_launch' as const } : captureRepeatNativeEvidence(evidence)
    await (await this.repeat(owner)).assertNativeBoundary(executionId, captured)
  }

  async acceptRepeatTerminal(execution: HarnessExecution, owner: RunOwnership, candidate?: (attempt: number) => HarnessExecution) {
    const captured = HarnessExecutionSchema.parse(structuredClone(execution))
    this.requireOwner(captured.runId, owner)
    return (await this.repeat(owner)).acceptTerminal(captured.id, candidate, captured)
  }

  /** Bounded exact detail page, not the legacy whole-Run attempt list. Callers
   * continue using the last returned execution ID; no occurrence is progressed. */
  async listRepeatExecutions(runId: string, afterId = '', limit = 100, owner?: RunOwnership) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || typeof afterId !== 'string') {
      throw new DomainError('REPEAT_READ_BOUND_INVALID', 'Use an execution-ID cursor and a limit from 1 to 1000.', 409)
    }
    return this.repeatRead(runId, owner, async (sql, snapshot) => {
      const rows = await sql.query<{ id: string }>(
        'select id from harness_executions where run_id=$1 and id>$2 order by id limit $3', [runId, afterId, limit])
      const results = []
      for (const row of rows.rows) results.push(await readRepeatExecutionLocked(sql, snapshot, row.id))
      return results
    })
  }

  acquireOwnership(runId: string, onLost: () => void): Promise<RunOwnership | undefined> {
    return RunOwnership.acquire(this.pool, runId, onLost)
  }

  /** One repository and ephemeral first-launch permit set per existing Run owner. */
  oneShot(owner: RunOwnership): OneShotRunRepository {
    owner.assertOwned()
    let store = this.oneShotStores.get(owner)
    if (!store) {
      store = new OneShotRunRepository(owner, async (sql, run) => {
        if (run.authorizationPrincipalId) await this.locations.revalidateRunAuthorization(
          run.authorizationPrincipalId, run.workspaceId, run.workflowId,
          // This existing helper is SQL-only; the facade retains exclusive G1
          // transaction ownership and exposes no raw native/connection methods.
          sql as unknown as Pick<pg.PoolClient, 'query'>)
      })
      this.oneShotStores.set(owner, store)
    }
    return store
  }

  async isOneShot(runId: string, owner?: RunOwnership): Promise<boolean> {
    const semantics = await this.executionSemantics(runId, owner)
    if (semantics === 3) throw new DomainError('REPEAT_DISPATCH_REQUIRED', 'V3 must use its explicit repository/engine arm, never the legacy fallback.', 409)
    return semantics === 2
  }

  async getOneShotVersion(workflowVersionId: string) {
    const row = await this.pool.query<{ record: unknown }>('select record from workflow_versions where id=$1', [workflowVersionId])
    return WorkflowVersionV2Schema.parse(row.rows[0]?.record)
  }

  consumeOneShotLaunch(executionId: string, owner: RunOwnership): boolean {
    return this.oneShotStores.get(owner)?.consumeLaunchPermit(executionId) === true
  }

  async exactOneShotSession(executionId: string, owner: RunOwnership) {
    if (!await this.isOneShot(owner.runId, owner)) return undefined
    return this.oneShot(owner).exactSession(executionId)
  }

  async assertOneShotNativeBoundary(executionId: string, owner: RunOwnership): Promise<void> {
    if (await this.isOneShot(owner.runId, owner)) await this.oneShot(owner).assertNativeBoundary(executionId)
  }

  async requestStop(runId: string, authorize?: AuthorizeOneShotStop): Promise<void> {
    const semantics = await this.executionSemantics(runId)
    if (semantics === 3) return repeatLifecycleRequired()
    if (semantics === 2) await changeOneShotLifecycle(this.pool, runId, { kind: 'stop', ...(authorize ? { authorize } : {}) })
  }

  async hasRequestedStop(runId: string): Promise<boolean> {
    await this.executionSemantics(runId)
    const row = await this.pool.query<{ stopped: boolean }>('select stop_requested_at is not null as stopped from runs where id=$1', [runId])
    return row.rows[0]?.stopped === true
  }

  async requestCleanup(runId: string, client?: pg.ClientBase): Promise<void> {
    const semantics = await this.readSemantics(runId, undefined, client)
    if (semantics === 3) return repeatLifecycleRequired()
    if (semantics === 2) {
      if (client) throw new DomainError('GRAPH_TRANSACTION_CONTEXT_REQUIRED', 'Compose publishOneShotCleanup with the current G1 publication; raw-client nesting is forbidden.', 409)
      return changeOneShotLifecycle(this.pool, runId, { kind: 'cleanup', pending: true })
    }
    await (client ?? this.pool).query(`insert into run_cleanup_intents(run_id) values($1)
      on conflict(run_id) do update set pending=true,updated_at=now()`, [runId])
  }

  async hasPendingCleanup(runId: string, client?: Pick<pg.ClientBase, 'query'>): Promise<boolean> {
    await this.readSemantics(runId, undefined, client)
    const found = await (client ?? this.pool).query(
      'select 1 from run_cleanup_intents where run_id=$1 and pending', [runId])
    return found.rowCount === 1
  }

  async finishCleanup(runId: string, failed: boolean, client?: pg.ClientBase): Promise<void> {
    const semantics = await this.readSemantics(runId, undefined, client)
    if (semantics === 3) return repeatLifecycleRequired()
    if (semantics === 2) {
      if (client) throw new DomainError('GRAPH_TRANSACTION_CONTEXT_REQUIRED', 'Compose publishOneShotCleanup with the current G1 publication; raw-client nesting is forbidden.', 409)
      return changeOneShotLifecycle(this.pool, runId, { kind: 'cleanup', pending: failed })
    }
    await (client ?? this.pool).query(`update run_cleanup_intents set pending=$2,attempts=attempts+1,
      last_error=$3,updated_at=now() where run_id=$1`,
    [runId, failed, failed ? 'Native closure or task draining remains unconfirmed; retry cleanup.' : null])
  }

  async reconciliationCandidates(): Promise<RepositoryWorkflowRun[]> {
    const result = await this.pool.query<{ id: string; record: unknown }>(
      `select id,record from runs where execution_state in ('queued', 'running', 'waiting')
        or exists(select 1 from run_cleanup_intents c where c.run_id=runs.id and c.pending)
        order by created_at,id`,
    )
    const runs: RepositoryWorkflowRun[] = []
    for (const row of result.rows) runs.push(await this.readRunRecord(row.record, row.id))
    return runs
  }

  /** Read persisted active time on the ownership connection, excluding approval waits. */
  async remainingApprovalTime(runId: string, executionIds: string[], owner: RunOwnership): Promise<number> {
    this.assertOwnerScope(runId, owner)
    await this.executionSemantics(runId, owner)
    const ids = [...new Set(executionIds)]
    const result = await owner.client.query<{ remaining_ms: string; stopped_at: Date | null }>(
      `select (budget.active_timeout_ms - budget.active_elapsed_ms -
         case when budget.approval_wait_started_at is not null then 0
           else greatest(0, coalesce(extract(epoch from (clock_timestamp()-budget.active_started_at))*1000,0))
         end)::text as remaining_ms, budget.stopped_at
       from approval_execution_state budget
       join harness_executions execution on execution.id=budget.execution_id
       where execution.run_id=$1 and execution.id=any($2::text[])`, [runId, ids],
    )
    if (!ids.length || result.rows.length !== ids.length || result.rows.some((row) => row.stopped_at)) {
      throw new DomainError('EXECUTION_STOPPED', 'A resumed execution is stopped or has no active-time budget.', 409)
    }
    return Math.max(0, Math.min(...result.rows.map((row) => Number(row.remaining_ms))))
  }

  /** Called only while holding database ownership; never modifies another live owner. */
  async settleOrphan(runId: string, owner: RunOwnership, canceled: boolean): Promise<boolean> {
    owner.assertOwned()
    const semantics = await this.executionSemantics(runId, owner)
    if (semantics === 3) return repeatLifecycleRequired()
    if (semantics === 2) {
      const run = await this.get(runId, owner)
      if (!run || run.executionState === 'completed') return false
      await this.oneShot(owner).settleRun(canceled, !canceled)
      return true
    }
    const client = owner.client
    try {
      await client.query('begin')
      const found = await client.query<{ record: unknown }>('select record from runs where id = $1 for update', [runId])
      const current = found.rows[0] ? CompatibleWorkflowRunSchema.parse(found.rows[0].record) : undefined
      if (!current || current.executionState === 'completed') {
        await client.query('commit')
        return false
      }
      const attempts = await client.query<{ record: unknown }>(
        "select record from harness_executions where run_id = $1 and record->>'state' <> 'completed' for update", [runId],
      )
      const finishedAt = new Date().toISOString()
      const result: ExecutionResult = canceled ? { outcome: 'canceled' } : {
        outcome: 'failed',
        error: { code: 'EXECUTION_INTERRUPTED', message: 'The API lost execution ownership. Native side effects may have occurred; this attempt was not replayed.', retryable: false },
      }
      for (const row of attempts.rows) {
        const execution = HarnessExecutionSchema.parse({ ...HarnessExecutionSchema.parse(row.record), state: 'completed', result, finishedAt })
        await client.query('update harness_executions set record = $2::jsonb where id = $1', [execution.id, JSON.stringify(execution)])
      }
      await this.updateState(runId, canceled ? {
        executionState: 'completed', outcome: 'canceled', result: { outcome: 'canceled' }, finishedAt,
      } : { executionState: 'interrupted', outcome: 'pending' }, owner)
      await client.query('commit')
      return true
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    }
  }

  async createForWorkflow(
    workspaceId: string,
    workflowId: string,
    input: RunInput,
    expectedLocationRevision: number,
  ): Promise<WorkflowRun> {
    const version = await this.workflows.getCurrentVersion(workspaceId, workflowId)
    if (!version) {
      throw new DomainError('WORKFLOW_NOT_FOUND', `Workflow '${workflowId}' was not found.`, 404)
    }
    const semantics = runRepositorySemantics(version)
    if (semantics === 3) throw new DomainError('V3_ADMISSION_REQUIRED', 'Use the explicit authenticated v3 Start service.', 409)
    if (semantics === 2) {
      assertWave25Admission()
      throw new DomainError('V2_ADMISSION_REQUIRED', 'Use the explicit authenticated v2 admission service.', 409)
    }
    validateExecutableTopology(version)
    const approval = acceptedRunApproval(version)
    await this.workflows.assertCurrentConfigurations(version)
    // Recovery must not launch a run whose creation transaction failed.
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`admission:workspace:${workspaceId}`])
      await assertWorkflowRecovered(client, workspaceId, workflowId)
      const configurations = await Promise.all(Object.values(version.agentConfigurationVersionIds).map(async (id) => {
        const configuration = await this.workflows.getAgentConfiguration(id)
        if (!configuration) throw new DomainError('AGENT_CONFIGURATION_NOT_FOUND', `Configuration '${id}' was not found.`, 409)
        return configuration
      }))
      // Decide approval authority before persisting/queuing any native work.
      // Old saved records are never silently migrated to an automatic mode.
      for (const configuration of configurations) assertNativeWorkflowConfiguration(configuration.harness, approval,
        approval?.handler === 'orchestrator' && configuration.agentId === approval.designatedOrchestratorAgentId)
      if (approval) validateWorkflowApproval(version.definition, approval, configurations.map((configuration) => ({
        id: configuration.agentId, productRole: configuration.productRole, harnessConfiguration: configuration.harness,
      })))
      const executionLocation = await this.locations.snapshot(
        client, workspaceId, expectedLocationRevision, requiredLocationAccess(configurations),
      )
      const run = WorkflowRunSchema.parse({
        id: `run-${randomUUID()}`, workspaceId, workflowId, workflowVersionId: version.id,
        agentConfigurationVersionIds: version.agentConfigurationVersionIds,
        ...(approval ? { approval } : {}),
        executionLocation,
        executionCondition: version.definition.executionCondition, executionState: 'queued', outcome: 'pending',
        input, createdAt: new Date().toISOString(),
      })
      await this.create(run, client)
      await this.recordActivity(run.id, 'backend', 'run_state_changed', { executionState: 'queued' }, undefined, client)
      await client.query('commit')
      return run
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  private async readRunRecord(record: unknown, runId: string, owner?: RunOwnership): Promise<RepositoryWorkflowRun> {
    const semantics = runRepositorySemantics(record)
    if ((record as { id?: unknown }).id !== runId || await this.executionSemantics(runId, owner) !== semantics) {
      throw new DomainError('RUN_PIN_CONFLICT', 'The requested physical Run identity/semantics changed.', 409)
    }
    if (semantics !== 3) return CompatibleWorkflowRunSchema.parse(record)
    return (await this.getRepeatSnapshot(runId, owner)).run
  }

  async get(runId: string, owner?: RunOwnership): Promise<RepositoryWorkflowRun | undefined> {
    owner?.assertOwned()
    if (owner?.runId !== undefined && owner.runId !== runId) throw new DomainError('GRAPH_SCOPE_MISMATCH', 'Run ownership cannot cross Run identities.', 409)
    const result = await (owner?.client ?? this.pool).query<{ record: unknown }>('select record from runs where id = $1', [runId])
    return result.rows[0] ? this.readRunRecord(result.rows[0].record, runId, owner) : undefined
  }

  async getForWorkspace(workspaceId: string, runId: string): Promise<RepositoryWorkflowRun | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from runs where workspace_id = $1 and id = $2',
      [workspaceId, runId],
    )
    if (!result.rows[0]) return undefined
    const run = await this.readRunRecord(result.rows[0].record, runId)
    if (run.workspaceId !== workspaceId || run.id !== runId) throw new DomainError('RUN_PIN_CONFLICT', 'The requested physical Run scope changed.', 409)
    return run
  }

  async create(run: WorkflowRun, client?: pg.ClientBase): Promise<void> {
    const semantics = runRepositorySemantics(run)
    if (semantics === 3) throw new DomainError('V3_ADMISSION_REQUIRED', 'Use the same-transaction v3 Start writer and receipts.', 409)
    if (semantics === 2) {
      assertWave25Admission()
      throw new DomainError('V2_ADMISSION_REQUIRED', 'Use insertOneShotRun inside the v2 admission transaction.', 409)
    }
    const parsed = WorkflowRunSchema.parse(structuredClone(run))
    const version = await (client ?? this.pool).query<{ record: unknown; execution_semantics_version: number }>(
      'select record,execution_semantics_version from workflow_versions where id=$1', [parsed.workflowVersionId])
    const pinned = version.rows[0]
    if (!pinned || pinned.execution_semantics_version !== 1 || runRepositorySemantics(pinned.record) !== 1) {
      throw new DomainError('RUN_PIN_CONFLICT', 'Legacy Run creation requires an actual legacy immutable version.', 409)
    }
    await (client ?? this.pool).query(
      `insert into runs (id, workspace_id, workflow_id, workflow_version_id, execution_state, record,
         runner_id, working_directory, location_revision)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [parsed.id, parsed.workspaceId, parsed.workflowId, parsed.workflowVersionId, parsed.executionState, JSON.stringify(parsed),
        parsed.executionLocation?.runnerId ?? null, parsed.executionLocation?.rootPath ?? null,
        parsed.executionLocation?.locationRevision ?? null],
    )
  }

  async updateState(runId: string, update: RunStateUpdate, owner?: RunOwnership): Promise<void> {
    const current = await this.get(runId, owner)
    if (!current) throw new DomainError('RUN_NOT_FOUND', `Run '${runId}' was not found.`, 404)
    const semantics = runRepositorySemantics(current)
    if (semantics === 3) return repeatLifecycleRequired()
    if (semantics === 2) {
      if (!owner) throw new DomainError('RUN_OWNERSHIP_REQUIRED', 'One-shot execution mutations require the current Run owner.', 409)
      return this.oneShot(owner).updateRun(update)
    }
    const next = WorkflowRunSchema.parse({ ...current, ...update })
    owner?.assertOwned()
    await (owner?.client ?? this.pool).query(
      'update runs set execution_state = $2, record = $3::jsonb where id = $1',
      [runId, next.executionState, JSON.stringify(next)],
    )
    await this.recordActivity(runId, 'backend', 'run_state_changed', {
      executionState: next.executionState,
      outcome: next.outcome,
    }, undefined, owner?.client)
  }

  async createExecution(execution: HarnessExecution, owner?: RunOwnership): Promise<void> {
    const parsed = HarnessExecutionSchema.parse(structuredClone(execution))
    const semantics = await this.executionSemantics(parsed.runId, owner)
    if (semantics !== 1) throw new DomainError('EXECUTION_ADMISSION_REQUIRED', 'Use the exact transactional v2 or occurrence-qualified v3 admission.', 409)
    owner?.assertOwned()
    await (owner?.client ?? this.pool).query(
      `insert into harness_executions (id, run_id, workflow_node_id, agent_id, attempt, record)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [parsed.id, parsed.runId, parsed.workflowNodeId, parsed.agentId, parsed.attempt, JSON.stringify(parsed)],
    )
    await this.recordActivity(parsed.runId, 'langgraph', 'node_scheduled', {
      workflowNodeId: parsed.workflowNodeId,
      agentId: parsed.agentId,
      attempt: parsed.attempt,
    }, parsed.id, owner?.client)
  }

  async ensureExecution(execution: HarnessExecution, owner?: RunOwnership): Promise<{ execution: HarnessExecution; created: boolean }> {
    const expected = HarnessExecutionSchema.parse(structuredClone(execution))
    const semantics = await this.executionSemantics(expected.runId, owner)
    if (semantics === 3) {
      const exactOwner = this.requireOwner(expected.runId, owner)
      return this.repeatRead(expected.runId, exactOwner, async (sql, snapshot) => {
        const { execution: current } = await readRepeatExecutionLocked(sql, snapshot, expected.id)
        if (current.runId !== expected.runId || current.workflowNodeId !== expected.workflowNodeId
          || current.agentId !== expected.agentId || current.agentConfigurationVersionId !== expected.agentConfigurationVersionId
          || current.attempt !== expected.attempt || current.createdAt !== expected.createdAt
          || current.parallelGroupId !== expected.parallelGroupId || !sameRepeatValue(current.input, expected.input)) {
          throw new DomainError('EXECUTION_OCCURRENCE_CONFLICT', 'Observe only the exact already admitted v3 occurrence/technical attempt/input.', 409)
        }
        return { execution: current, created: false }
      })
    }
    if (semantics === 2) {
      if (!owner) throw new DomainError('RUN_OWNERSHIP_REQUIRED', 'One-shot observation requires the Run owner.', 409)
      const current = await this.getExecution(expected.id, owner)
      if (!current || current.runId !== owner.runId || current.runId !== expected.runId
        || current.workflowNodeId !== expected.workflowNodeId || current.agentId !== expected.agentId
        || current.agentConfigurationVersionId !== expected.agentConfigurationVersionId || current.attempt !== 1) {
        throw new DomainError('EXECUTION_OCCURRENCE_CONFLICT', 'Observe only the exact already admitted one-shot execution.', 409)
      }
      return { execution: current, created: false }
    }
    owner?.assertOwned()
    const parsed = expected
    // One SQL statement is atomic on a pool lease AND on an owner's client.
    // It never begins/commits a transaction owned by the engine or its caller.
    const result = await (owner?.client ?? this.pool).query<{ record: unknown }>(
      `with occurrence as (
         insert into harness_executions (id, run_id, workflow_node_id, agent_id, attempt, record)
         values ($1,$2,$3,$4,$5,$6::jsonb)
         on conflict (run_id, workflow_node_id, attempt)
           where repeat_occurrence_id is null do nothing returning record
       ), scheduled as (
         insert into run_activity (run_id, source, kind, harness_execution_id, occurred_at, payload)
         select $2, 'langgraph', 'node_scheduled', $1, $7::timestamptz, $8::jsonb from occurrence
         returning sequence
       ) select occurrence.record from occurrence cross join scheduled`,
      [parsed.id, parsed.runId, parsed.workflowNodeId, parsed.agentId, parsed.attempt, JSON.stringify(parsed),
        new Date().toISOString(), JSON.stringify({ workflowNodeId: parsed.workflowNodeId, agentId: parsed.agentId, attempt: parsed.attempt })],
    )
    if (result.rows[0]) return { execution: parsed, created: true }
    const found = await (owner?.client ?? this.pool).query<{ record: unknown }>(
      'select record from harness_executions where run_id=$1 and workflow_node_id=$2 and attempt=$3 and repeat_occurrence_id is null',
      [parsed.runId, parsed.workflowNodeId, parsed.attempt],
    )
    const current = HarnessExecutionSchema.parse(found.rows[0]?.record)
    if (current.agentId !== parsed.agentId || current.agentConfigurationVersionId !== parsed.agentConfigurationVersionId) {
      throw new DomainError('EXECUTION_OCCURRENCE_CONFLICT', 'This execution occurrence is already bound to different accepted configuration.', 409)
    }
    return { execution: current, created: false }
  }

  private async executionWriteSemantics(execution: HarnessExecution, owner?: RunOwnership): Promise<RepositoryExecutionSemantics> {
    this.assertOwnerScope(execution.runId, owner)
    const rows = await (owner?.client ?? this.pool).query<{ run_id: string }>(
      'select run_id from harness_executions where id=$1', [execution.id])
    if (rows.rows.length !== 1 || rows.rows[0]?.run_id !== execution.runId) {
      throw new DomainError('EXECUTION_OCCURRENCE_CONFLICT', 'The physical execution belongs to a different or missing Run.', 409)
    }
    return this.executionSemantics(execution.runId, owner)
  }

  async updateExecution(execution: HarnessExecution, owner?: RunOwnership, evidence?: RepeatNativeEvidence): Promise<void> {
    const incoming = HarnessExecutionSchema.parse(structuredClone(execution))
    const captured = evidence === undefined ? undefined : captureRepeatNativeEvidence(evidence)
    const semantics = await this.executionWriteSemantics(incoming, owner)
    if (semantics === 3) {
      const exactOwner = this.requireOwner(incoming.runId, owner)
      return (await this.repeat(exactOwner)).updateExecution(incoming, captured)
    }
    if (evidence !== undefined) throw new DomainError('REPEAT_SCOPE_CONFLICT', 'V3 native proof cannot be used for a legacy execution.', 409)
    if (semantics === 2) {
      if (!owner) throw new DomainError('RUN_OWNERSHIP_REQUIRED', 'Native domain writes require the current Run owner.', 409)
      return this.oneShot(owner).updateExecution(incoming)
    }
    owner?.assertOwned()
    const parsed = incoming
    await (owner?.client ?? this.pool).query(
      'update harness_executions set record = $2::jsonb where id = $1',
      [parsed.id, JSON.stringify(parsed)],
    )
  }

  async acceptExecutionResult(execution: HarnessExecution, owner?: RunOwnership): Promise<void> {
    const incoming = HarnessExecutionSchema.parse(structuredClone(execution))
    const semantics = await this.executionWriteSemantics(incoming, owner)
    if (semantics === 3) {
      const exactOwner = this.requireOwner(incoming.runId, owner)
      if (incoming.state !== 'completed' || incoming.result?.outcome !== 'succeeded') {
        throw new DomainError('EXECUTION_RESULT_NOT_ACCEPTABLE', 'Only successful terminals use this result acceptance arm.', 409)
      }
      await this.acceptRepeatTerminal(incoming, exactOwner)
      return
    }
    if (semantics === 2) {
      if (!owner) throw new DomainError('RUN_OWNERSHIP_REQUIRED', 'Result acceptance requires the current Run owner.', 409)
      await this.oneShot(owner).acceptTerminal(incoming.id)
      return
    }
    owner?.assertOwned()
    const parsed = incoming
    if (parsed.state !== 'completed' || parsed.result?.outcome !== 'succeeded') {
      throw new DomainError('EXECUTION_RESULT_NOT_ACCEPTABLE', 'Only a successful completed execution can be accepted.', 409)
    }
    await (owner?.client ?? this.pool).query(
      'update harness_executions set accepted = true, record = $2::jsonb where id = $1',
      [parsed.id, JSON.stringify(parsed)],
    )
    await this.recordActivity(parsed.runId, 'backend', 'result_recorded', {
      workflowNodeId: parsed.workflowNodeId,
      result: parsed.result,
    }, parsed.id, owner?.client)
  }

  async getAcceptedResult(executionId: string, owner?: RunOwnership): Promise<ExecutionResult | undefined> {
    const current = await this.getExecution(executionId, owner)
    if (!current) return undefined
    if (await this.executionSemantics(current.runId, owner) === 3) {
      return this.repeatRead(current.runId, owner, (sql, snapshot) => readRepeatAcceptedResultLocked(sql, snapshot, executionId))
    }
    owner?.assertOwned()
    const result = await (owner?.client ?? this.pool).query<{ record: unknown }>(
      'select record from harness_executions where id = $1 and accepted = true',
      [executionId],
    )
    const execution = result.rows[0] ? HarnessExecutionSchema.parse(result.rows[0].record) : undefined
    return execution?.result
  }

  async appendNativeEvent(event: HarnessNativeEvent, owner?: RunOwnership, lease?: WorkflowNativeLease,
    approval?: WorkflowApprovalCorrelation, continuation?: WorkflowContinuationProof): Promise<void> {
    const original = HarnessNativeEventSchema.parse(structuredClone(event))
    const current = await this.getExecution(original.executionId, owner)
    if (!current) throw new DomainError('EXECUTION_NOT_FOUND', 'The native source execution is missing.', 404)
    if (await this.executionSemantics(current.runId, owner) === 3) {
      this.requireOwner(current.runId, owner)
      // The raw writer also requires the captured generation/session/source
      // guard. The existing v2 ingester cannot confer that authority on v3.
      // Do not append, normalize a terminal into this event, advance its cursor,
      // or report acknowledgement until the real occurrence-qualified native
      // event/lease/command publisher is supplied by its owning lane.
      throw new DomainError('REPEAT_NATIVE_GRAPH_PUBLICATION_REQUIRED',
        'The exact v3 native lifetime/source publication adapter is not composed; the original source has not been consumed.', 409)
    }
    owner?.assertOwned()
    if (owner && lease && await this.isOneShot(owner.runId, owner)) {
      await appendWorkflowNativeGraphEvent(owner, original, lease, approval, continuation)
      return
    }
    await appendNativeEvent(owner?.client ?? this.pool, original)
  }

  async getExecution(executionId: string, owner?: RunOwnership): Promise<HarnessExecution | undefined> {
    owner?.assertOwned()
    const result = await (owner?.client ?? this.pool).query<{ record: unknown; run_id: string }>(
      'select record,run_id from harness_executions where id=$1', [executionId])
    const row = result.rows[0]
    if (!row) return undefined
    this.assertOwnerScope(row.run_id, owner)
    const execution = HarnessExecutionSchema.parse(row.record)
    if (execution.id !== executionId || execution.runId !== row.run_id) throw new DomainError('EXECUTION_OCCURRENCE_CONFLICT', 'The execution physical identity differs from its record.', 409)
    if (await this.executionSemantics(row.run_id, owner) === 3) {
      return this.repeatRead(row.run_id, owner, async (sql, snapshot) => (await readRepeatExecutionLocked(sql, snapshot, executionId)).execution)
    }
    return execution
  }

  async getExecutionConfiguration(configurationVersionId: string) {
    return this.workflows.getAgentConfiguration(configurationVersionId)
  }

  async listExecutions(runId: string): Promise<HarnessExecution[]> {
    if (await this.executionSemantics(runId) === 3) throw new DomainError('REPEAT_PAGED_READ_REQUIRED', 'Use the bounded exact v3 execution reader, not the legacy whole-Run list.', 409)
    const result = await this.pool.query<{ record: unknown }>(
      'select record from harness_executions where run_id = $1 order by created_at, id',
      [runId],
    )
    return result.rows.map((row) => HarnessExecutionSchema.parse(row.record))
  }

  async recordActivity(
    runId: string,
    source: ActivitySource,
    kind: ActivityKind,
    payload: Record<string, unknown>,
    harnessExecutionId?: string,
    client?: pg.ClientBase,
  ): Promise<RunActivity> {
    if (await this.readSemantics(runId, undefined, client) === 3) throw new DomainError('REPEAT_ACTIVITY_PUBLICATION_REQUIRED', 'V3 activity must be composed with its exact canonical source.', 409)
    if (harnessExecutionId) {
      const execution = await (client ?? this.pool).query<{ run_id: string }>(
        'select run_id from harness_executions where id=$1', [harnessExecutionId])
      if (execution.rows[0]?.run_id !== runId) throw new DomainError('EXECUTION_OCCURRENCE_CONFLICT', 'Activity cannot refer to another Run execution.', 409)
    }
    const occurredAt = new Date().toISOString()
    const result = await (client ?? this.pool).query<{ sequence: string }>(
      `insert into run_activity (run_id, source, kind, harness_execution_id, occurred_at, payload)
       values ($1, $2, $3, $4, $5, $6::jsonb) returning sequence::text`,
      [runId, source, kind, harnessExecutionId ?? null, occurredAt, JSON.stringify(payload)],
    )
    return RunActivitySchema.parse({
      id: `activity-${runId}-${result.rows[0]?.sequence}`,
      runId,
      sequence: Number(result.rows[0]?.sequence),
      source,
      kind,
      ...(harnessExecutionId ? { harnessExecutionId } : {}),
      occurredAt,
      payload,
    })
  }

  async listActivity(runId: string): Promise<RunActivity[]> {
    await this.executionSemantics(runId)
    const result = await this.pool.query<{
      sequence: string
      source: ActivitySource
      kind: ActivityKind
      harness_execution_id: string | null
      occurred_at: Date
      payload: Record<string, unknown>
    }>(
      `select sequence::text, source, kind, harness_execution_id, occurred_at, payload
       from run_activity where run_id = $1 order by sequence`,
      [runId],
    )
    return result.rows.map((row) => RunActivitySchema.parse({
      id: `activity-${runId}-${row.sequence}`,
      runId,
      sequence: Number(row.sequence),
      source: row.source,
      kind: row.kind,
      ...(row.harness_execution_id ? { harnessExecutionId: row.harness_execution_id } : {}),
      occurredAt: row.occurred_at.toISOString(),
      payload: row.payload,
    }))
  }

  async getDetails(workspaceId: string, runId: string): ReturnType<typeof readRunDetails> {
    if (await this.executionSemantics(runId) === 3) throw new DomainError('REPEAT_DETAIL_READER_REQUIRED', 'Use the occurrence-qualified v3 detail reader registered by graph composition.', 409)
    return readRunDetails(this.pool, workspaceId, runId)
  }

  async listSummaries(workspaceId: string): Promise<WorkflowRunSummary[]> {
    const result = await this.pool.query<{ id: string; record: unknown; cleanup_pending: boolean }>(
      `select r.id,r.record,exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending
       from runs r where r.workspace_id=$1 and (r.execution_state<>'completed'
         or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
         or r.id in (select recent.id from runs recent where recent.workspace_id=$1 order by recent.created_at desc,recent.id desc limit 20))
       order by r.created_at desc,r.id desc`, [workspaceId],
    )
    const summaries: WorkflowRunSummary[] = []
    for (const row of result.rows) {
      const run = await this.readRunRecord(row.record, row.id)
      summaries.push({
        id: run.id,
        workspaceId: run.workspaceId,
        workflowId: run.workflowId,
        executionCondition: run.executionCondition,
        executionState: run.executionState,
        outcome: run.outcome,
        authRequired: false,
        browserWait: null,
        cleanupPending: row.cleanup_pending,
        ...(run.stopCause ? { stopCause: run.stopCause } : {}),
        runnerHealth: { status: 'healthy', checkedAt: new Date().toISOString() },
        ...(run.startedAt ? { startedAt: run.startedAt } : {}),
        ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      })
    }
    return summaries
  }
}
