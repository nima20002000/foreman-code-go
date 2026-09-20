import { randomUUID } from 'node:crypto'
import { seedInteractionOwners } from './helpers/interactionOwners.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CODEX_APPROVAL_OPTIONS_FIXTURE,
  GetRunResponseSchema,
  AgentSchema,
  DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
  DurableInteractionSchema,
  NATIVE_INTERACTION_FIXTURES,
  NativeHarnessEventSchema,
  type HarnessExecutionRequest,
  type NativeHarnessEvent,
  type NativeSessionReference,
  type PendingNativeInteraction,
  type ApprovalResponseOption,
  type AgentConfigurationVersion,
} from '@graphql/contracts'
import pg from 'pg'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

import { buildApp } from '../src/app.js'
import { WorkerCredentialService } from '../src/modules/access/workerCredentials.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../src/modules/harnesses/port.js'
import type { NativeSessionStart } from '../src/modules/harnesses/port.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { InteractionService } from '../src/modules/interactions/service.js'
import { OperatorInteractionService } from '../src/modules/interactions/operator.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { ReviewerDispatcher } from '../src/modules/interactions/reviewer.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DeterministicNativeSessionManager } from '../src/testing/deterministicNativeSession.js'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_nim2601'
let schema: string
let root: string
let projectRoot: string
let admin: pg.Pool
let pool: pg.Pool
let checkpoints: ReturnType<typeof createCheckpointStore>
let engine: LangGraphWorkflowEngine
let app: FastifyInstance

class SelectiveNativeManager implements NativeHarnessSessionManager {
  readonly harness: 'codex' | 'opencode'
  readonly counters = { nodeEntries: 0, sessions: 0, attaches: 0, sideEffects: 0, deliveries: 0 }
  private readonly requests = new Map<string, HarnessExecutionRequest>()
  private readonly pendingRequests = new Map<string, PendingNativeInteraction>()
  private readonly terminal = new Map<string, NativeHistory['terminalResult']>()
  readonly startEnvironments = new Map<string, string | undefined>()
  readonly attachEnvironments: Array<string | undefined> = []

  constructor(private readonly pendingNodeIds = new Set(['approval-target']), harness: 'codex' | 'opencode' = 'codex') {
    this.harness = harness
  }

  async capabilities() { return { provider: this.harness, providerVersion: this.harness === 'codex' ? '0.154.0' : '1.18.31', persistentSessions: true, reconnect: true, sameRequestResponses: true, cancellation: true, history: true, configurationInspection: true, mcpDetection: true, supportedInteractionKinds: ['approval'] } }
  async inspectMcp() { return { harness: this.harness, serverName: 'graphql', state: 'connected' as const, endpointMatches: true, credentialEnvironmentVariable: null, checkedAt: new Date().toISOString() } }
  async createSession(input: NativeSessionStart): Promise<NativeSessionReference> {
    if (input.kind === 'operator') throw new Error('workflow fixture expected')
    this.counters.sessions += 1
    const session = { harness: this.harness, providerVersion: this.harness === 'codex' ? '0.154.0' : '1.18.31', nativeSessionId: `session-${input.request.workflowNodeId}` }
    this.requests.set(session.nativeSessionId, input.request)
    this.startEnvironments.set(session.nativeSessionId, input.environment?.variables.GRAPHQL_APP_MCP_TOKEN)
    return session
  }
  async attachSession(session: NativeSessionReference, input: NativeSessionStart) {
    if (input.kind === 'operator') throw new Error('workflow fixture expected')
    this.counters.attaches += 1
    this.requests.set(session.nativeSessionId, input.request)
    this.attachEnvironments.push(input.environment?.variables.GRAPHQL_APP_MCP_TOKEN)
    return session
  }
  async *startTurn(session: NativeSessionReference): AsyncIterable<NativeHarnessEvent> {
    this.counters.nodeEntries += 1
    this.counters.sideEffects += 1
    const request = this.requests.get(session.nativeSessionId)!
    if (this.pendingNodeIds.has(request.workflowNodeId)) {
      const pending: PendingNativeInteraction = {
        session, turn: { nativeTurnId: `turn-${request.workflowNodeId}`, nativeRequestId: `request-${request.workflowNodeId}` },
        nativeRequestType: 'item/commandExecution/requestApproval', request: { command: ['touch', 'proof'] },
        responseOptions: this.harness === 'codex' ? CODEX_APPROVAL_OPTIONS_FIXTURE : NATIVE_INTERACTION_FIXTURES.opencode.responseOptions,
      }
      this.pendingRequests.set(session.nativeSessionId, pending)
      yield NativeHarnessEventSchema.parse({ sequence: 0, type: 'interaction.pending', occurredAt: new Date().toISOString(), payload: {} })
      return
    }
    this.terminal.set(session.nativeSessionId, { outcome: 'succeeded', output: { node: request.workflowNodeId } })
    yield NativeHarnessEventSchema.parse({ sequence: 0, type: 'turn.completed', occurredAt: new Date().toISOString(), payload: {} })
  }
  async pending(session: NativeSessionReference) { return this.pendingRequests.get(session.nativeSessionId) }
  async respond(session: NativeSessionReference, nativeRequestId: string) {
    const pending = this.pendingRequests.get(session.nativeSessionId)
    if (pending?.turn.nativeRequestId !== nativeRequestId) throw new Error('wrong request')
    this.counters.deliveries += 1
    this.pendingRequests.delete(session.nativeSessionId)
    this.terminal.set(session.nativeSessionId, { outcome: 'succeeded', output: { approved: true } })
  }
  async cancel() { return true }
  async history(session: NativeSessionReference): Promise<NativeHistory> {
    const pendingInteraction = this.pendingRequests.get(session.nativeSessionId)
    const terminalResult = this.terminal.get(session.nativeSessionId)
    return { events: [], pendingInteractions: pendingInteraction ? [pendingInteraction] : [], ...(pendingInteraction ? { pendingInteraction } : {}), ...(terminalResult ? { terminalResult } : {}) }
  }
  async reconcile(session: NativeSessionReference, correlationId: string) {
    const history = await this.history(session)
    const request = this.requests.get(session.nativeSessionId)
    return { ...history, ...(request && correlationId === `execution:${request.executionId}` && history.terminalResult ? {
      terminalTurn: { correlationId, providerId: `turn-${request.workflowNodeId}`, result: history.terminalResult },
    } : {}) }
  }
  async close() {}
}

class ReviewNativeManager extends SelectiveNativeManager {
  reviewTurns = 0
  override async *startTurn(_session: NativeSessionReference): AsyncIterable<NativeHarnessEvent> {
    void _session
    this.reviewTurns += 1
    yield NativeHarnessEventSchema.parse({
      sequence: 0, type: 'turn.started', occurredAt: new Date().toISOString(), payload: { turnId: `review-turn-${this.reviewTurns}` },
    })
  }
}

class UncertainOnceNativeManager extends DeterministicNativeSessionManager {
  responseAttempts = 0
  override async respond(session: NativeSessionReference, nativeRequestId: string, option: ApprovalResponseOption) {
    this.responseAttempts += 1
    if (this.responseAttempts === 1) throw Object.assign(new Error('transport lost after write'), { certainty: 'uncertain' as const })
    return super.respond(session, nativeRequestId, option)
  }
}

class FailingAttachNativeManager extends SelectiveNativeManager {
  constructor(private readonly failAfterStart: boolean) { super(new Set(), 'codex') }
  override async attachSession(session: NativeSessionReference, input: NativeSessionStart) {
    const attached = await super.attachSession(session, input)
    if (this.failAfterStart) throw new Error('provider failed after process start')
    return attached
  }
}

beforeEach(async () => {
  schema = `approval_${randomUUID().replaceAll('-', '')}`
  root = await mkdtemp(join(tmpdir(), 'graphql-approval-runtime-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'graphql-approval-project-'))
  admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  await applyApplicationMigrations(pool)
  await ensureAcceptanceSeed(pool)
  checkpoints = createCheckpointStore(connectionString, `${schema}_checkpoints`)
  await checkpoints.setup()
  const details = await stat(projectRoot)
  await pool.query(`update workspaces set execution_location=$2::jsonb,execution_location_identity=$3::jsonb,location_revision=1 where id=$1`, [
    'workspace-1', JSON.stringify({ runnerId: 'runner-local', rootPath: await realpath(projectRoot) }),
    JSON.stringify({ device: String(details.dev), inode: String(details.ino) }),
  ])
})

afterEach(async () => {
  await app?.close()
  await engine?.shutdown()
  await checkpoints?.close()
  await pool?.end()
  await admin?.query(`drop schema if exists "${schema}" cascade`)
  await admin?.query(`drop schema if exists "${schema}_checkpoints" cascade`)
  await admin?.end()
  await rm(root, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

it('interrupts and resumes the same durable native execution without repeating predecessors or side effects', async () => {
  const workflows = new PostgresWorkflowRepository(pool)
  const saved = await workflows.get('workspace-1', 'workflow-content-pipeline')
  if (!saved) throw new Error('seed missing')
  await workflows.save('workspace-1', {
    ...saved,
    requiredAgentCount: 2,
    nodes: [
      { id: 'predecessor', agentId: 'agent-researcher', name: 'Predecessor' },
      { id: 'approval-target', agentId: 'agent-reviewer', name: 'Approval target' },
    ],
    edges: [{ id: 'edge-proof', source: 'predecessor', target: 'approval-target' }],
    approval: { handler: 'user' },
    executionPolicy: { maxParallelism: 1, maxNodeExecutions: 2 },
  })
  const locations = new WorkspaceLocationService(pool, new PostgresCommandCoordinator(pool), root)
  const runs = new PostgresRunRepository(pool, workflows, locations)
  const run = await runs.createForWorkflow('workspace-1', 'workflow-content-pipeline', {}, 1)
  const interactions = new PostgresInteractionRepository(pool)
  const budgets = new PostgresApprovalBudgetRepository(pool)
  const manager = new SelectiveNativeManager()
  const managerResolver = { resolve: () => ({ manager, processState: 'resident' as const }) }
  const approvalRuntime = new ApprovalExecutionCoordinator(runs, interactions, budgets, managerResolver, 10_000)
  engine = new LangGraphWorkflowEngine(
    runs, workflows, approvalRuntime, checkpoints.saver, root, locations, undefined, interactions,
  )
  const service = new InteractionService(interactions, budgets, approvalRuntime, (interaction) => engine.resumeInteraction(interaction))
  app = buildApp({
    readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    product: {
      workspaces: new PostgresWorkspaceRepository(pool, workflows, runs), workflows, runs,
      settings: new PostgresSettingsRepository(pool), engine, interactions: service,
    },
  })

  await engine.start(run.id)
  const waitingRun = await runs.get(run.id)
  if (waitingRun?.executionState !== 'waiting') throw new Error(JSON.stringify(waitingRun))
  const pending = (await interactions.list({ runId: run.id, limit: 10 }))[0]!
  expect(pending).toMatchObject({ nativeSessionId: 'session-approval-target', nativeRequestId: 'request-approval-target', status: 'pending' })
  expect(manager.counters).toEqual({ nodeEntries: 2, sessions: 2, attaches: 0, sideEffects: 2, deliveries: 0 })

  const anonymousList = await app.inject({ method: 'GET', url: '/api/interactions?limit=10' })
  expect(anonymousList.statusCode).toBe(401)
  const anonymousResponse = await app.inject({
    method: 'POST', url: `/api/interactions/${pending.id}/respond`,
    payload: { interactionId: pending.id, optionId: 'codex-approve-once', expectedRevision: pending.revision },
  })
  expect(anonymousResponse.statusCode).toBe(401)
  expect(manager.counters.deliveries).toBe(0)

  // User-handler native behavior is tested at the trusted service boundary.
  // HTTP cannot invent a User identity; authenticated production routes have
  // their own composition/authorization regression in production-composition.
  expect((await service.list({ handler: 'user', limit: 10 })).items).toHaveLength(1)
  await expect(service.respond({ kind: 'user' }, {
    interactionId: pending.id, optionId: 'caller-forged-option', expectedRevision: pending.revision,
  })).rejects.toMatchObject({ code: 'INTERACTION_OPTION_INVALID' })
  const response = await service.respond({ kind: 'user' }, {
    interactionId: pending.id, optionId: 'codex-approve-once', expectedRevision: pending.revision,
  })
  expect(response.interaction.deliveryState).toBe('delivered')
  expect((await runs.get(run.id))?.outcome).toBe('succeeded')
  expect(manager.counters).toEqual({ nodeEntries: 2, sessions: 2, attaches: 0, sideEffects: 2, deliveries: 1 })
  const executions = await runs.listExecutions(run.id)
  expect(executions).toHaveLength(2)
  expect(executions.find((item) => item.workflowNodeId === 'predecessor')?.nativeSessionId).toBe('session-predecessor')
  expect(executions.find((item) => item.workflowNodeId === 'approval-target')?.nativeSessionId).toBe('session-approval-target')
  const replay = await service.respond({ kind: 'user' }, {
    interactionId: pending.id, optionId: 'codex-approve-once', expectedRevision: pending.revision,
  })
  expect(replay.replayed).toBe(true)
  expect(manager.counters.deliveries).toBe(1)
})

it('targets two parallel interrupt ids without respawning either branch or its predecessor', async () => {
  const workflows = new PostgresWorkflowRepository(pool)
  const developerConfiguration = await workflows.getAgentConfiguration('agent-developer-config-v1')
  if (!developerConfiguration || developerConfiguration.harness.harness !== 'opencode') throw new Error('OpenCode configuration missing')
  await pool.query('update agent_configuration_versions set record=$2::jsonb where id=$1', [
    developerConfiguration.id,
    JSON.stringify({
      ...developerConfiguration,
      harness: { ...developerConfiguration.harness, advanced: structuredClone(DEFAULT_OPENCODE_ADVANCED_CONFIGURATION) },
    }),
  ])
  const saved = await workflows.get('workspace-1', 'workflow-content-pipeline')
  if (!saved) throw new Error('seed missing')
  await workflows.save('workspace-1', {
    ...saved, requiredAgentCount: 3,
    nodes: [
      { id: 'parallel-predecessor', agentId: 'agent-researcher', name: 'Predecessor' },
      { id: 'parallel-left', agentId: 'agent-developer', name: 'Left approval' },
      { id: 'parallel-right', agentId: 'agent-reviewer', name: 'Right approval' },
    ],
    edges: [
      { id: 'edge-left', source: 'parallel-predecessor', target: 'parallel-left' },
      { id: 'edge-right', source: 'parallel-predecessor', target: 'parallel-right' },
    ],
    approval: { handler: 'user' }, executionPolicy: { maxParallelism: 2, maxNodeExecutions: 3 },
  })
  const locations = new WorkspaceLocationService(pool, new PostgresCommandCoordinator(pool), root)
  const runs = new PostgresRunRepository(pool, workflows, locations)
  const run = await runs.createForWorkflow('workspace-1', 'workflow-content-pipeline', {}, 1)
  const interactions = new PostgresInteractionRepository(pool)
  const budgets = new PostgresApprovalBudgetRepository(pool)
  const contexts = new Map<string, { agentId: string; workingDirectory: string }>()
  const managersByAgent = new Map<string, SelectiveNativeManager>()
  const resolutionCount = new Map<string, number>()
  const restartExecutions = new Set<string>()
  const observedConfigurations: AgentConfigurationVersion[] = []
  const managerResolver = { resolve: (context: { executionId: string; agentId: string; workingDirectory: string; harness: 'codex' | 'opencode'; configuration: AgentConfigurationVersion }) => {
    contexts.set(context.executionId, { agentId: context.agentId, workingDirectory: context.workingDirectory })
    const manager = managersByAgent.get(context.agentId) ?? new SelectiveNativeManager(new Set(['parallel-left', 'parallel-right']), context.harness as 'codex' | 'opencode')
    if (!managersByAgent.has(context.agentId)) observedConfigurations.push(context.configuration)
    managersByAgent.set(context.agentId, manager)
    const count = resolutionCount.get(context.executionId) ?? 0
    resolutionCount.set(context.executionId, count + 1)
    const restarting = restartExecutions.delete(context.executionId)
    return { manager, processState: count === 0 || restarting ? 'needs_start' as const : 'resident' as const }
  } }
  const prepared: Array<{ executionId: string; agentId: string; token: string }> = []
  const revoked: string[] = []
  const credentials = {
    prepare: async (input: { executionId: string; harness: 'codex' | 'opencode'; workingDirectory: string }) => {
      const owner = contexts.get(input.executionId)
      if (!owner) throw new Error('resolver context must precede credential issue')
      const token = `token-${owner.agentId}-${input.executionId}-${prepared.length + 1}`
      prepared.push({ executionId: input.executionId, agentId: owner.agentId, token })
      return {
        credential: { principalId: `principal-${input.executionId}`, environment: { agentId: owner.agentId, variables: { GRAPHQL_APP_MCP_TOKEN: token } }, expiresAt: new Date(Date.now() + 900_000).toISOString() },
        detection: {
          detection: { harness: input.harness, serverName: 'graphql-app', state: 'connected' as const, endpointMatches: true, credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN', checkedAt: new Date().toISOString() },
          runnerId: 'runner-local', workingDirectory: input.workingDirectory,
          providerVersion: input.harness === 'codex' ? '0.154.0' : '1.18.31', nativeFilters: {},
        },
      }
    },
    revoke: async () => undefined,
    revokeForExecution: async (executionId: string) => { revoked.push(executionId); return 1 },
  }
  const approvalRuntime = new ApprovalExecutionCoordinator(runs, interactions, budgets, managerResolver, 10_000, credentials)
  engine = new LangGraphWorkflowEngine(
    runs, workflows, approvalRuntime, checkpoints.saver, root, locations, undefined, interactions,
  )
  const service = new InteractionService(interactions, budgets, approvalRuntime, (interaction) => engine.resumeInteraction(interaction))

  await engine.start(run.id)
  const pending = await interactions.list({ runId: run.id, limit: 10 })
  expect(pending, JSON.stringify(await runs.get(run.id))).toHaveLength(2)
  expect(pending.every((item) => Boolean(item.graphInterruptId))).toBe(true)
  expect(prepared).toHaveLength(3)
  expect(new Set(prepared.map((item) => item.agentId))).toEqual(new Set(['agent-researcher', 'agent-developer', 'agent-reviewer']))
  const pinnedOpenCode = observedConfigurations.find((configuration) => configuration.agentId === 'agent-developer')
  expect(pinnedOpenCode).toMatchObject({ id: 'agent-developer-config-v1', harness: { harness: 'opencode' } })
  expect(pinnedOpenCode?.harness.harness === 'opencode' ? pinnedOpenCode.harness.advanced : undefined).toBeDefined()
  expect(new Set(prepared.map((item) => item.token)).size).toBe(3)
  expect(revoked).toHaveLength(1)
  restartExecutions.add(pending[0]!.executionId)
  await Promise.all(pending.map((item, index) => service.respond({ kind: 'user' }, {
    interactionId: item.id,
    optionId: item.responseOptions.find((option) => option.semantic === (index === 0 ? 'approve_once' : 'reject'))!.optionId,
    expectedRevision: item.revision,
  })))
  expect(await runs.get(run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
  const totals = [...managersByAgent.values()].reduce((sum, manager) => ({
    nodeEntries: sum.nodeEntries + manager.counters.nodeEntries,
    sessions: sum.sessions + manager.counters.sessions,
    sideEffects: sum.sideEffects + manager.counters.sideEffects,
    deliveries: sum.deliveries + manager.counters.deliveries,
  }), { nodeEntries: 0, sessions: 0, sideEffects: 0, deliveries: 0 })
  expect(totals).toEqual({ nodeEntries: 3, sessions: 3, sideEffects: 3, deliveries: 2 })
  expect(prepared).toHaveLength(4)
  expect(revoked).toHaveLength(3)
  for (const item of prepared) {
    const manager = managersByAgent.get(item.agentId)!
    expect([...manager.startEnvironments.values(), ...manager.attachEnvironments]).toContain(item.token)
  }
  const restarted = prepared.filter((item) => item.executionId === pending[0]!.executionId)
  expect(restarted).toHaveLength(2)
  expect(managersByAgent.get(restarted[0]!.agentId)!.attachEnvironments).toContain(restarted[1]!.token)
  expect(await runs.listExecutions(run.id)).toHaveLength(3)
})

it('delivers an Orchestrator App MCP response to native execution, resumes the run and revokes credentials', async () => {
  const workflows = new PostgresWorkflowRepository(pool)
  for (const [agentId, productRole] of [['agent-reviewer', 'orchestrator'], ['agent-developer', 'coder']] as const) {
    const row = await pool.query<{ record: unknown }>('select record from agents where id=$1', [agentId])
    const agent = AgentSchema.parse({ ...AgentSchema.parse(row.rows[0]!.record), productRole })
    await pool.query('update agents set record=$2::jsonb where id=$1', [agentId, JSON.stringify(agent)])
    await pool.query("update agent_configuration_versions set record=jsonb_set(record,'{productRole}',to_jsonb($2::text)) where agent_id=$1", [agentId, productRole])
  }
  await pool.query("update agent_configuration_versions set record=jsonb_set(record,'{harness}',$1::jsonb,true) where agent_id='agent-reviewer'",
    [JSON.stringify({ harness: 'opencode', model: 'opencode-go/gpt-5.6-luna', variant: 'high', nativeAgent: 'build', thinking: false,
      autoApprove: false, advanced: { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, permissionRules: [
        { permission: '*', pattern: '*', effect: 'deny' },
        { permission: 'graphql-app_interaction_get', pattern: '*', effect: 'allow' },
        { permission: 'graphql-app_interaction_respond', pattern: '*', effect: 'allow' },
      ] } })])
  const saved = await workflows.get('workspace-1', 'workflow-content-pipeline')
  if (!saved) throw new Error('seed missing')
  await workflows.save('workspace-1', {
    ...saved, requiredAgentCount: 2,
    nodes: [
      { id: 'orchestrator-predecessor', agentId: 'agent-reviewer', name: 'Orchestrator' },
      { id: 'orchestrated-target', agentId: 'agent-developer', name: 'Worker approval' },
    ],
    edges: [{ id: 'orchestrated-edge', source: 'orchestrator-predecessor', target: 'orchestrated-target' }],
    approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-reviewer' },
    executionPolicy: { maxParallelism: 1, maxNodeExecutions: 2 },
  })
  const locations = new WorkspaceLocationService(pool, new PostgresCommandCoordinator(pool), root)
  const runs = new PostgresRunRepository(pool, workflows, locations)
  const run = await runs.createForWorkflow('workspace-1', 'workflow-content-pipeline', {}, 1)
  const interactions = new PostgresInteractionRepository(pool)
  const budgets = new PostgresApprovalBudgetRepository(pool)
  const managers = new Map<string, SelectiveNativeManager>()
  const ownerByExecution = new Map<string, string>()
  const resolver = { resolve: (context: { executionId: string; agentId: string; harness: 'codex' | 'opencode' }) => {
    ownerByExecution.set(context.executionId, context.agentId)
    const existing = managers.get(context.executionId)
    const manager = existing ?? new SelectiveNativeManager(new Set(['orchestrated-target']), context.harness)
    managers.set(context.executionId, manager)
    return { manager, processState: existing ? 'resident' as const : 'needs_start' as const }
  } }
  const revoked: string[] = []
  const credentials = {
    prepare: async (input: { executionId: string; harness: 'codex' | 'opencode'; workingDirectory: string }) => ({
      credential: {
        principalId: `principal-${input.executionId}`,
        environment: { agentId: ownerByExecution.get(input.executionId)!, variables: { GRAPHQL_APP_MCP_TOKEN: `token-${input.executionId}` } },
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      },
      detection: {
        detection: { harness: input.harness, serverName: 'graphql-app', state: 'connected' as const, endpointMatches: true, credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN', checkedAt: new Date().toISOString() },
        runnerId: 'runner-local', workingDirectory: input.workingDirectory,
        providerVersion: input.harness === 'codex' ? '0.154.0' : '1.18.31', nativeFilters: {},
      },
    }),
    revoke: async () => undefined,
    revokeForExecution: async (executionId: string) => { revoked.push(executionId); return 1 },
  }
  const runtime = new ApprovalExecutionCoordinator(runs, interactions, budgets, resolver, 10_000, credentials)
  engine = new LangGraphWorkflowEngine(
    runs, workflows, runtime, checkpoints.saver, root, locations, undefined, interactions,
  )
  const service = new InteractionService(interactions, budgets, runtime, (interaction) => engine.resumeInteraction(interaction))
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  app = buildApp({
    readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    appMcp: { access, interactions: new PostgresAppInteractionService(pool, interactions, commands, service) },
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  await engine.start(run.id)
  const pending = (await interactions.list({ runId: run.id, limit: 10 }))[0]!
  const reviewerExecution = (await runs.listExecutions(run.id)).find((item) => item.agentId === 'agent-reviewer')!
  const issued = await new WorkerCredentialService(pool, access).issueForReviewer(reviewerExecution.id)
  const client = new Client({ name: 'orchestrator-app-proof', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/tools', address), {
    authProvider: { token: async () => issued.environment.variables.GRAPHQL_APP_MCP_TOKEN! },
  }))
  try {
    const revocationsBeforeResponse = revoked.length
    expect(revocationsBeforeResponse).toBeGreaterThan(0)
    const response = await client.callTool({ name: 'interaction_respond', arguments: {
      interactionId: pending.id,
      optionId: pending.responseOptions.find((option) => option.semantic === 'approve_once')!.optionId,
      expectedRevision: pending.revision,
    } })
    expect(response.isError).not.toBe(true)
    expect((response.structuredContent as { interaction: { deliveryState: string } }).interaction.deliveryState).toBe('delivered')
    expect(await runs.get(run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    expect([...managers.values()].reduce((count, manager) => count + manager.counters.deliveries, 0)).toBe(1)
    expect(revoked).toHaveLength(revocationsBeforeResponse + 1)
  } finally { await client.close() }
})

it.each(['direct', 'transitive', 'unconnected', 'same_agent_other_node'] as const)(
  'enforces exact-node %s authority over authenticated App MCP, Operator MCP and HTTP with persisted readback', async (topology) => {
    const fixture = await routedApprovalFixture(pool, root, projectRoot, topology)
    const { run, runs, interactions, service, commands, reviewer, reviewerId, reviewerSession, requester, manager } = fixture
    const access = new PostgresAccessService(pool)
    const workers = new WorkerCredentialService(pool, access)
    const allowed = await workers.issueForReviewer(reviewer.id)
    const denied = await workers.issueForExecution(requester.id)
    const operator = await access.issue({ name: 'Topology verification operator', audience: 'operator',
      expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['interactions:read', 'interactions:respond', 'runs:read'],
        scope: { workspaceIds: [run.workspaceId], workflowIds: [run.workflowId], runIds: [run.id] } }],
    })
    let nativeReviewAttaches = 0
    const dispatcher = new ReviewerDispatcher(interactions.coordination, {
      attachInteraction: async () => { throw new Error('No model review may start in this test') },
      attachOwnedSession: async () => { nativeReviewAttaches += 1; throw new Error('No model review may start in this test') },
    })
    const reviewContext = { executionId: reviewer.id, workingDirectory: projectRoot }
    if (topology === 'direct') {
      const job = await dispatcher.enqueue(fixture.interaction, reviewerId, reviewerSession, reviewContext)
      await interactions.coordination.claimReviewJob(job.id, 'test-owner', 'test-fence', new Date(Date.now() + 60_000).toISOString())
    } else {
      await expect(dispatcher.enqueue(fixture.interaction, reviewerId, reviewerSession, reviewContext))
        .rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
      expect((await pool.query('select id from review_jobs where interaction_id=$1', [fixture.interaction.id])).rowCount).toBe(0)
      // Explicitly seed a pre-upgrade queued job to exercise recovery, not only enqueue.
      await interactions.coordination.ensureReviewJob({
        id: `legacy-${run.id}`, interactionId: fixture.interaction.id, reviewerAgentId: reviewerId,
        attempt: 0, state: 'pending', provider: reviewerSession.harness, nativeSessionId: reviewerSession.nativeSessionId,
        correlationId: `legacy-correlation-${run.id}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }, { ...reviewContext, providerVersion: reviewerSession.providerVersion })
      await expect(dispatcher.dispatchNext(reviewerId, 'test-owner')).rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
      expect(await interactions.coordination.findReviewJob(fixture.interaction.id, reviewerId)).toMatchObject({ state: 'pending', attempt: 0 })
    }
    expect(nativeReviewAttaches).toBe(0)
    // get() has no engine side effects. Throwing unused ports prevent accidental execution.
    const readOnlyEngine = { start: async () => { throw new Error('read-only fixture') },
      cancel: async () => { throw new Error('read-only fixture') } } as never
    const runManagement = new RunManagementService(pool, commands, runs, readOnlyEngine, fixture.locations)
    app = buildApp({
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      appMcp: { access, interactions: new PostgresAppInteractionService(pool, interactions, commands, service) },
      product: { interactions: service } as never,
      operator: { access, services: { interactions: new OperatorInteractionService(service, interactions), runs: runManagement, commands } as never },
    })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const clients: Client[] = []
    async function connect(path: string, token: string) {
      const client = new Client({ name: 'topology-boundary-proof', version: '1.0.0' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL(path, address), { authProvider: { token: async () => token } }))
      return client
    }
    try {
      const readClient = await connect('/mcp/operator', operator.token)
      const reviewerClient = await connect('/mcp/tools', allowed.environment.variables.GRAPHQL_APP_MCP_TOKEN!)
      const deniedClient = await connect('/mcp/tools', denied.environment.variables.GRAPHQL_APP_MCP_TOKEN!)
      const request = { interactionId: fixture.interaction.id,
        optionId: fixture.interaction.responseOptions.find((option) => option.semantic === 'approve_once')!.optionId,
        expectedRevision: fixture.interaction.revision }
      const before = await interactions.get(request.interactionId)
      expect((await deniedClient.listTools()).tools.some((tool) => tool.name === 'interaction_respond')).toBe(false)
      const deniedAttempt = await deniedClient.callTool({ name: 'interaction_respond', arguments: request })
        .catch((error: unknown) => {
          expect(error).toMatchObject({ code: expect.any(Number) })
          expect([-32601, -32602]).toContain((error as { code: number }).code)
          return { isError: true }
        })
      expect(deniedAttempt.isError).toBe(true)
      const httpDenied = await app.inject({ method: 'POST', url: `/api/interactions/${request.interactionId}/respond`,
        headers: { authorization: `Bearer ${operator.token}` }, payload: request })
      expect(httpDenied.statusCode).toBe(404)
      const operatorDenied = await readClient.callTool({ name: 'interaction_respond', arguments: { ...request, commandId: randomUUID() } })
      expect(operatorDenied.isError).toBe(true)
      expect(await interactions.get(request.interactionId)).toEqual(before)
      expect(manager.counters.deliveries).toBe(0)
      const read = await readClient.callTool({ name: 'run_get', arguments: { workspaceId: run.workspaceId, runId: run.id } })
      expect(read.isError).not.toBe(true)
      const live = GetRunResponseSchema.parse(read.structuredContent).liveActivity!
      expect(live.workflowVersionId).toBe(run.workflowVersionId)
      expect(live.nodes.find((node) => node.workflowNodeId === 'worker')).toMatchObject({ state: 'waiting',
        action: { kind: 'waiting_approval', label: 'Waiting for Luna’s approval…' } })
      if (topology === 'direct') expect(live.nodes.find((node) => node.workflowNodeId === 'review')).toMatchObject({
        state: 'working', action: { kind: 'reviewing_request', label: 'Reviewing Worker’s request…' },
      })
      if (topology === 'direct') {
        const stale = await reviewerClient.callTool({ name: 'interaction_respond', arguments: { ...request, expectedRevision: 999 } })
        expect(stale.isError).toBe(true)
        expect(await interactions.get(request.interactionId)).toEqual(before)
        expect(manager.counters.deliveries).toBe(0)
      }
      const response = await reviewerClient.callTool({ name: 'interaction_respond', arguments: request })
      if (topology === 'direct') {
        expect(response.isError).not.toBe(true)
        expect(manager.counters.deliveries).toBe(1)
        const persisted = await readClient.callTool({ name: 'interaction_get', arguments: { interactionId: request.interactionId } })
        expect(persisted.isError).not.toBe(true)
        expect((persisted.structuredContent as { interaction: { deliveryState: string } }).interaction.deliveryState).toBe('delivered')
        expect(await interactions.get(request.interactionId)).toMatchObject({ deliveryState: 'delivered' })
        // Exact idempotent replay cannot produce another native response.
        const replay = await reviewerClient.callTool({ name: 'interaction_respond', arguments: request })
        expect(replay.isError).not.toBe(true)
        expect(manager.counters.deliveries).toBe(1)
      } else {
        expect(response.isError).toBe(true)
        expect(JSON.stringify(response)).toContain('INTERACTION_ACCESS_DENIED')
        const persisted = await readClient.callTool({ name: 'interaction_get', arguments: { interactionId: request.interactionId } })
        expect((persisted.structuredContent as { interaction: unknown }).interaction).toEqual(before)
        expect(await interactions.get(request.interactionId)).toEqual(before)
        expect(manager.counters.deliveries).toBe(0)
        expect(nativeReviewAttaches).toBe(0)
      }
      // Persist terminal state, then read through the authenticated MCP boundary.
      const terminal = { ...run, executionState: 'completed', outcome: 'canceled',
        result: { outcome: 'canceled' }, finishedAt: new Date().toISOString() }
      await pool.query("update runs set execution_state='completed',record=$2::jsonb where id=$1", [run.id, JSON.stringify(terminal)])
      const terminalRead = await readClient.callTool({ name: 'run_get', arguments: { workspaceId: run.workspaceId, runId: run.id } })
      const terminalLive = GetRunResponseSchema.parse(terminalRead.structuredContent).liveActivity!
      expect(terminalLive.active).toBe(false)
      expect(terminalLive.nodes.every((node) => node.state === 'idle' && node.action === null)).toBe(true)
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()))
      await dispatcher.shutdown()
    }
  },
)

it('retains storage-only non-Orchestrator interaction fixtures without granting review authority', async () => {
  const fixture = { ...NATIVE_INTERACTION_FIXTURES.codex, approval: { handler: 'user' as const } }
  await seedInteractionOwners(pool, fixture)
  const interactions = new PostgresInteractionRepository(pool)
  expect((await interactions.create(fixture)).created).toBe(true)
  await expect(interactions.assertOrchestratorConnection(fixture)).resolves.toBeUndefined()
})

it('keeps a busy designated reviewer pending and fences one idle-session dispatch across workers', async () => {
  const first = await routedApprovalFixture(pool, root, projectRoot, 'direct')
  const second = await routedApprovalFixture(pool, root, projectRoot, 'direct')
  const coordination = new PostgresInteractionCoordinationRepository(pool)
  const now = new Date().toISOString()
  await coordination.ensureLane({
    id: 'lane-busy', harness: first.reviewerSession.harness, nativeSessionId: first.reviewerSession.nativeSessionId,
    ownerAgentId: first.reviewerId, observedStatus: 'busy', connectionGeneration: 1, observedAt: now, revision: 0,
  })
  await coordination.ensureLane({
    id: 'lane-idle', harness: second.reviewerSession.harness, nativeSessionId: second.reviewerSession.nativeSessionId,
    ownerAgentId: second.reviewerId, observedStatus: 'idle', connectionGeneration: 1, observedAt: now, revision: 0,
  })
  const manager = new ReviewNativeManager()
  await coordination.claimLane('lane-busy', 0, 'active-writer', 'busy-token', new Date(Date.now() + 60_000).toISOString(), 'busy-turn')
  const dispatcher = new ReviewerDispatcher(coordination, {
    attachInteraction: async () => { throw new Error('not used') },
    attachOwnedSession: async (_context: unknown, session: NativeSessionReference) => ({ manager, session }),
  })
  try {
    await dispatcher.enqueue(first.interaction, first.reviewerId, first.reviewerSession,
      { executionId: first.reviewer.id, workingDirectory: projectRoot })
    const idleJob = await dispatcher.enqueue(second.interaction, second.reviewerId, second.reviewerSession,
      { executionId: second.reviewer.id, workingDirectory: projectRoot })
    expect(await dispatcher.dispatchNext(first.reviewerId, 'worker-a')).toMatchObject({ state: 'blocked_busy' })
    expect(manager.reviewTurns).toBe(0)
    const claims = await Promise.allSettled([
      coordination.claimReviewJob(idleJob.id, 'worker-a', 'token-a', new Date(Date.now() + 30_000).toISOString()),
      coordination.claimReviewJob(idleJob.id, 'worker-b', 'token-b', new Date(Date.now() + 30_000).toISOString()),
    ])
    expect(claims.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(claims.filter((item) => item.status === 'rejected')).toHaveLength(1)
  } finally { await dispatcher.shutdown() }
})

it('lists, reads and responds to an Operator-assigned request through authenticated MCP', async () => {
  const workflows = new PostgresWorkflowRepository(pool)
  const locations = new WorkspaceLocationService(pool, new PostgresCommandCoordinator(pool), root)
  const runs = new PostgresRunRepository(pool, workflows, locations)
  const run = await runs.createForWorkflow('workspace-1', 'workflow-content-pipeline', {}, 1)
  const configuration = await workflows.getAgentConfiguration('agent-reviewer-config-v1')
  if (!configuration) throw new Error('configuration missing')
  const execution = {
    id: 'operator-execution', runId: run.id, workflowNodeId: 'operator-node', agentId: 'agent-reviewer',
    agentConfigurationVersionId: configuration.id, attempt: 1, input: {}, state: 'waiting' as const,
    createdAt: new Date().toISOString(), nativeSessionId: 'codex-fixture-session',
    workingDirectory: projectRoot, runtimeDirectory: root,
  }
  await runs.ensureExecution(execution)
  const interactions = new PostgresInteractionRepository(pool)
  const created = await interactions.create({
    ...NATIVE_INTERACTION_FIXTURES.codex, id: 'operator-interaction', runId: run.id,
    nativeSessionId: execution.nativeSessionId,
    executionId: execution.id, requestingAgentId: execution.agentId, approval: { handler: 'operator' },
  })
  const budgets = new PostgresApprovalBudgetRepository(pool)
  await budgets.ensure(execution.id, run.id, 10_000)
  await budgets.beginWait(execution.id)
  const manager = new DeterministicNativeSessionManager('codex')
  const session = await manager.attachSession({
    harness: 'codex', providerVersion: '0.154.0', nativeSessionId: execution.nativeSessionId,
  }, { request: {
    executionId: execution.id, runId: run.id, workspaceId: run.workspaceId, workflowNodeId: execution.workflowNodeId,
    workingDirectory: projectRoot, runtimeDirectory: root, configuration, input: {},
  } })
  for await (const event of manager.startTurn(session, { prompt: 'fixture', clientCorrelationId: 'operator-proof' })) { void event; break }
  const pendingNative = (await manager.pending(session))!
  const rebound = DurableInteractionSchema.parse({
    ...created.interaction,
    nativeRequestId: pendingNative.turn.nativeRequestId,
    nativeRequestType: pendingNative.nativeRequestType,
    request: pendingNative.request,
    responseOptions: pendingNative.responseOptions,
  })
  await pool.query('update durable_interactions set native_request_id=$2,record=$3::jsonb where id=$1',
    [rebound.id, rebound.nativeRequestId, JSON.stringify(rebound)])
  const managerResolver = { resolve: () => ({ manager, processState: 'resident' as const }) }
  const runtime = new ApprovalExecutionCoordinator(runs, interactions, budgets, managerResolver, 10_000)
  const service = new InteractionService(interactions, budgets, runtime, async () => undefined)
  const operatorInteractions = new OperatorInteractionService(service, interactions)
  const access = new PostgresAccessService(pool)
  const issued = await access.issue({
    name: 'Approval operator', audience: 'operator', expiresAt: new Date(Date.now() + 60_000),
    grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { runIds: [run.id] } }],
  })
  const commands = new PostgresCommandCoordinator(pool)
  app = buildApp({
    readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access, services: { interactions: operatorInteractions, commands } as never },
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const client = new Client({ name: 'approval-operator-proof', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address), {
    authProvider: { token: async () => issued.token },
  }))
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'interaction_get', 'interaction_list', 'interaction_respond', 'interaction_summary',
    ])
    const listed = await client.callTool({ name: 'interaction_list', arguments: { runId: run.id, limit: 10 } })
    expect((listed.structuredContent as { items: unknown[] }).items).toHaveLength(1)
    await pool.query(
      "update approval_execution_state set approval_wait_started_at=now()-interval '7 days' where execution_id=$1",
      [execution.id],
    )
    const responded = await client.callTool({ name: 'interaction_respond', arguments: {
      interactionId: created.interaction.id, optionId: 'codex-approve-once', expectedRevision: 0,
      commandId: `respond-${randomUUID()}`,
    } })
    expect(responded.isError).not.toBe(true)
    expect((responded.structuredContent as { value: { deliveryState: string } }).value.deliveryState).toBe('delivered')
    expect(manager.counters.deliveries).toBe(1)
    const missing = await interactions.create({
      ...NATIVE_INTERACTION_FIXTURES.codex, id: 'operator-interaction-missing-session', runId: run.id,
      executionId: execution.id, requestingAgentId: execution.agentId,
      nativeRequestId: 'missing-native-request', approval: { handler: 'operator' },
    })
    const missingService = new InteractionService(interactions, budgets, {
      attachInteraction: async () => { throw new Error('persisted native session is unavailable') },
      attachOwnedSession: async () => { throw new Error('persisted native session is unavailable') },
    }, async () => undefined)
    const blocked = await missingService.respond({ kind: 'operator', principal: issued.principal }, {
      interactionId: missing.interaction.id, optionId: 'codex-approve-once', expectedRevision: 0,
    })
    expect(blocked.interaction).toMatchObject({ status: 'delivery_failed', deliveryState: 'failed' })
    expect(manager.counters).toMatchObject({ attaches: 1, deliveries: 1 })
    const uncertainManager = new UncertainOnceNativeManager('opencode')
    const uncertainSession = await uncertainManager.createSession({ request: {
      executionId: execution.id, runId: run.id, workspaceId: run.workspaceId, workflowNodeId: execution.workflowNodeId,
      workingDirectory: projectRoot, runtimeDirectory: root, configuration, input: {},
    } })
    for await (const event of uncertainManager.startTurn(uncertainSession, { prompt: 'fixture', clientCorrelationId: 'uncertain-proof' })) { void event; break }
    const uncertain = await interactions.create({
      ...NATIVE_INTERACTION_FIXTURES.opencode, id: 'operator-interaction-uncertain', runId: run.id,
      nativeSessionId: uncertainSession.nativeSessionId,
      executionId: execution.id, requestingAgentId: execution.agentId, approval: { handler: 'operator' },
    })
    const uncertainService = new InteractionService(interactions, budgets, {
      attachInteraction: async (interaction) => ({
        manager: uncertainManager,
        session: { harness: interaction.harness, providerVersion: interaction.providerVersion, nativeSessionId: interaction.nativeSessionId },
      }),
      attachOwnedSession: async (_context, session) => ({ manager: uncertainManager, session }),
    }, async () => undefined)
    const firstAttempt = await uncertainService.respond({ kind: 'operator', principal: issued.principal }, {
      interactionId: uncertain.interaction.id, optionId: 'opencode-approve-once', expectedRevision: 0,
    })
    expect(firstAttempt.interaction.deliveryState).toBe('uncertain')
    const reconciled = await uncertainService.respond({ kind: 'operator', principal: issued.principal }, {
      interactionId: uncertain.interaction.id, optionId: 'opencode-approve-once', expectedRevision: 0,
    })
    expect(reconciled.interaction.deliveryState).toBe('uncertain')
    expect(uncertainManager.responseAttempts).toBe(1)
    const retried = await uncertainService.respond({ kind: 'operator', principal: issued.principal }, {
      interactionId: uncertain.interaction.id, optionId: 'opencode-approve-once', expectedRevision: 0,
    })
    expect(retried.interaction.deliveryState).toBe('uncertain')
    expect(uncertainManager.responseAttempts).toBe(1)
    const stopped = await interactions.create({
      ...NATIVE_INTERACTION_FIXTURES.codex, id: 'operator-interaction-stopped', runId: run.id,
      executionId: execution.id, requestingAgentId: execution.agentId,
      nativeRequestId: 'stopped-native-request', approval: { handler: 'operator' },
    })
    await runtime.cancelRun(run.id)
    expect(await interactions.get(stopped.interaction.id)).toMatchObject({ status: 'canceled' })
    await expect(service.respond({ kind: 'operator', principal: issued.principal }, {
      interactionId: stopped.interaction.id, optionId: 'codex-approve-once', expectedRevision: 0,
    })).rejects.toMatchObject({ code: 'INTERACTION_CANCELED' })
    expect(manager.counters.cancellations).toBe(1)
  } finally { await client.close() }
})

it('evicts a failed provider so retry preflights a fresh Agent-scoped manager and token', async () => {
  const workflows = new PostgresWorkflowRepository(pool)
  const locations = new WorkspaceLocationService(pool, new PostgresCommandCoordinator(pool), root)
  const runs = new PostgresRunRepository(pool, workflows, locations)
  const run = await runs.createForWorkflow('workspace-1', 'workflow-content-pipeline', {}, 1)
  const reviewerConfig = await workflows.getAgentConfiguration('agent-reviewer-config-v1')
  const researcherConfig = await workflows.getAgentConfiguration('agent-researcher-config-v1')
  if (!reviewerConfig || !researcherConfig) throw new Error('configuration missing')
  const now = new Date().toISOString()
  const executions = [
    { id: 'retry-reviewer-execution', agentId: 'agent-reviewer', configuration: reviewerConfig },
    { id: 'retry-researcher-execution', agentId: 'agent-researcher', configuration: researcherConfig },
  ]
  for (const item of executions) await runs.ensureExecution({
    id: item.id, runId: run.id, workflowNodeId: `node-${item.agentId}`, agentId: item.agentId,
    agentConfigurationVersionId: item.configuration.id, attempt: 1, input: {}, state: 'waiting',
    createdAt: now, nativeSessionId: `session-${item.agentId}`,
    workingDirectory: projectRoot, runtimeDirectory: root,
  })
  const createdManagers: Array<{ agentId: string; manager: FailingAttachNativeManager }> = []
  let first = true
  const resolver = new ExecutionScopedNativeSessionManagerResolver((context) => {
    const manager = new FailingAttachNativeManager(first)
    first = false
    createdManagers.push({ agentId: context.agentId, manager })
    return manager
  })
  const tokens: Array<{ executionId: string; agentId: string; token: string }> = []
  const revoked: string[] = []
  const credentials = {
    prepare: async (input: { executionId: string; harness: 'codex' | 'opencode'; workingDirectory: string }) => {
      const agentId = executions.find((item) => item.id === input.executionId)!.agentId
      const token = `fresh-${input.executionId}-${tokens.length + 1}`
      tokens.push({ executionId: input.executionId, agentId, token })
      return {
        credential: { principalId: `principal-${token}`, environment: { agentId, variables: { GRAPHQL_APP_MCP_TOKEN: token } }, expiresAt: new Date(Date.now() + 900_000).toISOString() },
        detection: {
          detection: { harness: input.harness, serverName: 'graphql-app', state: 'connected' as const, endpointMatches: true, credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN', checkedAt: now },
          runnerId: 'runner-local', workingDirectory: input.workingDirectory, providerVersion: '0.154.0', nativeFilters: {},
        },
      }
    },
    revoke: async () => undefined,
    revokeForExecution: async (executionId: string) => { revoked.push(executionId); return 1 },
  }
  const runtime = new ApprovalExecutionCoordinator(
    runs, new PostgresInteractionRepository(pool), new PostgresApprovalBudgetRepository(pool), resolver, 10_000, credentials,
  )
  const reviewerContext = { harness: 'codex' as const, executionId: executions[0]!.id, agentId: executions[0]!.agentId, workingDirectory: projectRoot }
  const reviewerSession = { harness: 'codex' as const, providerVersion: '0.154.0', nativeSessionId: 'session-agent-reviewer' }
  await expect(runtime.attachOwnedSession(reviewerContext, reviewerSession)).rejects.toThrow('provider failed after process start')
  await expect(runtime.attachOwnedSession(reviewerContext, reviewerSession)).resolves.toMatchObject({ session: reviewerSession })
  const researcherContext = { harness: 'codex' as const, executionId: executions[1]!.id, agentId: executions[1]!.agentId, workingDirectory: projectRoot }
  await expect(runtime.attachOwnedSession(researcherContext, {
    harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'session-agent-researcher',
  })).resolves.toMatchObject({ session: { nativeSessionId: 'session-agent-researcher' } })

  expect(createdManagers.map((item) => item.agentId)).toEqual(['agent-reviewer', 'agent-reviewer', 'agent-researcher'])
  expect(tokens.map((item) => item.agentId)).toEqual(['agent-reviewer', 'agent-reviewer', 'agent-researcher'])
  expect(new Set(tokens.map((item) => item.token)).size).toBe(3)
  expect(revoked).toContain('retry-reviewer-execution')
  expect(createdManagers[0]!.manager.counters.attaches).toBe(1)
  expect(createdManagers[1]!.manager.counters.attaches).toBe(1)
  expect(() => resolver.resolve({
    ...reviewerContext,
    configuration: { ...reviewerConfig, contentHash: 'sha256:drifted-configuration' },
  })).toThrow('cannot change native manager ownership context')
})
