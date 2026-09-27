import { randomUUID } from 'node:crypto'

import { HarnessExecutionSchema, WorkflowRunSchema, type HarnessExecution } from '@graphql/contracts'
import pg from 'pg'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { WorkerCredentialService } from '../src/modules/access/workerCredentials.js'
import { WorkerLaunchCredentialService } from '../src/modules/harnesses/mcpDetection.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_nim2601'
let schema: string
let admin: pg.Pool
let pool: pg.Pool
let execution: HarnessExecution
let access: PostgresAccessService
let credentials: WorkerCredentialService
let budgets: PostgresApprovalBudgetRepository

beforeEach(async () => {
  schema = `worker_budget_${randomUUID().replaceAll('-', '')}`
  admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  await applyApplicationMigrations(pool)
  await ensureAcceptanceSeed(pool)
  access = new PostgresAccessService(pool)
  credentials = new WorkerCredentialService(pool, access, 60_000)
  budgets = new PostgresApprovalBudgetRepository(pool)
  const createdAt = new Date().toISOString()
  const run = WorkflowRunSchema.parse({
    id: 'run-renewal', workspaceId: 'workspace-1', workflowId: 'workflow-content-pipeline',
    workflowVersionId: 'workflow-content-pipeline-v1', executionSemanticsVersion: 3,
    agentConfigurationVersionIds: { 'agent-researcher': 'agent-researcher-config-v1',
      'agent-developer': 'agent-developer-config-v1', 'agent-reviewer': 'agent-reviewer-config-v1' },
    approval: { handler: 'user' }, executionCondition: { kind: 'manual' },
    executionLocation: { runnerId: 'runner-test', rootPath: '/tmp/graphql-worker-budget-test', locationRevision: 1,
      identityHash: `sha256:${'1'.repeat(64)}` }, authorizationPrincipalId: 'operator-worker-budget-fixture',
    executionState: 'waiting', outcome: 'pending', input: {}, createdAt,
  })
  await pool.query(
    `insert into runs (id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
     values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [run.id, run.workspaceId, run.workflowId, run.workflowVersionId, run.executionState, JSON.stringify(run)],
  )
  execution = HarnessExecutionSchema.parse({
    id: 'execution-renewal', runId: run.id, workflowNodeId: 'node-developer', agentId: 'agent-developer',
    agentConfigurationVersionId: 'agent-developer-config-v1', attempt: 1, input: {}, state: 'starting', createdAt,
  })
  await pool.query(
    `insert into harness_executions (id,run_id,workflow_node_id,agent_id,attempt,accepted,record)
     values ($1,$2,$3,$4,$5,false,$6::jsonb)`,
    [execution.id, execution.runId, execution.workflowNodeId, execution.agentId, execution.attempt, JSON.stringify(execution)],
  )
  await budgets.ensure(execution.id, 'thread-renewal', 60_000)
  await budgets.beginWait(execution.id)
})

afterEach(async () => {
  await pool?.end()
  await admin?.query(`drop schema if exists "${schema}" cascade`)
  await admin?.end()
})

it('does not revive an expired scoped token', async () => {
  const issued = await credentials.issueForExecution(execution.id)
  await pool.query("update management_principals set expires_at=now()-interval '1 second' where id=$1", [issued.principalId])
  await expect(credentials.renewForExecution(execution.id, issued)).rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
})

for (const revokedTable of ['management_principals', 'worker_credential_bindings'] as const) {
  it(`cannot revive a credential revoked in ${revokedTable}`, async () => {
    const issued = await credentials.issueForExecution(execution.id)
    const key = revokedTable === 'management_principals' ? 'id' : 'principal_id'
    await pool.query(`update ${revokedTable} set revoked_at=now() where ${key}=$1`, [issued.principalId])
    await expect(credentials.renewForExecution(execution.id, issued)).rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
    expect((await pool.query('select expires_at from management_principals where id=$1', [issued.principalId])).rows[0].expires_at.toISOString()).toBe(issued.expiresAt)
  })
}

it('cannot renew a principal for a different execution or mismatched Agent binding', async () => {
  const issued = await credentials.issueForExecution(execution.id)
  await expect(credentials.renewForExecution('another-execution', issued)).rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
  await pool.query('update worker_credential_bindings set agent_id=$2 where principal_id=$1', [issued.principalId, 'agent-reviewer'])
  await expect(credentials.renewForExecution(execution.id, issued)).rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
})

it('cannot issue or renew credentials after Stop', async () => {
  const issued = await credentials.issueForExecution(execution.id)
  await budgets.stop(execution.id)
  await expect(credentials.renewForExecution(execution.id, issued)).rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
  await expect(credentials.issueForExecution(execution.id)).rejects.toMatchObject({ code: 'WORKER_EXECUTION_INACTIVE' })
})

it('cannot renew an exhausted active-time budget even while approval is waiting', async () => {
  const issued = await credentials.issueForExecution(execution.id)
  await pool.query('update approval_execution_state set active_elapsed_ms=active_timeout_ms where execution_id=$1', [execution.id])
  await expect(credentials.renewForExecution(execution.id, issued)).rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
})

it('cannot issue or renew credentials for a completed execution before cleanup catches up', async () => {
  const issued = await credentials.issueForExecution(execution.id)
  const completed = HarnessExecutionSchema.parse({ ...execution, state: 'completed', result: { outcome: 'succeeded' }, finishedAt: new Date().toISOString() })
  await pool.query('update harness_executions set record=$2::jsonb where id=$1', [execution.id, JSON.stringify(completed)])
  await expect(credentials.renewForExecution(execution.id, issued)).rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
  await expect(credentials.issueForExecution(execution.id)).rejects.toMatchObject({ code: 'WORKER_EXECUTION_INACTIVE' })
})

it('revokes a superseded token when a new process credential is prepared', async () => {
  const issued = await credentials.issueForExecution(execution.id)
  const launch = new WorkerLaunchCredentialService({ preflight: async () => ({}) } as never, credentials, 'runner-1', 30_000)
  const fresh = await launch.prepare({ executionId: execution.id, harness: 'opencode', workingDirectory: '/project' })
  expect(fresh.credential.principalId).not.toBe(issued.principalId)
  expect(fresh.credential.environment.agentId).toBe(issued.environment.agentId)
  await expect(access.authenticate(issued.environment.variables.GRAPHQL_MCP_TOKEN!, 'worker')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  expect((await access.authenticate(fresh.credential.environment.variables.GRAPHQL_MCP_TOKEN!, 'worker')).id).toBe(fresh.credential.principalId)
})

it('finalizes at the durable finish time exactly once and prevents later resume', async () => {
  await pool.query(
    `update approval_execution_state set active_elapsed_ms=1000,active_started_at=$2,
     approval_wait_started_at=null where execution_id=$1`, [execution.id, '2026-09-16T00:00:00.000Z'],
  )
  const finishedAt = '2026-09-16T00:00:03.000Z'
  const completed = HarnessExecutionSchema.parse({ ...execution, state: 'completed', result: { outcome: 'succeeded' }, finishedAt })
  await pool.query('update harness_executions set record=$2::jsonb where id=$1', [execution.id, JSON.stringify(completed)])
  await budgets.finish(execution.id, finishedAt)
  const read = async () => (await pool.query(
    `select active_elapsed_ms::text,active_started_at,approval_wait_started_at,stopped_at,revision::text
     from approval_execution_state where execution_id=$1`, [execution.id],
  )).rows[0]
  const first = await read()
  expect(first).toMatchObject({ active_elapsed_ms: '4000', active_started_at: null, approval_wait_started_at: null })
  expect(first.stopped_at).toBe(null)
  await budgets.finish(execution.id, '2026-09-16T02:00:00.000Z')
  expect(await read()).toEqual(first)
  await expect(budgets.resume(execution.id)).rejects.toMatchObject({ code: 'EXECUTION_STOPPED' })
  await expect(budgets.beginWait(execution.id)).rejects.toMatchObject({ code: 'EXECUTION_NOT_WAITABLE' })
  // The service checks this before returning an already-delivered decision on replay.
  await expect(budgets.assertActive(execution.id)).resolves.toBeUndefined()
  expect(await read()).toEqual(first)
  await budgets.stop(execution.id)
  await expect(budgets.assertActive(execution.id)).rejects.toMatchObject({ code: 'EXECUTION_STOPPED' })
})

it('does not add approval waiting time when finalizing a waiting execution', async () => {
  await pool.query(
    `update approval_execution_state set active_elapsed_ms=1234,active_started_at=null,
     approval_wait_started_at=now()-interval '2 hours' where execution_id=$1`, [execution.id],
  )
  await budgets.finish(execution.id)
  const row = (await pool.query(
    'select active_elapsed_ms::text,active_started_at,approval_wait_started_at from approval_execution_state where execution_id=$1', [execution.id],
  )).rows[0]
  expect(row).toEqual({ active_elapsed_ms: '1234', active_started_at: null, approval_wait_started_at: null })
})

it('does not subtract elapsed time when recovering a completion older than its budget row', async () => {
  await pool.query(
    `update approval_execution_state set active_elapsed_ms=1234,active_started_at=$2,
     approval_wait_started_at=null where execution_id=$1`, [execution.id, '2026-09-16T00:00:05.000Z'],
  )
  await budgets.finish(execution.id, '2026-09-16T00:00:03.000Z')
  expect((await pool.query('select active_elapsed_ms::text from approval_execution_state where execution_id=$1', [execution.id])).rows[0].active_elapsed_ms).toBe('1234')
})
