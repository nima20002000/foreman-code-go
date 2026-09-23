import { randomUUID } from 'node:crypto'

import {
  HarnessExecutionSchema,
  RunActivitySchema,
  WorkflowRunSchema,
  type ActivityKind,
  type ActivitySource,
  type ExecutionResult,
  type GetRunResponse,
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
import type { RunRepository, RunStateUpdate } from './port.js'
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

export class PostgresRunRepository implements RunRepository {
  private readonly oneShotStores = new WeakMap<RunOwnership, OneShotRunRepository>()
  constructor(
    private readonly pool: pg.Pool,
    private readonly workflows: PostgresWorkflowRepository,
    private readonly locations: WorkspaceLocationService,
  ) {}

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
    owner?.assertOwned()
    if (owner?.runId !== undefined && owner.runId !== runId) throw new DomainError('GRAPH_SCOPE_MISMATCH', 'Run ownership cannot cross Run identities.', 409)
    const result = await (owner?.client ?? this.pool).query<{ semantics: string | null }>(
      "select record->>'executionSemanticsVersion' as semantics from runs where id=$1", [runId])
    const semantics = result.rows[0]?.semantics
    if (semantics !== undefined && semantics !== null && semantics !== '1' && semantics !== '2') {
      throw new DomainError('EXECUTION_SEMANTICS_UNSUPPORTED', 'Unknown execution semantics cannot use the legacy engine.', 409)
    }
    return semantics === '2'
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
    if (await this.isOneShot(runId)) await changeOneShotLifecycle(this.pool, runId, { kind: 'stop', ...(authorize ? { authorize } : {}) })
  }

  async hasRequestedStop(runId: string): Promise<boolean> {
    const row = await this.pool.query<{ stopped: boolean }>('select stop_requested_at is not null as stopped from runs where id=$1', [runId])
    return row.rows[0]?.stopped === true
  }

  async requestCleanup(runId: string, client?: pg.ClientBase): Promise<void> {
    if (await this.isOneShot(runId)) {
      if (client) throw new DomainError('GRAPH_TRANSACTION_CONTEXT_REQUIRED', 'Compose publishOneShotCleanup with the current G1 publication; raw-client nesting is forbidden.', 409)
      return changeOneShotLifecycle(this.pool, runId, { kind: 'cleanup', pending: true })
    }
    await (client ?? this.pool).query(`insert into run_cleanup_intents(run_id) values($1)
      on conflict(run_id) do update set pending=true,updated_at=now()`, [runId])
  }

  async hasPendingCleanup(runId: string, client?: Pick<pg.ClientBase, 'query'>): Promise<boolean> {
    const found = await (client ?? this.pool).query(
      'select 1 from run_cleanup_intents where run_id=$1 and pending', [runId])
    return found.rowCount === 1
  }

  async finishCleanup(runId: string, failed: boolean, client?: pg.ClientBase): Promise<void> {
    if (await this.isOneShot(runId)) {
      if (client) throw new DomainError('GRAPH_TRANSACTION_CONTEXT_REQUIRED', 'Compose publishOneShotCleanup with the current G1 publication; raw-client nesting is forbidden.', 409)
      return changeOneShotLifecycle(this.pool, runId, { kind: 'cleanup', pending: failed })
    }
    await (client ?? this.pool).query(`update run_cleanup_intents set pending=$2,attempts=attempts+1,
      last_error=$3,updated_at=now() where run_id=$1`,
    [runId, failed, failed ? 'Native closure or task draining remains unconfirmed; retry cleanup.' : null])
  }

  async reconciliationCandidates(): Promise<WorkflowRun[]> {
    const result = await this.pool.query<{ record: unknown }>(
      `select record from runs where execution_state in ('queued', 'running', 'waiting')
        or exists(select 1 from run_cleanup_intents c where c.run_id=runs.id and c.pending)
        order by created_at,id`,
    )
    return result.rows.map((row) => CompatibleWorkflowRunSchema.parse(row.record))
  }

  /** Read persisted active time on the ownership connection, excluding approval waits. */
  async remainingApprovalTime(runId: string, executionIds: string[], owner: RunOwnership): Promise<number> {
    owner.assertOwned()
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
    if (await this.isOneShot(runId, owner)) {
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
    if ('executionSemanticsVersion' in version && version.executionSemanticsVersion === 2) {
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

  async get(runId: string, owner?: RunOwnership): Promise<WorkflowRun | undefined> {
    owner?.assertOwned()
    if (owner?.runId !== undefined && owner.runId !== runId) throw new DomainError('GRAPH_SCOPE_MISMATCH', 'Run ownership cannot cross Run identities.', 409)
    const result = await (owner?.client ?? this.pool).query<{ record: unknown }>('select record from runs where id = $1', [runId])
    return result.rows[0] ? CompatibleWorkflowRunSchema.parse(result.rows[0].record) : undefined
  }

  async getForWorkspace(workspaceId: string, runId: string): Promise<WorkflowRun | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from runs where workspace_id = $1 and id = $2',
      [workspaceId, runId],
    )
    return result.rows[0] ? CompatibleWorkflowRunSchema.parse(result.rows[0].record) : undefined
  }

  async create(run: WorkflowRun, client?: pg.ClientBase): Promise<void> {
    if ('executionSemanticsVersion' in run && run.executionSemanticsVersion === 2) {
      assertWave25Admission()
      throw new DomainError('V2_ADMISSION_REQUIRED', 'Use insertOneShotRun inside the v2 admission transaction.', 409)
    }
    const parsed = WorkflowRunSchema.parse(run)
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
    if ('executionSemanticsVersion' in current && current.executionSemanticsVersion === 2) {
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
    if (await this.isOneShot(execution.runId, owner)) throw new DomainError('EXECUTION_ADMISSION_REQUIRED', 'Use transactional one-shot queue admission.', 409)
    owner?.assertOwned()
    const parsed = HarnessExecutionSchema.parse(execution)
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
    if (await this.isOneShot(execution.runId, owner)) {
      if (!owner) throw new DomainError('RUN_OWNERSHIP_REQUIRED', 'One-shot observation requires the Run owner.', 409)
      const current = await this.getExecution(execution.id, owner)
      if (!current || current.runId !== owner.runId || current.runId !== execution.runId
        || current.workflowNodeId !== execution.workflowNodeId || current.agentId !== execution.agentId
        || current.agentConfigurationVersionId !== execution.agentConfigurationVersionId || current.attempt !== 1) {
        throw new DomainError('EXECUTION_OCCURRENCE_CONFLICT', 'Observe only the exact already admitted one-shot execution.', 409)
      }
      return { execution: current, created: false }
    }
    owner?.assertOwned()
    const parsed = HarnessExecutionSchema.parse(execution)
    // One SQL statement is atomic on a pool lease AND on an owner's client.
    // It never begins/commits a transaction owned by the engine or its caller.
    const result = await (owner?.client ?? this.pool).query<{ record: unknown }>(
      `with occurrence as (
         insert into harness_executions (id, run_id, workflow_node_id, agent_id, attempt, record)
         values ($1,$2,$3,$4,$5,$6::jsonb)
         on conflict (run_id, workflow_node_id, attempt) do nothing returning record
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
      'select record from harness_executions where run_id=$1 and workflow_node_id=$2 and attempt=$3',
      [parsed.runId, parsed.workflowNodeId, parsed.attempt],
    )
    const current = HarnessExecutionSchema.parse(found.rows[0]?.record)
    if (current.agentId !== parsed.agentId || current.agentConfigurationVersionId !== parsed.agentConfigurationVersionId) {
      throw new DomainError('EXECUTION_OCCURRENCE_CONFLICT', 'This execution occurrence is already bound to different accepted configuration.', 409)
    }
    return { execution: current, created: false }
  }

  async updateExecution(execution: HarnessExecution, owner?: RunOwnership): Promise<void> {
    if (await this.isOneShot(execution.runId, owner)) {
      if (!owner) throw new DomainError('RUN_OWNERSHIP_REQUIRED', 'Native domain writes require the current Run owner.', 409)
      return this.oneShot(owner).updateExecution(execution)
    }
    owner?.assertOwned()
    const parsed = HarnessExecutionSchema.parse(execution)
    await (owner?.client ?? this.pool).query(
      'update harness_executions set record = $2::jsonb where id = $1',
      [parsed.id, JSON.stringify(parsed)],
    )
  }

  async acceptExecutionResult(execution: HarnessExecution, owner?: RunOwnership): Promise<void> {
    if (await this.isOneShot(execution.runId, owner)) {
      if (!owner) throw new DomainError('RUN_OWNERSHIP_REQUIRED', 'Result acceptance requires the current Run owner.', 409)
      await this.oneShot(owner).acceptTerminal(execution.id)
      return
    }
    owner?.assertOwned()
    const parsed = HarnessExecutionSchema.parse(execution)
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
    owner?.assertOwned()
    if (owner && lease && await this.isOneShot(owner.runId, owner)) {
      await appendWorkflowNativeGraphEvent(owner, event, lease, approval, continuation)
      return
    }
    await appendNativeEvent(owner?.client ?? this.pool, event)
  }

  async getExecution(executionId: string, owner?: RunOwnership): Promise<HarnessExecution | undefined> {
    owner?.assertOwned()
    const result = await (owner?.client ?? this.pool).query<{ record: unknown }>(
      'select record from harness_executions where id = $1',
      [executionId],
    )
    return result.rows[0] ? HarnessExecutionSchema.parse(result.rows[0].record) : undefined
  }

  async getExecutionConfiguration(configurationVersionId: string) {
    return this.workflows.getAgentConfiguration(configurationVersionId)
  }

  async listExecutions(runId: string): Promise<HarnessExecution[]> {
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

  async getDetails(workspaceId: string, runId: string): Promise<GetRunResponse | undefined> {
    return readRunDetails(this.pool, workspaceId, runId)
  }

  async listSummaries(workspaceId: string): Promise<WorkflowRunSummary[]> {
    const result = await this.pool.query<{ record: unknown; cleanup_pending: boolean }>(
      `select r.record,exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending
       from runs r where r.workspace_id=$1 and (r.execution_state<>'completed'
         or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
         or r.id in (select recent.id from runs recent where recent.workspace_id=$1 order by recent.created_at desc,recent.id desc limit 20))
       order by r.created_at desc,r.id desc`, [workspaceId],
    )
    return result.rows.map((row) => {
      const run = CompatibleWorkflowRunSchema.parse(row.record)
      return {
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
      }
    })
  }
}
