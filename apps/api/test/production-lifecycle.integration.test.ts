import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CODEX_APPROVAL_OPTIONS_FIXTURE, type ExecutionResult, type NativeHarnessEvent, type NativeSessionReference, type PendingNativeInteraction } from '@graphql/contracts'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import pg from 'pg'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { WorkerCredentialService } from '../src/modules/access/workerCredentials.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import type { NativeHistory, WorkflowNativeSessionStart } from '../src/modules/harnesses/port.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { PostgresInteractionDeliveryRepository } from '../src/modules/interactions/deliveryPostgres.js'
import { ReviewerDispatcher } from '../src/modules/interactions/reviewer.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { buildProductionApp } from '../src/production.js'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_nim2601'
let schema: string, root: string, project: string, address: string
let admin: pg.Pool, database: ReturnType<typeof createDatabase>, checkpoints: ReturnType<typeof createCheckpointStore>
let production: ReturnType<typeof buildProductionApp>
let config: ReturnType<typeof loadConfig>
let runs: PostgresRunRepository, interactions: PostgresInteractionRepository, access: PostgresAccessService
const retired: Array<ReturnType<typeof buildProductionApp>> = []
const success: ExecutionResult = { outcome: 'succeeded', output: { text: 'workflow result' } }
type ProviderSession = { input: WorkflowNativeSessionStart; pending: PendingNativeInteraction[]; turns: Map<string, ExecutionResult | undefined>; asks: number }
type Connection = { id: string; events: NativeHarnessEvent[]; token: string; sessionId: string }
let sessions: Map<string, ProviderSession>, connections: WeakMap<CodexAppServerSessionManager, Connection>
let repeatedApproval = false
let native: { starts: string[]; attaches: number; responses: number; inspections: number; closes: number }

function event(manager: CodexAppServerSessionManager, type: string, payload: Record<string, unknown>) {
  const local = connections.get(manager)!
  const value = { connectionId: local.id, sequence: local.events.length, type, payload, occurredAt: new Date().toISOString() }
  local.events.push(value)
  return value
}
function ask(reference: NativeSessionReference, suffix: number): PendingNativeInteraction {
  return { session: reference, turn: { nativeTurnId: 'workflow-turn', nativeRequestId: `ask-${reference.nativeSessionId}-${suffix}` },
    nativeRequestType: 'item/commandExecution/requestApproval', request: { command: 'test' }, responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE }
}
function runtime() { return Reflect.get(production.engine, 'approvals') as ApprovalExecutionCoordinator }
async function mcp(token: string, input: Record<string, unknown>) {
  const client = new Client({ name: 'production-review', version: '1.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/tools', address), { authProvider: { token: async () => token } }))
    return await client.callTool({ name: 'interaction_respond', arguments: input })
  } finally { await client.close() }
}

beforeEach(async () => {
  schema = `production_lifecycle_${randomUUID().replaceAll('-', '')}`
  root = await mkdtemp(join(tmpdir(), 'pr15-runtime-'))
  project = await mkdtemp(join(tmpdir(), 'pr15-project-'))
  admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  const url = new URL(connectionString)
  url.searchParams.set('options', `-c search_path=${schema}`)
  config = loadConfig({ DATABASE_URL: url.toString(), DATABASE_POOL_MAX: '1', DATABASE_QUERY_TIMEOUT_MS: '5000', HARNESS_WORKSPACE_ROOT: root, HARNESS_TIMEOUT_MS: '5000', PORT: '4100' })
  database = createDatabase(config.database)
  await database.migrate()
  await ensureAcceptanceSeed(database.pool)
  checkpoints = createCheckpointStore(connectionString, `${schema}_checkpoints`, config.database)
  await checkpoints.setup()
  const info = await stat(project)
  await database.pool.query('update workspaces set execution_location=$1::jsonb,execution_location_identity=$2::jsonb,location_revision=1', [
    JSON.stringify({ runnerId: 'runner-local', rootPath: await realpath(project) }), JSON.stringify({ device: String(info.dev), inode: String(info.ino) }),
  ])
  await database.pool.query(`update agents set record=record || jsonb_build_object('productRole',case when id='agent-researcher' then 'orchestrator' else 'coder' end)`)
  await database.pool.query(`update agent_configuration_versions set record=record || jsonb_build_object('productRole',case when agent_id='agent-researcher' then 'orchestrator' else 'coder' end)`)
  const workflows = new PostgresWorkflowRepository(database.pool)
  runs = new PostgresRunRepository(database.pool, workflows, new WorkspaceLocationService(database.pool, new PostgresCommandCoordinator(database.pool), root))
  interactions = new PostgresInteractionRepository(database.pool)
  access = new PostgresAccessService(database.pool)
  sessions = new Map(); connections = new WeakMap(); repeatedApproval = false
  native = { starts: [], attaches: 0, responses: 0, inspections: 0, closes: 0 }
  // Only the native provider transport is doubled. Credentials, ownership,
  // lanes, delivery, budgets, checkpoints, HTTP and MCP use production wiring.
  vi.spyOn(CodexAppServerSessionManager.prototype, 'inspectMcpConfiguration').mockImplementation(async (cwd) => {
    native.inspections++
    return { providerVersion: '0.154.0', binary: 'fixture', cwd, serverName: 'graphql-app', inspectionScope: 'effective_config', configured: {
      enabled: true, required: true, transport: 'streamable_http', url: 'http://127.0.0.1:4100/mcp/tools',
      bearerTokenEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN', enabledTools: null, disabledTools: [], defaultToolsApprovalMode: null, tools: {},
    } }
  })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession').mockImplementation(async function (this: CodexAppServerSessionManager, input) {
    if (input.kind === 'operator') throw new Error('Unexpected Operator launch')
    const reference = { harness: 'codex' as const, providerVersion: '0.154.0', nativeSessionId: `session-${input.request.executionId}` }
    sessions.set(reference.nativeSessionId, { input, pending: [], turns: new Map(), asks: 0 })
    connections.set(this, { id: randomUUID(), events: [], token: input.environment!.variables.GRAPHQL_APP_MCP_TOKEN!, sessionId: reference.nativeSessionId })
    return reference
  })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'attachSession').mockImplementation(async function (this: CodexAppServerSessionManager, reference, input) {
    native.attaches++
    if (!sessions.has(reference.nativeSessionId)) throw new Error('Cannot replace a native session')
    connections.set(this, { id: randomUUID(), events: [], token: input.environment!.variables.GRAPHQL_APP_MCP_TOKEN!, sessionId: reference.nativeSessionId })
    event(this, 'thread.attached', { threadId: reference.nativeSessionId })
    return reference
  })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'startTurn').mockImplementation(async function* (this: CodexAppServerSessionManager, reference, input) {
    native.starts.push(input.clientCorrelationId)
    const saved = sessions.get(reference.nativeSessionId)!
    saved.turns.set(input.clientCorrelationId, undefined)
    yield event(this, 'turn.started', { threadId: reference.nativeSessionId, turnId: input.clientCorrelationId, clientCorrelationId: input.clientCorrelationId })
    if (input.clientCorrelationId.startsWith('review-')) {
      const interactionId = /interaction (\S+)\./.exec(input.prompt)![1]!
      const interaction = (await interactions.get(interactionId))!
      await mcp(connections.get(this)!.token, { interactionId, optionId: interaction.responseOptions[0]!.optionId, expectedRevision: interaction.revision })
      saved.turns.set(input.clientCorrelationId, { outcome: 'succeeded', output: { text: 'review result' } })
    } else if (saved.input.request.workflowNodeId === 'orchestrator') saved.turns.set(input.clientCorrelationId, success)
    else {
      saved.pending = [ask(reference, ++saved.asks)]
      yield event(this, 'interaction.pending', { nativeRequestId: saved.pending[0]!.turn.nativeRequestId })
      return
    }
    yield event(this, 'turn.completed', { threadId: reference.nativeSessionId, turnId: input.clientCorrelationId })
  })
  const history = function (manager: CodexAppServerSessionManager, reference: NativeSessionReference, correlationId?: string): NativeHistory {
    const saved = sessions.get(reference.nativeSessionId)!
    const result = correlationId ? saved.turns.get(correlationId) : undefined
    if (correlationId) event(manager, 'thread.reconciled', { thread: { id: reference.nativeSessionId,
      status: saved.pending.length ? 'active' : 'idle', turns: [...saved.turns].map(([id, value]) => ({ id, clientUserMessageId: id, status: value ? 'completed' : 'inProgress' })) } })
    return { events: [...connections.get(manager)!.events], pendingInteractions: [...saved.pending],
      ...(result && correlationId ? { terminalResult: result, terminalTurn: { correlationId, providerId: correlationId, result } } : {}) }
  }
  vi.spyOn(CodexAppServerSessionManager.prototype, 'history').mockImplementation(async function (this: CodexAppServerSessionManager, reference) { return history(this, reference) })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'reconcile').mockImplementation(async function (this: CodexAppServerSessionManager, reference, correlation) { return history(this, reference, correlation) })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'respond').mockImplementation(async function (this: CodexAppServerSessionManager, reference, requestId) {
    const saved = sessions.get(reference.nativeSessionId)!
    expect(saved.pending.some((item) => item.turn.nativeRequestId === requestId)).toBe(true)
    native.responses++
    if (repeatedApproval && saved.input.request.workflowNodeId === 'worker-a' && saved.asks < 2) {
      saved.pending = [ask(reference, ++saved.asks)]
    } else {
      saved.pending = []
      saved.turns.set(`execution:${saved.input.request.executionId}`, success)
    }
  })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'cancel').mockResolvedValue(true)
  vi.spyOn(CodexAppServerSessionManager.prototype, 'close').mockImplementation(async () => { native.closes++ })
  vi.spyOn(ReviewerDispatcher.prototype, 'reconcile').mockResolvedValue() // manually drive the real dispatcher between crash boundaries
  production = buildProductionApp(config, database, checkpoints, false)
  address = await production.app.listen({ host: '127.0.0.1', port: 0 })
})

afterEach(async () => {
  await production?.shutdown()
  for (const old of retired.splice(0)) await old.shutdown()
  await production?.app.close()
  await checkpoints?.close(); await database?.close()
  await admin?.query(`drop schema if exists "${schema}" cascade`)
  await admin?.query(`drop schema if exists "${schema}_checkpoints" cascade`)
  await admin?.end()
  await rm(root, { recursive: true, force: true }); await rm(project, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function start(handler: 'user' | 'orchestrator', twoWorkers = false) {
  const workflows = new PostgresWorkflowRepository(database.pool)
  const saved = (await workflows.get('workspace-1', 'workflow-content-pipeline'))!
  const nodes = [{ id: 'orchestrator', agentId: 'agent-researcher', name: 'Orchestrator' },
    { id: 'worker-a', agentId: 'agent-reviewer', name: 'Worker A' },
    ...(twoWorkers ? [{ id: 'worker-b', agentId: 'agent-reviewer', name: 'Worker B' }] : [])]
  await workflows.save('workspace-1', { ...saved, requiredAgentCount: 2, nodes,
    edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, source: nodes[index]!.id, target: node.id })),
    approval: { handler, ...(handler === 'orchestrator' ? { designatedOrchestratorAgentId: 'agent-researcher' } : {}) },
    executionPolicy: { maxParallelism: 1, maxNodeExecutions: nodes.length },
  })
  const issuer = await access.issue({ name: 'Run owner', audience: 'operator', grants: [{ actions: ['runs:start', 'runs:stop', 'workspace_locations:read', 'interactions:read', 'interactions:respond'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
  const version = (await workflows.getCurrentVersion('workspace-1', saved.id))!
  const accepted = await production.app.inject({ method: 'POST',
    url: `/api/management/workspaces/workspace-1/workflows/${saved.id}/runs`,
    headers: { authorization: `Bearer ${issuer.token}` },
    payload: { workflowVersionId: version.id, expectedLocationRevision: 1, commandId: randomUUID(), input: {} },
  })
  expect(accepted.statusCode, accepted.body).toBe(202)
  const run = accepted.json().run as NonNullable<Awaited<ReturnType<PostgresRunRepository['get']>>>
  await vi.waitFor(async () => expect((await runs.get(run.id))?.executionState).toBe('waiting'), { timeout: 3000 })
  return { run, issuer, pending: (await interactions.list({ runId: run.id, status: 'pending', limit: 10 }))[0]! }
}

it('answers a production User approval through its own authenticated API while excluding Operator and App authority', async () => {
  const { run, issuer, pending } = await start('user')
  const human = await access.issue({ name: 'Human', audience: 'user', grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { runIds: [run.id] } }], expiresAt: new Date(Date.now() + 60_000) })
  const url = `/api/user/interactions/${pending.id}/respond`
  const payload = { interactionId: pending.id, optionId: pending.responseOptions[0]!.optionId, expectedRevision: pending.revision }
  expect((await production.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${issuer.token}` }, payload })).statusCode).toBe(403)
  const worker = await new WorkerCredentialService(database.pool, access).issueForExecution(pending.executionId)
  expect((await production.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${worker.environment.variables.GRAPHQL_APP_MCP_TOKEN}` }, payload })).statusCode).toBe(403)
  await expect(mcp(worker.environment.variables.GRAPHQL_APP_MCP_TOKEN!, payload)).rejects.toThrow('Tool interaction_respond not found')
  const headers = { authorization: `Bearer ${human.token}` }
  const list = await production.app.inject({ method: 'GET', url: `/api/user/interactions?runId=${run.id}`, headers })
  expect(list.statusCode, list.body).toBe(200)
  expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([pending.id])
  expect((await production.app.inject({ method: 'GET', url: `/api/user/interactions/${pending.id}`, headers })).statusCode).toBe(200)
  expect((await production.app.inject({ method: 'GET', url: `/api/interactions/${pending.id}`, headers: { authorization: `Bearer ${issuer.token}` } })).statusCode).toBe(404)
  const response = await production.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${human.token}` }, payload })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json().interaction.deliveryState).toBe('delivered')
  expect((await runs.get(run.id))?.outcome).toBe('succeeded')
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
    const human = await access.issue({ name: 'Human', audience: 'user', grants: [{ actions: ['interactions:respond'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const response = await production.app.inject({ method: 'POST', url: `/api/user/interactions/${pending.id}/respond`,
      headers: { authorization: `Bearer ${human.token}` }, payload: { interactionId: pending.id, optionId: pending.responseOptions[0]!.optionId, expectedRevision: pending.revision } })
    expect(response.statusCode).toBe(change === 'location' ? 409 : 403)
    const untouched = await interactions.get(pending.id)
    expect(untouched?.selectedOptionId).toBeUndefined()
    expect(untouched?.status).toBe('pending')
  } finally { if (change === 'location') { await rm(project, { recursive: true }); await rename(`${project}-old`, project) } }
})

it('reviews through the completed Orchestrator session, survives restart and settles a lost acknowledgement while the next Worker waits', async () => {
  repeatedApproval = true
  const { run, pending } = await start('orchestrator', true)
  const orchestrator = (await runs.listExecutions(run.id)).find((item) => item.agentId === 'agent-researcher')!
  expect(orchestrator.state).toBe('completed')
  await expect(new WorkerCredentialService(database.pool, access).issueForExecution(orchestrator.id)).rejects.toMatchObject({ code: 'WORKER_EXECUTION_INACTIVE' })
  expect((await runtime().reviewers.dispatchNext('agent-researcher', 'first-approval'))?.state).toBe('completed')
  const secondAsk = (await interactions.list({ runId: run.id, status: 'pending', limit: 10 }))[0]!
  expect(secondAsk.executionId).toBe(pending.executionId)
  expect(secondAsk.nativeRequestId).not.toBe(pending.nativeRequestId)
  const finish = vi.spyOn(PostgresInteractionDeliveryRepository.prototype, 'finishGraphResume').mockRejectedValueOnce(new Error('acknowledgement lost'))
  const firstJob = await runtime().reviewers.dispatchNext('agent-researcher', 'test-worker')
  expect(firstJob?.state).toBe('completed')
  finish.mockRestore()
  expect((await runs.getExecution(pending.executionId))?.state).toBe('completed')
  expect((await runs.get(run.id))?.executionState).toBe('waiting')
  expect((await runs.getExecution(orchestrator.id))?.result).toEqual(success)
  expect(native.responses).toBe(2)
  const budget = (await database.pool.query('select active_started_at,active_elapsed_ms from approval_execution_state where execution_id=$1', [pending.executionId])).rows[0]
  await database.pool.query("update interaction_graph_resumes set lease_expires_at=now()-interval '1 second' where interaction_id=$1", [secondAsk.id])
  const old = production
  await old.app.close()
  retired.push(old)
  production = buildProductionApp(config, database, checkpoints, false)
  address = await production.app.listen({ host: '127.0.0.1', port: 0 })
  const report = vi.fn()
  await production.reconcile(report)
  expect(report).not.toHaveBeenCalled()
  expect((await database.pool.query('select state from interaction_graph_resumes where interaction_id=$1', [secondAsk.id])).rows[0].state).toBe('resumed')
  expect((await database.pool.query('select active_started_at,active_elapsed_ms from approval_execution_state where execution_id=$1', [pending.executionId])).rows[0]).toEqual(budget)
  expect((await runtime().reviewers.dispatchNext('agent-researcher', 'after-restart'))?.state).toBe('completed')
  expect((await runs.get(run.id))?.outcome).toBe('succeeded')
  expect(native.responses).toBe(3)
  expect(native.starts.filter((id) => id.startsWith('execution:'))).toHaveLength(3)
  expect((await database.pool.query("select count(*)::int as count from worker_credential_bindings where purpose='reviewer' and execution_id=$1", [orchestrator.id])).rows[0].count).toBe(2)
}, 15_000)


it('makes production Stop and native delivery progress with a one-slot pool', async () => {
  const { run, issuer, pending } = await start('user')
  const human = await access.issue({ name: 'Human', audience: 'user', grants: [{ actions: ['interactions:respond'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
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
  const human = await access.issue({ name: 'Human', audience: 'user', grants: [{ actions: ['interactions:respond'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
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


it('closes an idle retained reviewer when a later authorized App response completes the Run', async () => {
  repeatedApproval = true
  const { run } = await start('orchestrator')
  expect((await runtime().reviewers.dispatchNext('agent-researcher', 'first-review'))?.state).toBe('completed')
  expect((await runs.get(run.id))?.executionState).toBe('waiting')
  const orchestrator = (await runs.listExecutions(run.id)).find((item) => item.agentId === 'agent-researcher')!
  const reviewer = await new WorkerCredentialService(database.pool, access).issueForReviewer(orchestrator.id)
  const pending = (await interactions.list({ runId: run.id, status: 'pending', limit: 10 }))[0]!
  const response = await mcp(reviewer.environment.variables.GRAPHQL_APP_MCP_TOKEN!, {
    interactionId: pending.id, optionId: pending.responseOptions[0]!.optionId, expectedRevision: pending.revision,
  })
  expect(response.isError).not.toBe(true)
  expect((await runs.get(run.id))?.outcome).toBe('succeeded')
  expect(runtime().residentRunIds()).not.toContain(run.id)
  const attachments = native.attaches
  expect((await runtime().reviewers.dispatchNext('agent-researcher', 'obsolete-review'))?.state).toBe('failed')
  expect(native.attaches).toBe(attachments)
  expect((await database.pool.query('select count(*)::int as count from worker_credential_bindings where execution_id=$1 and revoked_at is null', [orchestrator.id])).rows[0].count).toBe(0)
})
