import { randomUUID } from 'node:crypto'

import {
  GetRunResponseSchema,
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

import { DomainError } from '../errors.js'
import type { RunRepository, RunStateUpdate } from './port.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import { RunOwnership } from './ownership.js'
import { appendNativeEvent } from './nativeEvents.js'
import { validateExecutableTopology } from './topology.js'
import { requiredLocationAccess, type WorkspaceLocationService } from '../workspaces/location.js'

export class PostgresRunRepository implements RunRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly workflows: PostgresWorkflowRepository,
    private readonly locations: WorkspaceLocationService,
  ) {}

  acquireOwnership(runId: string, onLost: () => void): Promise<RunOwnership | undefined> {
    return RunOwnership.acquire(this.pool, runId, onLost)
  }

  async reconciliationCandidates(): Promise<WorkflowRun[]> {
    const result = await this.pool.query<{ record: unknown }>(
      "select record from runs where execution_state in ('queued', 'running', 'waiting') order by created_at, id",
    )
    return result.rows.map((row) => WorkflowRunSchema.parse(row.record))
  }

  /** Called only while holding database ownership; never modifies another live owner. */
  async settleOrphan(runId: string, owner: RunOwnership, canceled: boolean): Promise<boolean> {
    owner.assertOwned()
    const client = owner.client
    try {
      await client.query('begin')
      const found = await client.query<{ record: unknown }>('select record from runs where id = $1 for update', [runId])
      const current = found.rows[0] ? WorkflowRunSchema.parse(found.rows[0].record) : undefined
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
    validateExecutableTopology(version)
    await this.workflows.assertCurrentConfigurations(version)
    // Recovery must not launch a run whose creation transaction failed.
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`admission:workspace:${workspaceId}`])
      const configurations = await Promise.all(Object.values(version.agentConfigurationVersionIds).map(async (id) => {
        const configuration = await this.workflows.getAgentConfiguration(id)
        if (!configuration) throw new DomainError('AGENT_CONFIGURATION_NOT_FOUND', `Configuration '${id}' was not found.`, 409)
        return configuration
      }))
      const executionLocation = await this.locations.snapshot(
        client, workspaceId, expectedLocationRevision, requiredLocationAccess(configurations),
      )
      const run = WorkflowRunSchema.parse({
        id: `run-${randomUUID()}`, workspaceId, workflowId, workflowVersionId: version.id,
        agentConfigurationVersionIds: version.agentConfigurationVersionIds,
        ...(version.approval ? { approval: version.approval } : {}),
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
    const result = await (owner?.client ?? this.pool).query<{ record: unknown }>('select record from runs where id = $1', [runId])
    return result.rows[0] ? WorkflowRunSchema.parse(result.rows[0].record) : undefined
  }

  async getForWorkspace(workspaceId: string, runId: string): Promise<WorkflowRun | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from runs where workspace_id = $1 and id = $2',
      [workspaceId, runId],
    )
    return result.rows[0] ? WorkflowRunSchema.parse(result.rows[0].record) : undefined
  }

  async create(run: WorkflowRun, client?: pg.ClientBase): Promise<void> {
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
    owner?.assertOwned()
    const parsed = HarnessExecutionSchema.parse(execution)
    const result = await (owner?.client ?? this.pool).query<{ record: unknown }>(
      `insert into harness_executions (id, run_id, workflow_node_id, agent_id, attempt, record)
       values ($1,$2,$3,$4,$5,$6::jsonb)
       on conflict (run_id, workflow_node_id, attempt) do nothing returning record`,
      [parsed.id, parsed.runId, parsed.workflowNodeId, parsed.agentId, parsed.attempt, JSON.stringify(parsed)],
    )
    if (result.rows[0]) {
      await this.recordActivity(parsed.runId, 'langgraph', 'node_scheduled', {
        workflowNodeId: parsed.workflowNodeId, agentId: parsed.agentId, attempt: parsed.attempt,
      }, parsed.id, owner?.client)
      return { execution: parsed, created: true }
    }
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
    owner?.assertOwned()
    const parsed = HarnessExecutionSchema.parse(execution)
    await (owner?.client ?? this.pool).query(
      'update harness_executions set record = $2::jsonb where id = $1',
      [parsed.id, JSON.stringify(parsed)],
    )
  }

  async acceptExecutionResult(execution: HarnessExecution, owner?: RunOwnership): Promise<void> {
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

  async appendNativeEvent(event: HarnessNativeEvent, owner?: RunOwnership): Promise<void> {
    owner?.assertOwned()
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
    const run = await this.getForWorkspace(workspaceId, runId)
    if (!run) return undefined
    return GetRunResponseSchema.parse({
      run,
      executions: await this.listExecutions(runId),
      activity: await this.listActivity(runId),
    })
  }

  async listSummaries(workspaceId: string): Promise<WorkflowRunSummary[]> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from runs where workspace_id = $1 order by created_at desc limit 20',
      [workspaceId],
    )
    return result.rows.map((row) => {
      const run = WorkflowRunSchema.parse(row.record)
      return {
        id: run.id,
        workspaceId: run.workspaceId,
        workflowId: run.workflowId,
        executionCondition: run.executionCondition,
        executionState: run.executionState,
        outcome: run.outcome,
        authRequired: false,
        browserWait: null,
        runnerHealth: { status: 'healthy', checkedAt: new Date().toISOString() },
        ...(run.startedAt ? { startedAt: run.startedAt } : {}),
        ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      }
    })
  }
}
