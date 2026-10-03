import { createHash, randomUUID } from 'node:crypto'
import { agentWorkflowVersion } from './helpers/agentWorkflowFixture.js'
import { mkdir, rename, rm } from 'node:fs/promises'

import { CODEX_APPROVAL_OPTIONS_FIXTURE, DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, type ExecutionResult, type NativeHarnessEvent, type NativeSessionReference, type PendingNativeInteraction } from '@graphql/contracts'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import pg from 'pg'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@graphql/contracts/wave25'
import { seedAgent3 } from './helpers/wave25Agent3.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { Wave25WorkerCredentialService as WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import type { NativeHistory, WorkflowNativeSessionStart } from '../src/modules/harnesses/port.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { ReviewerDispatcher } from '../src/modules/interactions/reviewer.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { FixtureServer } from './opencode-fixtures.js'
import { buildProductionApp } from '../src/production.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_nim2601'
let schema: string, root: string, project: string, address: string
let admin: pg.Pool, database: ReturnType<typeof createDatabase>, checkpoints: ReturnType<typeof createCheckpointStore>
let production: ReturnType<typeof buildProductionApp>
let config: ReturnType<typeof loadConfig>
let runs: PostgresRunRepository, interactions: PostgresInteractionRepository, access: PostgresAccessService
const success: ExecutionResult = { outcome: 'succeeded', output: { text: 'workflow result' } }
type ProviderSession = { input: WorkflowNativeSessionStart; pending: PendingNativeInteraction[]; turns: Map<string, ExecutionResult | undefined>; asks: number }
type Connection = { id: string; events: NativeHarnessEvent[]; token: string; sessionId: string }
let sessions: Map<string, ProviderSession>, connections: WeakMap<object, Connection>
vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 })
let repeatedApproval = false
let reviewNoDecision = false
let native: { starts: string[]; attaches: number; responses: number; inspections: number; closes: number }

function event(manager: object, type: string, payload: Record<string, unknown>) {
  const local = connections.get(manager)!
  const value = { connectionId: local.id, sequence: local.events.length, type, payload, occurredAt: new Date().toISOString() }
  local.events.push(value)
  return value
}
const providerId = (manager: { harness: 'codex' | 'opencode' }, correlation: string) => manager.harness === 'opencode'
  ? `msg_${createHash('sha256').update(correlation).digest('hex').slice(0, 24)}` : correlation
function ask(reference: NativeSessionReference, suffix: number): PendingNativeInteraction {
  const saved = sessions.get(reference.nativeSessionId)!
  const turnId = [...saved.turns.keys()][0]!
  return { session: reference, turn: { nativeTurnId: turnId, nativeRequestId: `ask-${reference.nativeSessionId}-${suffix}` },
    nativeRequestType: 'item/commandExecution/requestApproval', request: {
      itemId: `item-${reference.nativeSessionId}-${suffix}`, turnId, threadId: reference.nativeSessionId,
      command: 'test', cwd: saved.input.request.workingDirectory,
    }, responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE }
}
function runtime() { return Reflect.get(production.engine, 'nativeExecutions') as ApprovalExecutionCoordinator }
async function mcp(token: string, input: Record<string, unknown>) {
  const client = new Client({ name: 'production-review', version: '1.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    return await client.callTool({ name: 'interaction_respond', arguments: input })
  } finally { await client.close() }
}
beforeEach(async () => {
  schema = `production_lifecycle_${randomUUID().replaceAll('-', '')}`
  root = await privateFixtureDirectory('pr15-runtime-')
  project = await privateFixtureDirectory('pr15-project-')
  admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  const url = new URL(connectionString)
  url.searchParams.set('options', `-c search_path=${schema}`)
  config = loadConfig({ DATABASE_URL: url.toString(), DATABASE_POOL_MAX: '1', DATABASE_QUERY_TIMEOUT_MS: '5000', HARNESS_WORKSPACE_ROOT: root, HARNESS_TIMEOUT_MS: '30000', PORT: '4100' })
  config.workspaceStorageRoot = project
  database = createDatabase(config.database)
  await database.migrate()
  checkpoints = createCheckpointStore(connectionString, `${schema}_checkpoints`, config.database)
  await checkpoints.setup()
  access = new PostgresAccessService(database.pool)
  sessions = new Map(); connections = new WeakMap(); repeatedApproval = false; reviewNoDecision = false
  native = { starts: [], attaches: 0, responses: 0, inspections: 0, closes: 0 }
  // Only the native provider transport is doubled. Credentials, ownership,
  // lanes, delivery, budgets, checkpoints, HTTP and MCP use production wiring.
  vi.spyOn(CodexAppServerSessionManager.prototype, 'inspectMcpConfiguration').mockImplementation(async (cwd) => {
    native.inspections++
    return { providerVersion: '0.154.0', binary: 'fixture', cwd, serverName: 'graphql', inspectionScope: 'effective_config', configured: {
      enabled: true, required: true, transport: 'streamable_http', url: 'http://127.0.0.1:4100/mcp',
      bearerTokenEnvironmentVariable: 'GRAPHQL_MCP_TOKEN', enabledTools: null, disabledTools: [], defaultToolsApprovalMode: null, tools: {},
    } }
  })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession').mockImplementation(async function (this: CodexAppServerSessionManager, input) {
    if (input.kind === 'operator') throw new Error('Unexpected Operator launch')
    const reference = { harness: this.harness, providerVersion: this.harness === 'codex' ? '0.154.0' : '1.18.31', nativeSessionId: `session-${input.request.executionId}` }
    sessions.set(reference.nativeSessionId, { input, pending: [], turns: new Map(), asks: 0 })
    connections.set(this, { id: randomUUID(), events: [], token: input.environment!.variables.GRAPHQL_MCP_TOKEN!, sessionId: reference.nativeSessionId })
    return reference
  })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'attachSession').mockImplementation(async function (this: CodexAppServerSessionManager, reference, input) {
    native.attaches++
    if (!sessions.has(reference.nativeSessionId)) throw new Error('Cannot replace a native session')
    connections.set(this, { id: randomUUID(), events: [], token: input.environment!.variables.GRAPHQL_MCP_TOKEN!, sessionId: reference.nativeSessionId })
    event(this, 'thread.attached', { threadId: reference.nativeSessionId })
    return reference
  })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'startTurn').mockImplementation(async function* (this: CodexAppServerSessionManager, reference, input) {
    native.starts.push(input.clientCorrelationId)
    const turnId = providerId(this, input.clientCorrelationId)
    const saved = sessions.get(reference.nativeSessionId)!
    saved.turns.set(input.clientCorrelationId, undefined)
    await input.onSubmitted?.(turnId)
    yield event(this, 'turn.started', { threadId: reference.nativeSessionId, turnId, clientCorrelationId: input.clientCorrelationId })
    if (input.clientCorrelationId.startsWith('review-')) {
      const interactionId = /interaction (\S+)\./.exec(input.prompt)![1]!
      const interaction = (await interactions.get(interactionId))!
      if (!reviewNoDecision) await mcp(connections.get(this)!.token, {
        interactionId, optionId: interaction.responseOptions[0]!.optionId, expectedRevision: interaction.revision,
      })
      saved.turns.set(input.clientCorrelationId, { outcome: 'succeeded', output: { text: 'review result' } })
    } else if (saved.input.request.workflowNodeId === 'orchestrator') saved.turns.set(input.clientCorrelationId, success)
    else {
      saved.pending = [ask(reference, ++saved.asks)]
      yield event(this, 'interaction.pending', { nativeRequestId: saved.pending[0]!.turn.nativeRequestId,
        nativeRequestType: saved.pending[0]!.nativeRequestType, turnId })
      return
    }
    yield event(this, 'turn.completed', { threadId: reference.nativeSessionId, turnId })
  })
  const history = function (manager: CodexAppServerSessionManager | OpenCodeNativeSessionManager, reference: NativeSessionReference, correlationId?: string): NativeHistory {
    const saved = sessions.get(reference.nativeSessionId)!
    const result = correlationId ? saved.turns.get(correlationId) : undefined
    if (correlationId) event(manager, 'thread.reconciled', { thread: { id: reference.nativeSessionId,
      status: saved.pending.length ? 'active' : 'idle', turns: [...saved.turns].map(([id, value]) => ({ id: providerId(manager, id), clientUserMessageId: id, status: value ? 'completed' : 'inProgress' })) } })
    if (manager.harness === 'opencode' && !saved.pending.length) event(manager, 'session.idle', { sessionID: reference.nativeSessionId })
    return { events: [...connections.get(manager)!.events], pendingInteractions: [...saved.pending],
      ...(result && correlationId ? { correlationId, nativeTurnId: providerId(manager, correlationId),
        terminalResult: result, terminalTurn: { correlationId, providerId: providerId(manager, correlationId), result } } : {}) }
  }
  vi.spyOn(CodexAppServerSessionManager.prototype, 'history').mockImplementation(async function (this: CodexAppServerSessionManager, reference) { return history(this, reference) })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'reconcileResponse').mockImplementation(async function (this: CodexAppServerSessionManager, reference) {
    return history(this, reference, `execution:${sessions.get(reference.nativeSessionId)!.input.request.executionId}`)
  })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'reconcile').mockImplementation(async function (this: CodexAppServerSessionManager, reference, correlation) { return history(this, reference, correlation) })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'pending').mockImplementation(async function (_reference) {
    return sessions.get(_reference.nativeSessionId)?.pending[0]
  })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'respond').mockImplementation(async function (this: CodexAppServerSessionManager, reference, requestId, option) {
    const saved = sessions.get(reference.nativeSessionId)!
    const pending = saved.pending.find((item) => item.turn.nativeRequestId === requestId)
    expect(pending).toBeDefined()
    native.responses++
    event(this, 'interaction.submitted', { nativeRequestId: requestId, optionId: option.optionId, semantic: option.semantic })
    event(this, 'interaction.resolved', { nativeRequestId: requestId, submittedOptionId: option.optionId,
      evidence: 'serverRequest/resolved' })
    event(this, 'item.completed', { threadId: reference.nativeSessionId, turnId: pending!.turn.nativeTurnId,
      item: { id: (pending!.request as { itemId: string }).itemId, type: 'commandExecution', status: 'completed',
        command: 'test', cwd: (pending!.request as { cwd: string }).cwd, exitCode: 0 } })
    if (repeatedApproval && saved.input.request.workflowNodeId === 'worker-a' && saved.asks < 2) {
      saved.pending = [ask(reference, ++saved.asks)]
    } else {
      saved.pending = []
      saved.turns.set(`execution:${saved.input.request.executionId}`, success)
    }
  })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'cancel').mockResolvedValue(true)
  vi.spyOn(CodexAppServerSessionManager.prototype, 'close').mockImplementation(async () => { native.closes++ })
  const openCodeServers = new Map<string, FixtureServer>()
  const originalCreate = OpenCodeNativeSessionManager.prototype.createSession
  const originalAttach = OpenCodeNativeSessionManager.prototype.attachSession
  const originalStart = OpenCodeNativeSessionManager.prototype.startTurn
  function serverFor(manager: OpenCodeNativeSessionManager, input: WorkflowNativeSessionStart) {
    let server = openCodeServers.get(input.request.executionId)
    if (!server) {
      server = new FixtureServer()
      server.providers = { all: [{ id: 'opencode-go', models: { 'gpt-5.6-luna': { variants: { high: {} } } } }] }
      server.config = { mcp: { 'graphql': { type: 'remote', url: 'http://127.0.0.1:4100/mcp', enabled: true } } }
      server.mcpCredentialReferences['graphql'] = 'GRAPHQL_MCP_TOKEN'
      server.mcp = { 'graphql': { status: 'connected' } }
      server.nextSessionIds.push(`ses_${input.request.executionId}`)
      const external = server
      server.onPrompt = (sessionId, body) => {
        const correlation = `execution:${input.request.executionId}`
        if (body.messageID === providerId(manager, correlation)) external.complete(correlation, 'workflow result', sessionId)
      }
      openCodeServers.set(input.request.executionId, server)
    }
    Reflect.get(manager, 'options').server = server
    return server
  }
  // Replace only the external HTTP/SSE server. The real OpenCode adapter emits
  // its original history and submission evidence into production capture ports.
  vi.spyOn(OpenCodeNativeSessionManager.prototype, 'createSession').mockImplementation(async function (this: OpenCodeNativeSessionManager, input, signal) {
    if (input.kind === 'operator') throw new Error('Unexpected Operator launch')
    serverFor(this, input)
    return originalCreate.call(this, input, signal)
  })
  vi.spyOn(OpenCodeNativeSessionManager.prototype, 'attachSession').mockImplementation(async function (this: OpenCodeNativeSessionManager, reference, input, signal) {
    if (input.kind === 'operator') throw new Error('Unexpected Operator launch')
    native.attaches++
    serverFor(this, input)
    return originalAttach.call(this, reference, input, signal)
  })
  vi.spyOn(OpenCodeNativeSessionManager.prototype, 'inspectNativeMcp').mockImplementation(async (cwd) => {
    native.inspections++
    return { cwd, providerVersion: '1.18.31', serverName: 'graphql', nativeStatus: 'connected', transport: 'streamable-http',
      endpoint: 'http://127.0.0.1:4100/mcp', credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN',
      endpointMatches: true, baseConfigurationFilters: [], policyScope: 'base_configuration_only' }
  })
  vi.spyOn(OpenCodeNativeSessionManager.prototype, 'startTurn').mockImplementation(async function* (this: OpenCodeNativeSessionManager, reference, input, signal) {
    native.starts.push(input.clientCorrelationId)
    let reviewed = false
    for await (const value of originalStart.call(this, reference, input, signal)) {
      yield value
      if (!reviewed && input.clientCorrelationId.startsWith('review-')) {
        reviewed = true
        const server = Reflect.get(this, 'options').server as FixtureServer
        const interactionId = /interaction (\S+)\./.exec(input.prompt)![1]!
        const interaction = (await interactions.get(interactionId))!
        if (!reviewNoDecision) {
          const response = await mcp(server.environment!.variables.GRAPHQL_MCP_TOKEN!, {
            interactionId, optionId: interaction.responseOptions[0]!.optionId, expectedRevision: interaction.revision,
          })
          expect(response.isError, JSON.stringify(response)).not.toBe(true)
        }
        server.complete(input.clientCorrelationId, 'review result', reference.nativeSessionId)
      }
    }
  })
  vi.spyOn(ReviewerDispatcher.prototype, 'reconcile').mockResolvedValue() // manually drive the real dispatcher between crash boundaries
  production = buildProductionApp(config, database, checkpoints, false)
  runs = Reflect.get(production.engine, 'runs') as PostgresRunRepository
  interactions = Reflect.get(runtime(), 'interactions') as PostgresInteractionRepository
  await production.initialize()
  address = await production.app.listen({ host: '127.0.0.1', port: 0 })
})

afterEach(async () => {
  await production?.shutdown()
  await production?.app.close()
  await checkpoints?.close(); await database?.close()
  await admin?.query(`drop schema if exists "${schema}" cascade`)
  await admin?.query(`drop schema if exists "${schema}_checkpoints" cascade`)
  await admin?.end()
  await rm(root, { recursive: true, force: true }); await rm(project, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function start(handler: 'user' | 'orchestrator', twoWorkers = false) {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  const workspaceId = 'workspace-1'
  const nodes = [{ id: 'orchestrator', agentId: 'agent-researcher', name: 'Orchestrator' },
    { id: 'worker-a', agentId: 'agent-reviewer', name: 'Worker A' },
    ...(twoWorkers ? [{ id: 'worker-b', agentId: 'agent-worker-b', name: 'Worker B' }] : [])]
  fixture.scope.workspaceId = workspaceId
  fixture.run.workspaceId = workspaceId
  fixture.configurations = nodes.map((node, index) => ({ ...fixture.configurations[index === 0 ? 0 : 1]!,
    id: `cfg-${node.agentId}`, workspaceId, agentId: node.agentId,
    productRole: index === 0 ? 'orchestrator' as const : 'coder' as const,
    harness: index === 0 && handler === 'orchestrator' ? {
      harness: 'opencode' as const, model: 'opencode-go/gpt-5.6-luna', variant: 'high', nativeAgent: 'build', thinking: false,
      autoApprove: false, advanced: { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, permissionRules: [
        { permission: '*', pattern: '*', effect: 'deny' as const },
        { permission: 'graphql_interaction_get', pattern: '*', effect: 'allow' as const },
        { permission: 'graphql_interaction_respond', pattern: '*', effect: 'allow' as const },
      ] },
    } : fixture.configurations[1]!.harness,
  }))
  const approval = { handler, ...(handler === 'orchestrator' ? { designatedOrchestratorAgentId: 'agent-researcher' } : {}) }
  fixture.version = agentWorkflowVersion(WorkflowVersionV3Schema.parse({ ...fixture.version, workspaceId, approval, entryNodeId: 'orchestrator',
    agentConfigurationVersionIds: Object.fromEntries(fixture.configurations.map((item) => [item.agentId, item.id])),
    definition: { ...fixture.version.definition, workspaceId, nodes, entryNodeId: 'orchestrator', approval,
      edges: [ ...nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, kind: 'execution', source: nodes[index]!.id, target: node.id })),
        ...(handler === 'orchestrator' ? nodes.slice(1).map((node) => ({ id: `approval-${node.id}`, kind: 'approval', source: 'orchestrator', target: node.id })) : []) ],
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: nodes.length },
    },
  }))
  await seedAgent3(database.pool, project, fixture, { run: false })
  const issuer = await access.issue({ name: 'Run owner', audience: 'operator', grants: [{ actions: ['runs:start', 'runs:stop', 'workspace_locations:read', 'workspace_locations:update', 'interactions:read', 'interactions:respond'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
  const locations = new WorkspaceLocationService(database.pool, new PostgresCommandCoordinator(database.pool), root)
  const location = await locations.set(issuer.principal, 'http', { workspaceId, commandId: randomUUID(),
    expectedLocationRevision: 1, runnerId: 'runner-local', rootPath: project })
  const version = fixture.version
  const saved = { id: fixture.scope.workflowId }
  const revision = Number((await database.pool.query('select revision from workflows where id=$1', [saved.id])).rows[0].revision)
  const accepted = await production.app.inject({ method: 'POST',
    url: `/api/management/workspaces/workspace-1/workflows/${saved.id}/runs`,
    headers: { authorization: `Bearer ${issuer.token}` },
    payload: { executionSemanticsVersion: 3, workflowVersionId: version.id, expectedWorkflowRevision: revision,
      expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds, expectedLocationRevision: location.value.locationRevision, commandId: randomUUID(), input: {} },
  })
  expect(accepted.statusCode, accepted.body).toBe(202)
  const run = accepted.json().run as NonNullable<Awaited<ReturnType<PostgresRunRepository['get']>>>
  try { await vi.waitFor(async () => expect((await runs.get(run.id))?.executionState).toBe('waiting'), { timeout: 60_000 }) }
  catch (error) {
    const facts = await database.pool.query('select record from harness_executions where run_id=$1', [run.id])
    throw new Error(JSON.stringify({ executions: facts.rows, activity: await runs.listActivity(run.id) }), { cause: error })
  }
  return { run, issuer, pending: (await interactions.list({ runId: run.id, status: 'pending', limit: 10 }))[0]! }
}

it('answers a production User approval through its own authenticated API while excluding Operator and App authority', async () => {
  const { run, issuer, pending } = await start('user')
  const human = await access.issue({ name: 'Human', audience: 'user', grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { runIds: [run.id] } }], expiresAt: new Date(Date.now() + 600_000) })
  const url = `/api/user/interactions/${pending.id}/respond`
  const payload = { interactionId: pending.id, optionId: pending.responseOptions[0]!.optionId, expectedRevision: pending.revision }
  expect((await production.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${issuer.token}` }, payload })).statusCode).toBe(403)
  const worker = await new WorkerCredentialService(database.pool, access).issueForExecution(pending.executionId)
  expect((await production.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${worker.environment.variables.GRAPHQL_MCP_TOKEN}` }, payload })).statusCode).toBe(403)
  const denied = await mcp(worker.environment.variables.GRAPHQL_MCP_TOKEN!, payload)
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied.content)).toContain('ROLE_NOT_ALLOWED')
  const headers = { authorization: `Bearer ${human.token}` }
  const list = await production.app.inject({ method: 'GET', url: `/api/user/interactions?runId=${run.id}`, headers })
  expect(list.statusCode, list.body).toBe(200)
  expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([pending.id])
  expect((await production.app.inject({ method: 'GET', url: `/api/user/interactions/${pending.id}`, headers })).statusCode).toBe(200)
  expect(production.app.hasRoute({ method: 'GET', url: '/api/interactions/:interactionId' })).toBe(false)
  const response = await production.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${human.token}` }, payload })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json().interaction.deliveryState).toBe('delivered')
  await production.engine.resume(run.id)
  await vi.waitFor(async () => expect((await runs.get(run.id))?.outcome).toBe('succeeded'), { timeout: 60_000 })
  expect(native.responses).toBe(1)
})

for (const change of ['location', 'authority'] as const) it(`rejects a waiting continuation before inspection, attachment or delivery after ${change} changes`, async () => {
  const { run, issuer, pending } = await start('user')
  const before = { ...native }
  if (change === 'location') { await rename(project, `${project}-old`); await mkdir(project) }
  else await access.revoke(issuer.principal.id)
  try {
    await expect(runtime().attachInteraction(pending)).rejects.toMatchObject({ code: change === 'location' ? 'WORKSPACE_LOCATION_CHANGED' : 'RUN_AUTHORIZATION_REVOKED' })
    expect(native.inspections).toBe(before.inspections)
    expect(native.attaches).toBe(before.attaches)
    expect(native.responses).toBe(before.responses)
    expect((await runs.get(run.id))?.executionState).toBe('waiting')
    const human = await access.issue({ name: 'Human', audience: 'user', grants: [{ actions: ['interactions:respond'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const response = await production.app.inject({ method: 'POST', url: `/api/user/interactions/${pending.id}/respond`,
      headers: { authorization: `Bearer ${human.token}` }, payload: { interactionId: pending.id, optionId: pending.responseOptions[0]!.optionId, expectedRevision: pending.revision } })
    expect(response.statusCode).toBe(change === 'location' ? 409 : 403)
    const untouched = await interactions.get(pending.id)
    expect(untouched?.selectedOptionId).toBeUndefined()
    expect(untouched?.status).toBe('pending')
  } finally { if (change === 'location') { await rm(project, { recursive: true }); await rename(`${project}-old`, project) } }
})

it('makes production Stop and native delivery progress with a one-slot pool', async () => {
  const { run, issuer, pending } = await start('user')
  const human = await access.issue({ name: 'Human', audience: 'user', grants: [{ actions: ['interactions:respond'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
  const respond = vi.mocked(CodexAppServerSessionManager.prototype.respond)
  const original = respond.getMockImplementation()!
  let entered!: () => void, release!: () => void
  const writing = new Promise<void>((resolve) => { entered = resolve })
  const permit = new Promise<void>((resolve) => { release = resolve })
  respond.mockImplementationOnce(async function (this: CodexAppServerSessionManager, ...args) {
    entered()
    await permit
    return original.apply(this, args)
  })
  const delivery = production.app.inject({ method: 'POST', url: `/api/user/interactions/${pending.id}/respond`,
    headers: { authorization: `Bearer ${human.token}` }, payload: { interactionId: pending.id, optionId: pending.responseOptions[0]!.optionId, expectedRevision: pending.revision } })
  // inject starts when awaited/then'ed; keep both requests live.
  const delivered = Promise.resolve(delivery)
  await writing
  const stopped = Promise.resolve(production.app.inject({ method: 'POST', url: `/api/management/workspaces/workspace-1/runs/${run.id}/stop`,
    headers: { authorization: `Bearer ${issuer.token}` }, payload: { commandId: randomUUID() } }))
  release()
  const [response, stop] = await Promise.all([delivered, stopped])
  // Stop may cancel the graph acknowledgement after the native receipt commits.
  expect([200, 409]).toContain(response.statusCode)
  if (response.statusCode === 409) expect(response.json().error.code).toBe('GRAPH_RESUME_OWNER_LOST')
  expect((await interactions.get(pending.id))?.deliveryState).toBe('delivered')
  expect(stop.statusCode, stop.body).toBe(200)
  expect(native.responses).toBe(1)
  expect((await runs.get(run.id))?.executionState).toBe('completed')
})


it('revalidates the accepting authority again between attachment and the native response', async () => {
  const { issuer, pending } = await start('user')
  const human = await access.issue({ name: 'Human', audience: 'user', grants: [{ actions: ['interactions:respond'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
  const coordinator = runtime()
  const attach = coordinator.attachInteraction.bind(coordinator)
  vi.spyOn(coordinator, 'attachInteraction').mockImplementationOnce(async (...args) => {
    const attached = await attach(...args)
    await access.revoke(issuer.principal.id)
    return attached
  })
  const response = await production.app.inject({ method: 'POST', url: `/api/user/interactions/${pending.id}/respond`,
    headers: { authorization: `Bearer ${human.token}` }, payload: { interactionId: pending.id, optionId: pending.responseOptions[0]!.optionId, expectedRevision: pending.revision } })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json().interaction.deliveryState).toBe('failed')
  expect(native.responses).toBe(0)
})
