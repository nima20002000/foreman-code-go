import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema } from '@foreman-code/contracts/wave25'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { agent3Database, candidateFor, postgresEnabled } from './helpers/wave25Agent3.js'
import { currentRepositoryFixture } from './helpers/wave25CurrentRepository.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'

async function database<T>(perform: (pool: pg.Pool) => Promise<T>, beforeMigration?: (pool: pg.Pool) => Promise<void>): Promise<T> {
  if (!beforeMigration) {
    const db = await agent3Database()
    try { return await perform(db.pool) } finally { await db.close() }
  }
  const connectionString = process.env.TEST_DATABASE_URL!
  const schema = `pr8_upgrade_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString })
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  try { await beforeMigration(pool); await applyApplicationMigrations(pool); return await perform(pool) }
  finally { await pool.end(); await dropFixtureSchema(admin, schema); await admin.end() }
}
afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('PR8 current PostgreSQL atomicity, recovery and upgrades', () => {
  it('atomically schedules one current occurrence and event, rolls back failed publication, and retries exactly once', async () => {
    const db = await agent3Database()
    try {
      const f = await currentRepositoryFixture(db)
      const owner = (await f.repository.acquireOwnership(f.f.run.id, () => undefined))!
      try {
        await db.pool.query(`create function reject_schedule() returns trigger language plpgsql as $$
          begin if NEW.effect_kind='input.bind' then raise exception 'injected graph publication failure'; end if; return NEW; end $$;
          create trigger fail_schedule before insert on run_graph_effects for each row execute function reject_schedule()`)
        const admit = () => f.repository.admitRepeatExecution({ nodeId: f.f.version.entryNodeId, occurrence: null }, () => candidateFor(f.f), owner)
        await expect(admit()).rejects.toThrow('injected graph publication failure')
        expect((await db.pool.query('select id from harness_executions where run_id=$1', [f.f.run.id])).rows).toHaveLength(0)
        expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='input.bind'", [f.f.run.id])).rows).toHaveLength(0)
        await db.pool.query('drop trigger fail_schedule on run_graph_effects')
        const first = await admit(), replay = await admit()
        expect(replay).toEqual({ ...first, reused: true })
        expect((await db.pool.query('select id from harness_executions where run_id=$1', [f.f.run.id])).rows).toHaveLength(1)
        expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='input.bind'", [f.f.run.id])).rows).toHaveLength(1)
      } finally { await owner.release() }
    } finally { await db.close() }
  }, 60000)

  it('rejects conflicting interaction scope and fabricated delivery transitions, then recovers the actual native delivery', async () => {
    const f = await checkpointRuntimeFixture()
    try {
      await f.engine.start(f.f.run.id)
      const [interaction] = await f.pending()
      for (const field of ['workspaceId', 'workflowId', 'runId', 'executionId', 'requestingAgentId'] as const) {
        await expect(f.repository.create({ ...interaction!, id: randomUUID(), [field]: `different-${field}` })).rejects.toThrow()
      }
      await expect(f.repository.updateDelivery(interaction!.id, interaction!.revision, 'delivered')).rejects.toThrow()
      expect(await f.repository.get(interaction!.id)).toMatchObject({ status: 'pending', deliveryState: 'not_started' })
      const result = await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(interaction!))
      expect(result.interaction.deliveryState).toBe('delivered')
      expect(f.provider.counts.responses).toBe(1)
      expect((await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(interaction!))).replayed).toBe(true)
      expect(f.provider.counts.responses).toBe(1)
    } finally { await f.close() }
  }, 60000)

  it('rejects invalid review leases without mutation, recovers expired ownership, and fences the old owner', async () => {
    const f = await routedApprovalFixture()
    try {
      const before = (await f.db.pool.query('select revision,record from review_jobs where id=$1', [f.job.id])).rows
      for (const [owner, token, expiry] of [['', 'token', '2099-01-01T00:00:00Z'], ['owner', '', '2099-01-01T00:00:00Z'],
        ['owner', 'token', 'invalid'], ['owner', 'token', '2000-01-01T00:00:00Z']]) {
        await expect(f.coordination.claimReviewJob(f.job.id, owner!, token!, expiry!)).rejects.toThrow()
      }
      expect((await f.db.pool.query('select revision,record from review_jobs where id=$1', [f.job.id])).rows).toEqual(before)
      const expiry = new Date(Date.now() + 60000).toISOString()
      const first = await f.coordination.claimReviewJob(f.job.id, 'old', 'old-token', expiry)
      await f.db.pool.query("update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) where id=$1", [f.job.id])
      const next = await f.coordination.claimReviewJob(f.job.id, 'new', 'new-token', expiry)
      expect(next.attempt).toBe(first.attempt + 1)
      await expect(f.coordination.transitionReviewJob(f.job.id, 'old-token', 'failed', { error: { code: 'TEST', message: 'test' } }))
        .rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
      expect(await f.coordination.findReviewJob(f.interaction.id, f.reviewerId)).toMatchObject({ leaseOwner: 'new', leaseToken: 'new-token' })
    } finally { await f.close() }
  }, 60000)
  it('copies stored Operator defaults, hashes accepted normalized data and rolls writes back with failed receipts', async () => database(async (pool) => {
    const defaults = new PostgresFoundationSettingsRepository(pool)
    const templates = structuredClone(DEFAULT_AGENT_DEFAULTS)
    templates.operator.harness = { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'operator-first' }
    await defaults.updateAgentDefaults(templates, 0)
    const operators = new PostgresOperatorRepository(pool)
    const first = await operators.ensure()
    expect(first.configuration.harness.model).toBe('operator-first')
    templates.operator.harness.model = 'operator-later'
    await defaults.updateAgentDefaults(templates, 1)
    expect((await operators.ensure()).configuration).toEqual(first.configuration)
    const raw = { ...DEFAULT_HARNESS_DEFAULTS.codex, model: '  normalized-model  ' }
    const accepted = await operators.update(raw, first.configuration.id)
    const equivalent = Object.fromEntries(Object.entries({ ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'normalized-model' }).reverse()) as typeof raw
    const normalized = await operators.update(equivalent, accepted.configuration.id)
    expect(normalized.configuration.contentHash).toBe(accepted.configuration.contentHash)
    expect(normalized.configuration.harness.model).toBe('normalized-model')
    const access = new PostgresAccessService(pool)
    const { principal } = await access.issue({ name:'owner', audience:'operator', grants:[], expiresAt:new Date(Date.now()+60_000) })
    const commands = new PostgresCommandCoordinator(pool)
    await pool.query(`create function reject_receipt() returns trigger language plpgsql as $$
      begin raise exception 'injected receipt failure'; end $$;
      create trigger fail_receipt before insert on management_command_receipts for each row execute function reject_receipt()`)
    const command = {
      principal, source:'http' as const, operation:'foundation.update', commandId:randomUUID(), targetKey:'settings', payload:{},
      perform: async (client: pg.PoolClient) => ({
        defaults:await defaults.updateWorkflowDefaults({ approvalHandler:'user' },0,client),
        operator:await operators.update({ ...DEFAULT_HARNESS_DEFAULTS.codex, model:'receipt-model' },normalized.configuration.id,client),
      }),
    }
    await expect(commands.execute(command)).rejects.toThrow('injected receipt failure')
    expect((await defaults.getWorkflowDefaults()).revision).toBe(0)
    expect((await operators.ensure()).configuration.id).toBe(normalized.configuration.id)
    expect((await pool.query('select * from management_command_receipts')).rowCount).toBe(0)
    await pool.query('drop trigger fail_receipt on management_command_receipts')
    const saved = await commands.execute(command)
    expect(saved.replayed).toBe(false)
    const replayed = await commands.execute(command)
    expect(replayed).toEqual({ ...saved,replayed:true })
    expect((await defaults.getWorkflowDefaults()).revision).toBe(1)
  }), 30_000)

  it('returns a controlled authentication error for a genuine pre-migration worker row', async () => {
    const token = 'old-worker-token'
    await database(async (pool) => {
      const access = new PostgresAccessService(pool)
      await expect(access.authenticate(token,'worker')).rejects.toMatchObject({ code:'AUTH_WORKER_SUBJECT_REQUIRED',status:401 })
      expect((await pool.query("select agent_id from management_principals where id='old-worker'")).rows[0].agent_id).toBeNull()
    }, async (pool) => {
      await pool.query(`create table management_principals (
        id text primary key,name text not null,audience text not null,token_hash text not null unique,
        grants jsonb not null,expires_at timestamptz not null,revoked_at timestamptz,created_at timestamptz not null default now())`)
      await pool.query(`insert into management_principals(id,name,audience,token_hash,grants,expires_at)
        values('old-worker','Old worker','worker',$1,'[]'::jsonb,now()+interval '1 hour')`,[createHash('sha256').update(token).digest('hex')])
    })
  }, 30_000)})

describe.skipIf(!postgresEnabled).each(['http', 'mcp'] as const)('PR8 current managed %s acceptance', (source) => {
  it('validates approval on Save, pins it on real Start and preserves persisted configuration versions', async () => {
    const f = await currentOperatorIntegration()
    try {
      const location = await f.locations.set(f.writer.principal, source, { workspaceId: f.f.scope.workspaceId,
        runnerId: f.f.run.executionLocation!.runnerId, rootPath: f.db.directory,
        expectedLocationRevision: 1, commandId: randomUUID() })
      const input = { ...await f.create(), expectedLocationRevision: location.value.locationRevision }
      async function save(value: typeof input) {
        if (source === 'mcp') {
          const response = await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: value })
          if (response.isError) throw new Error(JSON.stringify(decodeMcpToolResult(response)))
          return CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(response))
        }
        const response = await f.app.inject({ method: 'PUT', url: `/api/management/workspaces/${value.workspaceId}/workflows/${value.workflowId}/definition`,
          headers: { authorization: `Bearer ${f.writer.token}` }, payload: value })
        if (response.statusCode !== 200) throw new Error(response.body)
        return CurrentWorkflowSaveResultSchema.parse(response.json())
      }
      await expect(save({ ...input, graph: { ...input.graph, approval: { handler: 'orchestrator' } as never } })).rejects.toThrow()
      expect((await f.db.pool.query('select id from workflow_versions where workflow_id=$1', [input.workflowId])).rows).toHaveLength(0)
      const saved = await save({ ...input, commandId: randomUUID() })
      const start = { workspaceId: input.workspaceId, workflowId: input.workflowId, workflowVersionId: saved.value.currentVersionId,
        executionSemanticsVersion: 3, expectedWorkflowRevision: saved.value.revision,
        expectedLocationRevision: location.value.locationRevision,
        expectedAgentConfigurationVersionIds: saved.value.version.agentConfigurationVersionIds, commandId: randomUUID(), input: {} }
      let run: { id: string }
      if (source === 'mcp') {
        const result = await f.client.callTool({ name: 'run_start', arguments: start })
        expect(result.isError, JSON.stringify(decodeMcpToolResult(result))).not.toBe(true)
        run = (decodeMcpToolResult(result) as { run: { id: string } }).run
      } else {
        const result = await f.app.inject({ method: 'POST', url: `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/runs`,
          headers: { authorization: `Bearer ${f.writer.token}` }, payload: start })
        expect(result.statusCode, result.body).toBe(202); run = result.json().run
      }
      await expect.poll(async () => (await f.runs.get(run.id))?.executionState, { timeout: 20000 }).toBe('waiting')
      expect(await f.runs.get(run.id)).toMatchObject({ approval: saved.value.version.approval,
        workflowVersionId: saved.value.currentVersionId, agentConfigurationVersionIds: input.expectedAgentConfigurationVersionIds })
      const configured = (await f.db.pool.query('select record from agent_configuration_versions where id=any($1::text[])', [Object.values(input.expectedAgentConfigurationVersionIds)])).rows.map((row) => row.record)
      expect(configured).toEqual(expect.arrayContaining(f.f.configurations))
      expect(f.dispatchErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
