import { randomUUID } from 'node:crypto'

import {
  GetRunResponseSchema,
  HarnessExecutionSchema,
  HarnessNativeEventSchema,
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

export class PostgresRunRepository implements RunRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly workflows: PostgresWorkflowRepository,
  ) {}

  async createForWorkflow(workspaceId: string, workflowId: string, input: RunInput): Promise<WorkflowRun> {
    const version = await this.workflows.getCurrentVersion(workspaceId, workflowId)
    if (!version) {
      throw new DomainError('WORKFLOW_NOT_FOUND', `Workflow '${workflowId}' was not found.`, 404)
    }
    const now = new Date().toISOString()
    const run = WorkflowRunSchema.parse({
      id: `run-${randomUUID()}`,
      workspaceId,
      workflowId,
      workflowVersionId: version.id,
      agentConfigurationVersionIds: version.agentConfigurationVersionIds,
      executionCondition: version.definition.executionCondition,
      executionState: 'queued',
      outcome: 'pending',
      input,
      createdAt: now,
    })
    await this.create(run)
    await this.recordActivity(run.id, 'backend', 'run_state_changed', { executionState: 'queued' })
    return run
  }

  async get(runId: string): Promise<WorkflowRun | undefined> {
    const result = await this.pool.query<{ record: unknown }>('select record from runs where id = $1', [runId])
    return result.rows[0] ? WorkflowRunSchema.parse(result.rows[0].record) : undefined
  }

  async getForWorkspace(workspaceId: string, runId: string): Promise<WorkflowRun | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from runs where workspace_id = $1 and id = $2',
      [workspaceId, runId],
    )
    return result.rows[0] ? WorkflowRunSchema.parse(result.rows[0].record) : undefined
  }

  async create(run: WorkflowRun): Promise<void> {
    const parsed = WorkflowRunSchema.parse(run)
    await this.pool.query(
      `insert into runs (id, workspace_id, workflow_id, workflow_version_id, execution_state, record)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [parsed.id, parsed.workspaceId, parsed.workflowId, parsed.workflowVersionId, parsed.executionState, JSON.stringify(parsed)],
    )
  }

  async updateState(runId: string, update: RunStateUpdate): Promise<void> {
    const current = await this.get(runId)
    if (!current) throw new DomainError('RUN_NOT_FOUND', `Run '${runId}' was not found.`, 404)
    const next = WorkflowRunSchema.parse({ ...current, ...update })
    await this.pool.query(
      'update runs set execution_state = $2, record = $3::jsonb where id = $1',
      [runId, next.executionState, JSON.stringify(next)],
    )
    await this.recordActivity(runId, 'backend', 'run_state_changed', {
      executionState: next.executionState,
      outcome: next.outcome,
    })
  }

  async createExecution(execution: HarnessExecution): Promise<void> {
    const parsed = HarnessExecutionSchema.parse(execution)
    await this.pool.query(
      `insert into harness_executions (id, run_id, workflow_node_id, agent_id, attempt, record)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [parsed.id, parsed.runId, parsed.workflowNodeId, parsed.agentId, parsed.attempt, JSON.stringify(parsed)],
    )
    await this.recordActivity(parsed.runId, 'langgraph', 'node_scheduled', {
      workflowNodeId: parsed.workflowNodeId,
      agentId: parsed.agentId,
      attempt: parsed.attempt,
    }, parsed.id)
  }

  async updateExecution(execution: HarnessExecution): Promise<void> {
    const parsed = HarnessExecutionSchema.parse(execution)
    await this.pool.query(
      'update harness_executions set record = $2::jsonb where id = $1',
      [parsed.id, JSON.stringify(parsed)],
    )
  }

  async acceptExecutionResult(execution: HarnessExecution): Promise<void> {
    const parsed = HarnessExecutionSchema.parse(execution)
    if (parsed.state !== 'completed' || parsed.result?.outcome !== 'succeeded') {
      throw new DomainError('EXECUTION_RESULT_NOT_ACCEPTABLE', 'Only a successful completed execution can be accepted.', 409)
    }
    await this.pool.query(
      'update harness_executions set accepted = true, record = $2::jsonb where id = $1',
      [parsed.id, JSON.stringify(parsed)],
    )
    await this.recordActivity(parsed.runId, 'backend', 'result_recorded', {
      workflowNodeId: parsed.workflowNodeId,
      result: parsed.result,
    }, parsed.id)
  }

  async getAcceptedResult(executionId: string): Promise<ExecutionResult | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from harness_executions where id = $1 and accepted = true',
      [executionId],
    )
    const execution = result.rows[0] ? HarnessExecutionSchema.parse(result.rows[0].record) : undefined
    return execution?.result
  }

  async appendNativeEvent(event: HarnessNativeEvent): Promise<void> {
    const parsed = HarnessNativeEventSchema.parse(event)
    await this.pool.query(
      `insert into harness_native_events (execution_id, sequence, record)
       values ($1, $2, $3::jsonb)`,
      [parsed.executionId, parsed.sequence, JSON.stringify(parsed)],
    )
    const execution = await this.getExecution(parsed.executionId)
    if (execution) {
      await this.recordActivity(execution.runId, 'harness', 'harness_output', {
        nativeEventSequence: parsed.sequence,
        nativeEventType: parsed.type,
      }, parsed.executionId)
    }
  }

  async getExecution(executionId: string): Promise<HarnessExecution | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from harness_executions where id = $1',
      [executionId],
    )
    return result.rows[0] ? HarnessExecutionSchema.parse(result.rows[0].record) : undefined
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
  ): Promise<RunActivity> {
    const occurredAt = new Date().toISOString()
    const result = await this.pool.query<{ sequence: string }>(
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
