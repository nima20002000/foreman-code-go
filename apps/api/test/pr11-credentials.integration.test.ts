import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { HarnessExecutionSchema, NATIVE_INTERACTION_FIXTURES, WorkflowRunSchema } from '@graphql/contracts'
import pg from 'pg'
import { describe, it } from 'vitest'

import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { WorkerCredentialService, type IssuedWorkerCredential } from '../src/modules/access/workerCredentials.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'
const token = (credential: IssuedWorkerCredential) => credential.environment.variables.GRAPHQL_APP_MCP_TOKEN!

async function database(perform: (pool: pg.Pool) => Promise<void>) {
  const schema = `pr11_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema} -c statement_timeout=10000` })
  try {
    await applyApplicationMigrations(pool)
    await ensureAcceptanceSeed(pool)
    await perform(pool)
  } finally {
    await pool.end()
    await admin.query(`drop schema "${schema}" cascade`)
    await admin.end()
  }
}

async function identities(pool: pg.Pool) {
  const suffix = randomUUID()
  const run = WorkflowRunSchema.parse({
    id: `run-pr11-${suffix}`, workspaceId: 'workspace-1', workflowId: 'workflow-content-pipeline', workflowVersionId: 'workflow-content-pipeline-v1',
    agentConfigurationVersionIds: { 'agent-developer': 'agent-developer-config-v1', 'agent-reviewer': 'agent-reviewer-config-v1' },
    approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-reviewer' },
    executionCondition: { kind: 'manual' }, executionState: 'waiting', outcome: 'pending', input: {}, createdAt: new Date().toISOString(),
  })
  await pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record) values($1,$2,$3,$4,$5,$6::jsonb)`,
    [run.id, run.workspaceId, run.workflowId, run.workflowVersionId, run.executionState, JSON.stringify(run)])
  const executions = await Promise.all(['developer', 'reviewer'].map(async (role) => {
    const execution = HarnessExecutionSchema.parse({
      id: `execution-${role}-${suffix}`, runId: run.id, workflowNodeId: `node-${role}`, agentId: `agent-${role}`,
      agentConfigurationVersionId: `agent-${role}-config-v1`, attempt: 1, input: {}, state: 'starting', createdAt: new Date().toISOString(),
    })
    await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record) values($1,$2,$3,$4,1,false,$5::jsonb)`,
      [execution.id, run.id, execution.workflowNodeId, execution.agentId, JSON.stringify(execution)])
    return execution
  }))
  const access = new PostgresAccessService(pool)
  const credentials = new WorkerCredentialService(pool, access)
  const interactions = new PostgresInteractionRepository(pool)
  const interaction = (await interactions.create({
    ...NATIVE_INTERACTION_FIXTURES.codex, id: `interaction-${suffix}`, workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    executionId: executions[0]!.id, requestingAgentId: executions[0]!.agentId, nativeSessionId: `session-${suffix}`, nativeRequestId: `request-${suffix}`, approval: run.approval!,
  })).interaction
  return { run, coder: executions[0]!, reviewer: executions[1]!, access, credentials, interactions, interaction }
}

async function assertNoActiveCredentials(pool: pg.Pool, runId: string) {
  const result = await pool.query<{ count: number }>(`select count(*)::int as count from worker_credential_bindings b join management_principals p on p.id=b.principal_id where b.run_id=$1 and (b.revoked_at is null or p.revoked_at is null)`, [runId])
  assert.equal(result.rows[0]!.count, 0)
}

describe('PR #11 real PostgreSQL lifecycle and decisions', () => {
  it('serializes issuance versus Stop and prevents all later issuance', async () => {
    await database(async (pool) => {
      const f = await identities(pool)
      await f.credentials.issueForExecution(f.coder.id)
      const blocker = await pool.connect()
      try {
        await blocker.query('begin')
        await blocker.query('select id from runs where id=$1 for update', [f.run.id])
        const attempts = Promise.allSettled([
          f.credentials.issueForExecution(f.coder.id), f.credentials.revokeForRun(f.run.id),
          f.credentials.issueForExecution(f.reviewer.id),
        ])
        await blocker.query('commit')
        await attempts
      } finally { await blocker.query('rollback').catch(() => undefined); blocker.release() }
      await assertNoActiveCredentials(pool, f.run.id)
      await assert.rejects(f.credentials.issueForExecution(f.coder.id), { code: 'WORKER_EXECUTION_INACTIVE' })
    })
  }, 30_000)

  it('uses consistent completion and execution-wide revocation locking with multiple tokens', async () => {
    await database(async (pool) => {
      const f = await identities(pool)
      const [left, right] = await Promise.all([f.credentials.issueForExecution(f.coder.id), f.credentials.issueForExecution(f.coder.id)])
      await Promise.all([f.credentials.revoke(left), f.credentials.revokeForExecution(f.coder.id), f.credentials.revoke(right)])
      await assertNoActiveCredentials(pool, f.run.id)
      assert.equal(await f.credentials.revokeForExecution(f.coder.id), 0)
      await assert.rejects(f.access.authenticate(token(right), 'worker'), { code: 'AUTH_REVOKED' })
    })
  }, 30_000)

  it('recovers terminal credentials without the old token variable and rejects them during cleanup outages', async () => {
    await database(async (pool) => {
      const f = await identities(pool)
      const issued = await f.credentials.issueForExecution(f.coder.id)
      const completed = HarnessExecutionSchema.parse({ ...f.coder, state: 'completed', result: { outcome: 'succeeded' }, finishedAt: new Date().toISOString() })
      await pool.query('update harness_executions set record=$2::jsonb where id=$1', [f.coder.id, JSON.stringify(completed)])
      await assert.rejects(f.access.authenticate(token(issued), 'worker'), { code: 'AUTH_REVOKED' })
      await assert.rejects(f.credentials.issueForExecution(f.coder.id), { code: 'WORKER_EXECUTION_INACTIVE' })
      class TemporaryFailure extends WorkerCredentialService {
        override async revokeForExecution(): Promise<number> { throw new Error('temporary cleanup outage') }
      }
      await assert.rejects(new TemporaryFailure(pool, f.access).reconcileTerminalCredentials(), /temporary cleanup outage/)
      await new WorkerCredentialService(pool, f.access).reconcileTerminalCredentials()
      await assertNoActiveCredentials(pool, f.run.id)
      const completedRun = WorkflowRunSchema.parse({ ...f.run, executionState: 'completed', outcome: 'canceled', result: { outcome: 'canceled' }, finishedAt: new Date().toISOString() })
      await pool.query("update runs set execution_state='completed',record=$2::jsonb where id=$1", [f.run.id, JSON.stringify(completedRun)])
      await assert.rejects(f.credentials.issueForExecution(f.reviewer.id), { code: 'WORKER_EXECUTION_INACTIVE' })
    })
  }, 30_000)

  it('heals old binding-revoked/principal-active inconsistencies', async () => {
    await database(async (pool) => {
      const f = await identities(pool)
      const issued = await f.credentials.issueForExecution(f.coder.id)
      await pool.query('update worker_credential_bindings set revoked_at=now() where principal_id=$1', [issued.principalId])
      await assert.rejects(f.access.authenticate(token(issued), 'worker'), { code: 'AUTH_REVOKED' })
      assert.equal(await f.credentials.revokeForExecution(f.coder.id), 1)
      await assertNoActiveCredentials(pool, f.run.id)
    })
  }, 30_000)

  it('rolls back decisions when success auditing fails, and audits denied/invalid attempts', async () => {
    await database(async (pool) => {
      const f = await identities(pool)
      const reviewerCredential = await f.credentials.issueForExecution(f.reviewer.id)
      const reviewer = await f.access.authenticate(token(reviewerCredential), 'worker')
      class AuditFailure extends PostgresCommandCoordinator {
        override async recordAudit(...args: Parameters<PostgresCommandCoordinator['recordAudit']>): Promise<void> {
          if (args[4] === 'succeeded') throw new Error('audit write failed')
          return super.recordAudit(...args)
        }
      }
      const input = { interactionId: f.interaction.id, optionId: f.interaction.responseOptions[0]!.optionId, expectedRevision: 0 }
      await assert.rejects(new PostgresAppInteractionService(pool, f.interactions, new AuditFailure(pool)).respond(reviewer, input), /audit write failed/)
      assert.equal((await f.interactions.get(f.interaction.id))?.status, 'pending')
      const service = new PostgresAppInteractionService(pool, f.interactions, new PostgresCommandCoordinator(pool))
      const coder = await f.access.authenticate(token(await f.credentials.issueForExecution(f.coder.id)), 'worker')
      await assert.rejects(service.respond(coder, input), { code: 'INTERACTION_NOT_FOUND' })
      await assert.rejects(service.respond(reviewer, { ...input, optionId: 'unknown-option' }), { code: 'INTERACTION_OPTION_INVALID' })
      const audit = await pool.query<{ outcome: string; target_key: string }>("select outcome,target_key from management_audit where action='interaction_respond'")
      assert(audit.rows.some((row) => row.outcome === 'denied' && row.target_key === 'interaction:requested'))
      assert(audit.rows.some((row) => row.outcome === 'failed'))
      const decided = await service.respond(reviewer, input)
      assert.equal(decided.interaction.status, 'delivery_pending')
      assert.equal((await pool.query("select count(*)::int as count from management_audit where outcome='succeeded' and action='interaction_respond'")).rows[0].count, 1)
    })
  }, 30_000)

  it('prevents a previously authenticated principal from deciding after Stop commits', async () => {
    await database(async (pool) => {
      const f = await identities(pool)
      const principal = await f.access.authenticate(token(await f.credentials.issueForExecution(f.reviewer.id)), 'worker')
      const stop = await pool.connect()
      try {
        await stop.query('begin')
        await f.credentials.revokeForRun(f.run.id, stop)
        const service = new PostgresAppInteractionService(pool, f.interactions, new PostgresCommandCoordinator(pool))
        const pending = service.respond(principal, { interactionId: f.interaction.id, optionId: f.interaction.responseOptions[0]!.optionId, expectedRevision: 0 })
        const rejected = assert.rejects(pending, { code: 'AUTH_REVOKED' })
        await stop.query('commit')
        await rejected
        assert.equal((await f.interactions.get(f.interaction.id))?.status, 'pending')
      } finally { await stop.query('rollback').catch(() => undefined); stop.release() }
    })
  }, 30_000)

  it('allows an already-committing decision to finish before Stop returns, never after it', async () => {
    await database(async (pool) => {
      const f = await identities(pool)
      const principal = await f.access.authenticate(token(await f.credentials.issueForExecution(f.reviewer.id)), 'worker')
      let unblock!: () => void
      let reached!: () => void
      const gated = new Promise<void>((resolve) => { unblock = resolve })
      const ready = new Promise<void>((resolve) => { reached = resolve })
      const decision = f.interactions.decide({ id: f.interaction.id, optionId: f.interaction.responseOptions[0]!.optionId, expectedRevision: 0, nativeResponse: null, principal,
        beforeCommit: async () => { reached(); await gated },
      })
      await ready
      let stopped = false
      const stop = f.credentials.revokeForRun(f.run.id).then(() => { stopped = true })
      await new Promise((resolve) => setTimeout(resolve, 25))
      assert.equal(stopped, false)
      unblock()
      assert.equal((await decision).interaction.status, 'delivery_pending')
      await stop
      assert.equal(stopped, true)
      await assertNoActiveCredentials(pool, f.run.id)
    })
  }, 30_000)
})
