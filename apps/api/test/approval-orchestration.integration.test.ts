import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CODEX_APPROVAL_OPTIONS_FIXTURE,
  NATIVE_INTERACTION_FIXTURES,
  NativeHarnessEventSchema,
  type HarnessExecutionRequest,
  type NativeHarnessEvent,
  type NativeSessionReference,
  type PendingNativeInteraction,
  type ApprovalResponseOption,
} from '@graphql/contracts'
import pg from 'pg'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

import { buildApp } from '../src/app.js'
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
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { ReviewerDispatcher } from '../src/modules/interactions/reviewer.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
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
  async reconcile(session: NativeSessionReference) { return this.history(session) }
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
    runs, workflows, { resolve: () => { throw new Error('legacy adapter must not run') } },
    checkpoints.saver, root, 10_000, locations, undefined, approvalRuntime, interactions,
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

  const operatorOnly = await interactions.create({
    ...NATIVE_INTERACTION_FIXTURES.codex,
    id: `operator-hidden-${run.id}`,
    runId: run.id,
    executionId: `operator-hidden-execution-${run.id}`,
    nativeSessionId: `operator-hidden-session-${run.id}`,
    nativeRequestId: `operator-hidden-request-${run.id}`,
    approval: { handler: 'operator' },
  })

  const listed = await app.inject({
    method: 'GET', url: '/api/interactions?limit=10',
  })
  expect(listed.statusCode).toBe(200)
  expect(listed.json().items).toHaveLength(1)
  expect((await app.inject({
    method: 'GET', url: `/api/interactions/${operatorOnly.interaction.id}`,
  })).statusCode).toBe(404)
  const unsupported = await app.inject({
    method: 'POST', url: `/api/interactions/${pending.id}/respond`,
    payload: { interactionId: pending.id, optionId: 'caller-forged-option', expectedRevision: pending.revision },
  })
  expect(unsupported.statusCode).toBe(409)
  const response = await app.inject({
    method: 'POST', url: `/api/interactions/${pending.id}/respond`,
    payload: { interactionId: pending.id, optionId: 'codex-approve-once', expectedRevision: pending.revision },
  })
  expect(response.statusCode).toBe(200)
  expect(response.json().interaction.deliveryState).toBe('delivered')
  expect((await runs.get(run.id))?.outcome).toBe('succeeded')
  expect(manager.counters).toEqual({ nodeEntries: 2, sessions: 2, attaches: 2, sideEffects: 2, deliveries: 1 })
  const executions = await runs.listExecutions(run.id)
  expect(executions).toHaveLength(2)
  expect(executions.find((item) => item.workflowNodeId === 'predecessor')?.nativeSessionId).toBe('session-predecessor')
  expect(executions.find((item) => item.workflowNodeId === 'approval-target')?.nativeSessionId).toBe('session-approval-target')
  const replay = await app.inject({
    method: 'POST', url: `/api/interactions/${pending.id}/respond`,
    payload: { interactionId: pending.id, optionId: 'codex-approve-once', expectedRevision: pending.revision },
  })
  expect(replay.statusCode).toBe(200)
  expect(replay.json().replayed).toBe(true)
  expect(manager.counters.deliveries).toBe(1)
})

it('targets two parallel interrupt ids without respawning either branch or its predecessor', async () => {
  const workflows = new PostgresWorkflowRepository(pool)
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
  const managerResolver = { resolve: (context: { executionId: string; agentId: string; workingDirectory: string; harness: 'codex' | 'opencode' }) => {
    contexts.set(context.executionId, { agentId: context.agentId, workingDirectory: context.workingDirectory })
    const manager = managersByAgent.get(context.agentId) ?? new SelectiveNativeManager(new Set(['parallel-left', 'parallel-right']), context.harness as 'codex' | 'opencode')
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
        credential: { principalId: `principal-${input.executionId}`, environment: { agentId: owner.agentId, variables: { GRAPHQL_APP_MCP_TOKEN: token } }, expiresAt: new Date(Date.now() + 60_000).toISOString() },
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
    runs, workflows, { resolve: () => { throw new Error('legacy adapter must not run') } },
    checkpoints.saver, root, 10_000, locations, undefined, approvalRuntime, interactions,
  )
  const service = new InteractionService(interactions, budgets, approvalRuntime, (interaction) => engine.resumeInteraction(interaction))

  await engine.start(run.id)
  const pending = await interactions.list({ runId: run.id, limit: 10 })
  expect(pending).toHaveLength(2)
  expect(pending.every((item) => Boolean(item.graphInterruptId))).toBe(true)
  expect(prepared).toHaveLength(3)
  expect(new Set(prepared.map((item) => item.agentId))).toEqual(new Set(['agent-researcher', 'agent-developer', 'agent-reviewer']))
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

it('keeps a busy designated reviewer pending and fences one idle-session dispatch across workers', async () => {
  const interactions = new PostgresInteractionRepository(pool)
  const coordination = new PostgresInteractionCoordinationRepository(pool)
  const first = await interactions.create({
    ...NATIVE_INTERACTION_FIXTURES.codex, id: 'review-interaction-busy',
    nativeSessionId: 'requester-busy', nativeRequestId: 'request-busy',
  })
  const second = await interactions.create({
    ...NATIVE_INTERACTION_FIXTURES.codex, id: 'review-interaction-idle',
    nativeSessionId: 'requester-idle', nativeRequestId: 'request-idle',
  })
  const now = new Date().toISOString()
  await coordination.ensureLane({
    id: 'lane-busy', harness: 'codex', nativeSessionId: 'reviewer-busy-session', ownerAgentId: 'reviewer-busy',
    observedStatus: 'busy', connectionGeneration: 1, observedAt: now, revision: 0,
  })
  await coordination.ensureLane({
    id: 'lane-idle', harness: 'codex', nativeSessionId: 'reviewer-idle-session', ownerAgentId: 'reviewer-idle',
    observedStatus: 'idle', connectionGeneration: 1, observedAt: now, revision: 0,
  })
  const manager = new ReviewNativeManager()
  const reviewRuntime = {
    attachInteraction: async () => { throw new Error('not used') },
    attachOwnedSession: async (_context: unknown, session: NativeSessionReference) => ({ manager, session }),
  }
  const dispatcher = new ReviewerDispatcher(coordination, reviewRuntime)
  await dispatcher.enqueue(first.interaction, 'reviewer-busy', {
    harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'reviewer-busy-session',
  }, { executionId: 'reviewer-busy-execution', workingDirectory: projectRoot })
  const idleJob = await dispatcher.enqueue(second.interaction, 'reviewer-idle', {
    harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'reviewer-idle-session',
  }, { executionId: 'reviewer-idle-execution', workingDirectory: projectRoot })

  expect(await dispatcher.dispatchNext('reviewer-busy', 'worker-a')).toMatchObject({ state: 'blocked_busy' })
  expect(manager.reviewTurns).toBe(0)
  const claims = await Promise.allSettled([
    coordination.claimReviewJob(idleJob.id, 'worker-a', 'token-a', new Date(Date.now() + 30_000).toISOString()),
    coordination.claimReviewJob(idleJob.id, 'worker-b', 'token-b', new Date(Date.now() + 30_000).toISOString()),
  ])
  expect(claims.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
  expect(claims.filter((item) => item.status === 'rejected')).toHaveLength(1)
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
    executionId: execution.id, requestingAgentId: execution.agentId, approval: { handler: 'operator' },
  })
  const budgets = new PostgresApprovalBudgetRepository(pool)
  await budgets.ensure(execution.id, run.id, 10_000)
  await budgets.beginWait(execution.id)
  const manager = new DeterministicNativeSessionManager('codex')
  const session = await manager.createSession({ request: {
    executionId: execution.id, runId: run.id, workspaceId: run.workspaceId, workflowNodeId: execution.workflowNodeId,
    workingDirectory: projectRoot, runtimeDirectory: root, configuration, input: {},
  } })
  for await (const event of manager.startTurn(session, { prompt: 'fixture', clientCorrelationId: 'operator-proof' })) { void event; break }
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
      'interaction_get', 'interaction_list', 'interaction_respond',
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
    expect(manager.counters).toMatchObject({ sessions: 1, deliveries: 1 })
    const uncertainManager = new UncertainOnceNativeManager('opencode')
    const uncertainSession = await uncertainManager.createSession({ request: {
      executionId: execution.id, runId: run.id, workspaceId: run.workspaceId, workflowNodeId: execution.workflowNodeId,
      workingDirectory: projectRoot, runtimeDirectory: root, configuration, input: {},
    } })
    for await (const event of uncertainManager.startTurn(uncertainSession, { prompt: 'fixture', clientCorrelationId: 'uncertain-proof' })) { void event; break }
    const uncertain = await interactions.create({
      ...NATIVE_INTERACTION_FIXTURES.opencode, id: 'operator-interaction-uncertain', runId: run.id,
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
    expect(reconciled.interaction.deliveryState).toBe('failed')
    expect(uncertainManager.responseAttempts).toBe(1)
    const retried = await uncertainService.respond({ kind: 'operator', principal: issued.principal }, {
      interactionId: uncertain.interaction.id, optionId: 'opencode-approve-once', expectedRevision: 0,
    })
    expect(retried.interaction.deliveryState).toBe('delivered')
    expect(uncertainManager.responseAttempts).toBe(2)
    const stopped = await interactions.create({
      ...NATIVE_INTERACTION_FIXTURES.codex, id: 'operator-interaction-stopped', runId: run.id,
      executionId: execution.id, requestingAgentId: execution.agentId,
      nativeRequestId: 'stopped-native-request', approval: { handler: 'operator' },
    })
    await runtime.cancelRun(run.id)
    expect(await interactions.get(stopped.interaction.id)).toMatchObject({ status: 'canceled' })
    await expect(service.respond({ kind: 'operator', principal: issued.principal }, {
      interactionId: stopped.interaction.id, optionId: 'codex-approve-once', expectedRevision: 0,
    })).rejects.toMatchObject({ code: 'EXECUTION_STOPPED' })
    expect(manager.counters.cancellations).toBe(1)
  } finally { await client.close() }
})
