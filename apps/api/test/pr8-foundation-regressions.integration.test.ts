import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, DurableInteractionSchema,
  HarnessExecutionSchema, NativeSessionLaneSchema, NATIVE_INTERACTION_FIXTURES,
  ReviewJobSchema, WorkflowRunSchema,
  type WorkflowDefinition,
} from '@graphql/contracts'
import {
  GraphDraftSchema, GraphSaveCommandResultSchema, ManagementActionSchema, ManagementHarnessConfigurationSchema,
  RunStartResultSchema, type GraphDraftOperation,
} from '@graphql/contracts/management'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { GraphDraftService } from '../src/modules/graph-drafts/service.js'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import { NativeHarnessConfigurationQualifier } from '../src/modules/harnesses/nativeConfigurationQualifier.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import type { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { AgentManagementService } from '../src/modules/workspaces/agents.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'
const now = '2026-09-16T00:00:00.000Z'

async function database<T>(perform: (pool: pg.Pool) => Promise<T>, beforeMigration?: (pool: pg.Pool) => Promise<void>): Promise<T> {
  const schema = `pr8_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString })
  let pool: pg.Pool | undefined
  try {
    await admin.query(`create schema "${schema}"`)
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 6, connectionTimeoutMillis: 5000 })
    await beforeMigration?.(pool)
    await applyApplicationMigrations(pool)
    return await perform(pool)
  } finally {
    await pool?.end()
    await admin.query(`drop schema if exists "${schema}" cascade`)
    await admin.end()
  }
}

async function acceptedOccurrence(pool: pg.Pool) {
  await ensureAcceptanceSeed(pool)
  const run = WorkflowRunSchema.parse({
    id: 'run-pr8', workspaceId: 'workspace-1', workflowId: 'workflow-content-pipeline',
    workflowVersionId: 'workflow-content-pipeline-v1',
    agentConfigurationVersionIds: { 'agent-reviewer': 'agent-reviewer-config-v1' },
    approval: { handler: 'user' }, executionCondition: { kind: 'manual' },
    executionState: 'waiting', outcome: 'pending', input: {}, createdAt: now,
  })
  await pool.query(`insert into runs (id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
    values ($1,$2,$3,$4,$5,$6::jsonb)`, [run.id,run.workspaceId,run.workflowId,run.workflowVersionId,run.executionState,JSON.stringify(run)])
  const execution = HarnessExecutionSchema.parse({
    id: 'execution-pr8', runId: run.id, workflowNodeId: 'node-reviewer', agentId: 'agent-reviewer',
    agentConfigurationVersionId: 'agent-reviewer-config-v1', attempt: 1, input: {}, state: 'waiting', createdAt: now,
  })
  const runs = new PostgresRunRepository(pool, new PostgresWorkflowRepository(pool), {} as WorkspaceLocationService)
  const interaction = DurableInteractionSchema.parse({
    ...NATIVE_INTERACTION_FIXTURES.codex, id: 'interaction-pr8',
    workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    executionId: execution.id, requestingAgentId: execution.agentId, approval: run.approval,
  })
  return { run, execution, runs, interaction }
}

describe('PR8 PostgreSQL atomicity, recovery and upgrades', () => {
  it('atomically creates one occurrence and scheduling event, including failure, retry and external transaction rollback', async () => database(async (pool) => {
    const { runs, execution } = await acceptedOccurrence(pool)
    await pool.query(`create function reject_schedule() returns trigger language plpgsql as $$
      begin if NEW.kind='node_scheduled' then raise exception 'injected activity failure'; end if; return NEW; end $$;
      create trigger fail_schedule before insert on run_activity for each row execute function reject_schedule()`)
    await expect(runs.ensureExecution(execution)).rejects.toThrow('injected activity failure')
    expect((await pool.query('select * from harness_executions')).rowCount).toBe(0)
    await pool.query('drop trigger fail_schedule on run_activity')
    const outcomes = await Promise.all([
      runs.ensureExecution(execution), runs.ensureExecution({ ...execution, id: 'competing-execution' }),
    ])
    expect(outcomes.map((item) => item.created).sort()).toEqual([false, true])
    expect((await pool.query('select * from harness_executions')).rowCount).toBe(1)
    expect((await pool.query("select * from run_activity where kind='node_scheduled'")).rowCount).toBe(1)
    const owner = await runs.acquireOwnership(execution.runId, () => undefined)
    expect(owner).toBeDefined()
    try {
      await owner!.client.query('begin')
      await runs.ensureExecution({ ...execution, id: 'rolled-back-execution', attempt: 2 }, owner!)
      await owner!.client.query('rollback')
      expect((await pool.query("select * from harness_executions where id='rolled-back-execution'")).rowCount).toBe(0)
      expect((await pool.query("select * from run_activity where harness_execution_id='rolled-back-execution'")).rowCount).toBe(0)
    } finally { await owner?.release() }
  }), 30_000)

  it('rejects every conflicting scope and enforces decision/delivery transitions and scoped recovery', async () => database(async (pool) => {
    const { runs, execution, interaction } = await acceptedOccurrence(pool)
    await runs.ensureExecution(execution)
    const repository = new PostgresInteractionRepository(pool)
    await repository.create(interaction)
    for (const field of ['workspaceId','workflowId','runId','executionId','requestingAgentId'] as const) {
      await expect(repository.create({ ...interaction, id: `duplicate-${field}`, [field]: `different-${field}` })).rejects.toThrow()
    }
    expect((await repository.create({ ...interaction, id: 'valid-replay' })).created).toBe(false)
    await expect(repository.updateDelivery(interaction.id, 0, 'delivered')).rejects.toMatchObject({ code: 'DELIVERY_TRANSITION_INVALID' })
    expect((await repository.get(interaction.id))!.revision).toBe(0)
    const decision = { id: interaction.id, expectedRevision: 0, optionId: 'codex-approve-once', nativeResponse: { decision: 'accept' } }
    const decided = await repository.decide(decision)
    const query = { workspaceId: interaction.workspaceId, limit: 50, mode: 'send' as const }
    expect((await repository.listRecoverableDeliveries(query)).map((item) => item.id)).toEqual([interaction.id])
    expect(await repository.listRecoverableDeliveries({ ...query, workspaceId: 'other-workspace' })).toEqual([])
    const submitted = await repository.updateDelivery(interaction.id, decided.interaction.revision, 'submitted')
    expect(await repository.listRecoverableDeliveries(query)).toEqual([])
    expect((await repository.listRecoverableDeliveries({ ...query, mode: 'reconcile' })).map((item) => item.id)).toEqual([interaction.id])
    const uncertain = await repository.updateDelivery(interaction.id, submitted.revision, 'uncertain')
    await expect(repository.updateDelivery(interaction.id, uncertain.revision, 'submitted')).rejects.toThrow()
    const retriable = await repository.reconcileDelivery(interaction.id, uncertain.revision, 'not_delivered')
    expect((await repository.listRecoverableDeliveries(query))).toHaveLength(1)
    const resubmitted = await repository.updateDelivery(interaction.id, retriable.revision, 'submitted')
    const delivered = await repository.updateDelivery(interaction.id, resubmitted.revision, 'delivered')
    await expect(repository.updateDelivery(interaction.id, delivered.revision, 'submitted')).rejects.toThrow()
    expect(await repository.listRecoverableDeliveries({ ...query, mode: 'reconcile' })).toEqual([])
    expect((await repository.get(interaction.id))!.deliveredAt).toBe(delivered.deliveredAt)
    // Recovery after a failed/ambiguous send must not silently redispatch.
    const next = await repository.create({ ...interaction, id: 'interaction-second', nativeRequestId: 'second-request' })
    const chosen = await repository.decide({ ...decision, id: next.interaction.id })
    const failed = await repository.updateDelivery(chosen.interaction.id, chosen.interaction.revision, 'failed')
    expect((await repository.listRecoverableDeliveries({ ...query, mode: 'reconcile' })).map((item) => item.id)).toEqual([failed.id])
    expect(await repository.listRecoverableDeliveries({ ...query, mode: 'reconcile', afterId: failed.id })).toEqual([])
  }), 30_000)

  it('recovers only expired unsubmitted jobs, fences old owners and leaves invalid claims unchanged', async () => database(async (pool) => {
    const { runs, execution, interaction } = await acceptedOccurrence(pool)
    await runs.ensureExecution(execution)
    await new PostgresInteractionRepository(pool).create(interaction)
    const coordination = new PostgresInteractionCoordinationRepository(pool)
    await coordination.ensureReviewJob(ReviewJobSchema.parse({
      id: 'job', interactionId: interaction.id, reviewerAgentId: 'agent-reviewer', attempt: 0,
      state: 'pending', provider: 'codex', nativeSessionId: 'session', correlationId: 'job-correlation', createdAt: now, updatedAt: now,
    }))
    await coordination.ensureLane(NativeSessionLaneSchema.parse({
      id: 'lane', harness: 'codex', nativeSessionId: 'session', ownerAgentId: 'agent-reviewer',
      observedStatus: 'idle', connectionGeneration: 0, observedAt: now, revision: 0,
    }))
    const beforeJob = (await pool.query('select revision,record from review_jobs')).rows
    const beforeLane = (await pool.query('select revision,record from native_session_lanes')).rows
    for (const [owner,token,expiry] of [
      ['', 'token', '2099-01-01T00:00:00.000Z'], ['owner', '', '2099-01-01T00:00:00.000Z'],
      ['owner', 'token', 'invalid'], ['owner', 'token', '2000-01-01T00:00:00.000Z'],
    ]) {
      await expect(coordination.claimReviewJob('job', owner!, token!, expiry!)).rejects.toThrow()
      await expect(coordination.claimLane('lane', 0, owner!, token!, expiry!, 'correlation')).rejects.toThrow()
    }
    expect((await pool.query('select revision,record from review_jobs')).rows).toEqual(beforeJob)
    expect((await pool.query('select revision,record from native_session_lanes')).rows).toEqual(beforeLane)
    const future = new Date(Date.now() + 60_000).toISOString()
    const first = await coordination.claimReviewJob('job', 'old', 'old-token', future)
    await pool.query(`update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) where id='job'`)
    const next = await coordination.claimReviewJob('job', 'new', 'new-token', future)
    expect(next.attempt).toBe(first.attempt + 1)
    await expect(coordination.updateReviewJob({ id:'job', owner:'old', token:'old-token', attempt:first.attempt, state:'submitted' }))
      .rejects.toMatchObject({ code:'REVIEW_JOB_LEASE_LOST' })
    await coordination.updateReviewJob({ id:'job', owner:'new', token:'new-token', attempt:next.attempt, state:'submitted' })
    await pool.query(`update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) where id='job'`)
    const recovered = await coordination.claimReviewJob('job','third','third-token',future)
    expect(recovered).toMatchObject({ state:'submitted', attempt:next.attempt + 1, leaseOwner:'third', leaseToken:'third-token' })
    const lane = await coordination.claimLane('lane',0,'owner','token',future,'correlation')
    expect(lane.revision).toBe(1)
    await expect(coordination.claimLane('lane',0,'other','other-token',future,'next')).rejects.toMatchObject({ code:'SESSION_LANE_BUSY' })
  }), 30_000)

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
  }, 30_000)
})

// These exercise the actual registered HTTP routes and MCP transport. Only native
// engine execution is replaced; Save/Start, auth, receipts and PostgreSQL are real.
describe.each(['http', 'mcp'] as const)('PR8 managed %s acceptance', (source) => {
  it('validates approval on Save, pins it on Start, and round-trips template/custom configurations', async () => database(async (pool) => {
    const commands = new PostgresCommandCoordinator(pool)
    const access = new PostgresAccessService(pool)
    const { principal, token } = await access.issue({
      name:'PR8 operator', audience:'operator', grants:[{ actions:ManagementActionSchema.options,scope:{} }],
      expiresAt:new Date(Date.now()+3_600_000),
    })
    const runtimeDirectory = await mkdtemp(join(tmpdir(),'graphql-pr8-runtime-'))
    const workspaceDirectory = await mkdtemp(join(tmpdir(),'graphql-pr8-workspace-'))
    const locations = new WorkspaceLocationService(pool,commands,runtimeDirectory)
    const workflows = new PostgresWorkflowRepository(pool)
    const runs = new PostgresRunRepository(pool,workflows,locations)
    const engine = { start:vi.fn(async () => undefined), cancel:vi.fn(async () => false) } as unknown as LangGraphWorkflowEngine
    const settings = new PostgresSettingsRepository(pool)
    const services = {
      commands, locations,
      workspaces:new WorkspaceManagementService(pool,commands,locations),
      workflows:new WorkflowManagementService(pool,commands), agents:new AgentManagementService(pool),
      drafts:new GraphDraftService(pool,commands),
      harnesses:new HarnessCatalogService(new NativeHarnessConfigurationQualifier('/unused-native-engine', '/unused-native-engine'),settings,commands,runtimeDirectory),
      runs:new RunManagementService(pool,commands,runs,engine,locations),
    }
    const app = buildApp({
      readiness:{ database:{ ping:async () => { await pool.query('select 1') } },checkpoints:{ ping:async () => undefined } },
      operator:{ access,services },
    })
    const client = new Client({ name:'pr8-regressions',version:'1.0.0' })
    let connected = false
    try {
      const address = await app.listen({ host:'127.0.0.1',port:0 })
      if (source === 'mcp') {
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator',address),{ authProvider:{ token:async () => token } }))
        connected = true
      }
      async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
        if (source === 'mcp') {
          const result = await client.callTool({ name,arguments:args })
          if (result.isError) throw new Error(JSON.stringify(result.structuredContent ?? result.content))
          return result.structuredContent
        }
        const workflowPath = `/api/management/workspaces/${String(args.workspaceId)}/workflows`
        const draftPath = `${workflowPath}/${String(args.workflowId)}/drafts/${String(args.draftId)}`
        const route: Record<string,string> = {
          workflow_create:workflowPath, graph_draft_open:`${workflowPath}/${String(args.workflowId)}/drafts`,
          graph_draft_apply:`${draftPath}/operations`, graph_validate:`${draftPath}/validate`, graph_save:`${draftPath}/save`,
          run_start:`${workflowPath}/${String(args.workflowId)}/runs`,
        }
        const url = route[name]
        if (!url) throw new Error(`Missing test route ${name}`)
        const result = await app.inject({ method:'POST',url,payload:args,headers:{ authorization:`Bearer ${token}`,host:'localhost' } })
        if (result.statusCode >= 400) throw new Error(result.body)
        return result.json() as unknown
      }
      const { ManagedWorkflowCommandResultSchema, GraphDraftCommandResultSchema, WorkspaceLocationSetInputSchema } = await import('@graphql/contracts/management')
      const workspace = (await services.workspaces.create(principal,source,{ commandId:randomUUID(),name:'PR8' })).value.workspace
      const workspaceId = workspace.id
      await locations.set(principal,source,WorkspaceLocationSetInputSchema.parse({
        workspaceId,runnerId:'runner-local',rootPath:workspaceDirectory,expectedLocationRevision:0,commandId:randomUUID(),
      }))
      async function create(name: string) {
        const result = ManagedWorkflowCommandResultSchema.parse(await call('workflow_create',{ workspaceId,commandId:randomUUID(),name }))
        const workflowId = result.value.workflow.id
        const draft = GraphDraftSchema.parse(await call('graph_draft_open',{ workspaceId,workflowId }))
        return { workflow:result.value.workflow,draft }
      }
      async function apply(draft: ReturnType<typeof GraphDraftSchema.parse>,operations:GraphDraftOperation[]) {
        return GraphDraftCommandResultSchema.parse(await call('graph_draft_apply',{
          workspaceId,workflowId:draft.workflowId,draftId:draft.id,commandId:randomUUID(),expectedRevision:draft.revision,operations,
        })).value.draft
      }
      async function save(draft: ReturnType<typeof GraphDraftSchema.parse>) {
        return GraphSaveCommandResultSchema.parse(await call('graph_save',{
          workspaceId,workflowId:draft.workflowId,draftId:draft.id,commandId:randomUUID(),expectedRevision:draft.revision,
        })).value
      }
      const templates = new PostgresFoundationSettingsRepository(pool)
      const firstDefaults = await templates.updateWorkflowDefaults({ approvalHandler:'orchestrator' },0)
      const cases = [
        ['missing','WORKFLOW_APPROVAL_INCOMPLETE'], ['wrong-workflow','APPROVAL_ORCHESTRATOR_WRONG_WORKFLOW'],
        ['missing-coder','APPROVAL_DISTINCT_CODER_REQUIRED'], ['auto-review','WORKFLOW_HARNESS_APPROVAL_CONFLICT'],
      ] as const
      for (const [scenario,code] of cases) {
        const initial = await create(scenario)
        expect(initial.workflow.approval).toEqual({ handler:'orchestrator' })
        const orchestrator = `orchestrator-${randomUUID()}`
        const coder = `coder-${randomUUID()}`
        const operations:GraphDraftOperation[] = [
          { type:'agent.add_from_template',template:'orchestrator',agentId:orchestrator,nodeId:'first',name:'Orchestrator' },
          { type:'agent.add_from_template',template:scenario === 'missing-coder' ? 'orchestrator':'coder',agentId:coder,nodeId:'second',name:'Coder' },
          { type:'edge.connect',edgeId:'handoff',sourceNodeId:'first',targetNodeId:'second' },
        ]
        if (scenario !== 'missing') operations.push({ type:'workflow.set_approval',approval:{
          handler:'orchestrator',designatedOrchestratorAgentId:scenario === 'wrong-workflow' ? 'other-workflow-agent':orchestrator,
        } })
        if (scenario === 'auto-review') {
          const configuration = structuredClone(DEFAULT_HARNESS_DEFAULTS.codex)
          configuration.advanced!.approvalsReviewer = 'auto_review'
          operations.push({ type:'agent.configure',agentId:coder,expectedAgentRevision:0,configuration })
        }
        const draft = await apply(initial.draft,operations)
        const validation = await call('graph_validate',{ workspaceId,workflowId:draft.workflowId,draftId:draft.id })
        expect(validation).toMatchObject({ valid:false,issues:[{ code }] })
        await expect(save(draft)).rejects.toThrow(code)
        expect((await pool.query('select id from workflow_versions where workflow_id=$1',[draft.workflowId])).rowCount).toBe(0)
      }
      const initial = await create('Valid approval')
      const orchestrator = `orchestrator-${randomUUID()}`
      const coder = `coder-${randomUUID()}`
      const draft = await apply(initial.draft,[
        { type:'agent.add_from_template',template:'orchestrator',agentId:orchestrator,nodeId:'first',name:'Orchestrator' },
        { type:'agent.add_from_template',template:'coder',agentId:coder,nodeId:'second',name:'Coder' },
        { type:'edge.connect',edgeId:'handoff',sourceNodeId:'first',targetNodeId:'second' },
        { type:'workflow.set_approval',approval:{ handler:'orchestrator',designatedOrchestratorAgentId:orchestrator } },
      ])
      const published = await save(draft)
      const expectedApproval = { handler:'orchestrator',designatedOrchestratorAgentId:orchestrator }
      expect(published.version.approval).toEqual(expectedApproval)
      const started = RunStartResultSchema.parse(await call('run_start',{
        workspaceId,workflowId:draft.workflowId,workflowVersionId:published.version.id,
        draftId:published.draft.id,expectedDraftRevision:published.draft.revision,
        expectedLocationRevision:1,commandId:randomUUID(),input:{},
      }))
      expect(started.run.approval).toEqual(expectedApproval)
      // A configured persisted version missing its top-level acceptance is never legacy.
      await pool.query("update workflow_versions set record=record-'approval' where id=$1",[published.version.id])
      await expect(call('run_start',{
        workspaceId,workflowId:draft.workflowId,workflowVersionId:published.version.id,
        expectedLocationRevision:1,commandId:randomUUID(),input:{},
      })).rejects.toThrow('WORKFLOW_APPROVAL_SNAPSHOT_INVALID')
      await pool.query('update workflow_versions set record=$2::jsonb where id=$1',[published.version.id,JSON.stringify(published.version)])
      const changed = await apply(published.draft,[{ type:'workflow.set_approval',approval:{ handler:'user' } }])
      await save(changed)
      await templates.updateWorkflowDefaults({ approvalHandler:'operator' },firstDefaults.revision)
      expect((await runs.getForWorkspace(workspaceId,started.run.id))!.approval).toEqual(expectedApproval)
      expect((await create('Later workflow')).workflow.approval).toEqual({ handler:'operator' })
      // The direct repository save also preserves approval when an old client omits it.
      const current = (await services.workflows.get(principal,workspaceId,draft.workflowId)).workflow
      const omitted:WorkflowDefinition = { ...current,approval:undefined }
      expect((await workflows.save(workspaceId,omitted)).approval).toEqual({ handler:'user' })

      const agentDefaults = await templates.getAgentDefaults()
      const exact = structuredClone(agentDefaults.value)
      exact.coder.harness = { ...DEFAULT_HARNESS_DEFAULTS.opencode,variant:'provider-custom-effort' }
      await templates.updateAgentDefaults(exact,agentDefaults.revision)
      const customWorkflow = await create('Custom provider')
      const customId = `custom-${randomUUID()}`
      let customDraft = await apply(customWorkflow.draft,[
        { type:'agent.add',agentId:customId,nodeId:'custom',name:'Custom',harness:'opencode' },
        { type:'workflow.set_approval',approval:{ handler:'user' } },
      ])
      expect(customDraft.stagedAgents[0]!.agent.harnessConfiguration).toMatchObject({ variant:'provider-custom-effort' })
      expect(customDraft.stagedAgents[0]!.agent.effort).toBeUndefined()
      let customSaved = await save(customDraft)
      const fetched = await services.agents.get(principal,workspaceId,customId)
      expect(fetched.agent.harnessConfiguration).toMatchObject({ variant:'provider-custom-effort' })
      const cloneId = `clone-${randomUUID()}`
      customDraft = await apply(customSaved.draft,[
        { type:'agent.rename',agentId:customId,name:'Renamed',expectedAgentRevision:fetched.metadataRevision },
        { type:'agent.configure',agentId:customId,configuration:ManagementHarnessConfigurationSchema.parse(exact.coder.harness),expectedAgentRevision:fetched.metadataRevision },
        { type:'agent.clone',sourceAgentId:customId,agentId:cloneId,nodeId:'clone',name:'Clone' },
        { type:'edge.connect',edgeId:'custom-handoff',sourceNodeId:'custom',targetNodeId:'clone' },
        { type:'workflow.set_execution_limits',maxParallelism:2,maxNodeExecutions:2 },
      ])
      customSaved = await save(customDraft)
      expect(customSaved.agents.map((item) => item.agent.harnessConfiguration)).toEqual([
        expect.objectContaining({ variant:'provider-custom-effort' }),expect.objectContaining({ variant:'provider-custom-effort' }),
      ])
      exact.coder.harness = { ...exact.coder.harness,variant:'later-template-variant' }
      await templates.updateAgentDefaults(exact,agentDefaults.revision+1)
      expect((await services.agents.get(principal,workspaceId,customId)).agent.harnessConfiguration).toMatchObject({ variant:'provider-custom-effort' })
      const later = await create('Later agent')
      const laterDraft = await apply(later.draft,[{ type:'agent.add_from_template',template:'coder',agentId:`later-${randomUUID()}`,nodeId:'later',name:'Later' }])
      expect(laterDraft.stagedAgents[0]!.agent.harnessConfiguration).toMatchObject({ variant:'later-template-variant' })
    } finally {
      if (connected) await client.close()
      await app.close()
      await Promise.all([
        rm(runtimeDirectory,{ recursive:true,force:true }),
        rm(workspaceDirectory,{ recursive:true,force:true }),
      ])
    }
  }), 60_000)
})
