import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEX_APPROVAL_OPTIONS_FIXTURE, DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
  type ExecutionResult, type NativeHarnessEvent, type NativeSessionReference, type PendingNativeInteraction,
} from '@graphql/contracts'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { WorkerCredentialService } from '../src/modules/access/workerCredentials.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
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

/** Narrow copy of the existing production-lifecycle restart fixture at 3343399.
 * The original test is deliberately untouched. Only provider I/O is doubled;
 * production shutdown, fresh managers, SQL receipts, credentials, writer lanes,
 * HTTP/MCP, checkpoints and the lost-resume-ack path are real. Opt in with an
 * explicit loopback TEST_DATABASE_URL; this test never starts a DB or provider. */
describe.skipIf(!process.env.TEST_DATABASE_URL)('BE-001 production graceful restart receipts', () => {
  let schema: string, root: string, project: string, address: string
  let admin: pg.Pool, database: ReturnType<typeof createDatabase>, checkpoints: ReturnType<typeof createCheckpointStore>
  let production: ReturnType<typeof buildProductionApp>, config: ReturnType<typeof loadConfig>
  let runs: PostgresRunRepository, interactions: PostgresInteractionRepository, access: PostgresAccessService
  const retired: Array<ReturnType<typeof buildProductionApp>> = []
  const success: ExecutionResult = { outcome: 'succeeded', output: { text: 'workflow result' } }
  type ProviderSession = { input: WorkflowNativeSessionStart; pending: PendingNativeInteraction[]; turns: Map<string, ExecutionResult | undefined>; asks: number }
  type Connection = { id: string; events: NativeHarnessEvent[]; token: string; sessionId: string }
  let sessions: Map<string, ProviderSession>, connections: WeakMap<object, Connection>
  let native: { starts: string[]; attaches: number; responses: number; closes: number; cancels: number }

  function event(manager: object, type: string, payload: Record<string, unknown>) {
    const local = connections.get(manager)!
    const value = { connectionId: local.id, sequence: local.events.length, type, payload, occurredAt: new Date().toISOString() }
    local.events.push(value)
    return value
  }
  const providerId = (manager: { harness: 'codex' | 'opencode' }, correlation: string) => manager.harness === 'opencode'
    ? `msg_${createHash('sha256').update(correlation).digest('hex').slice(0, 24)}` : correlation
  function ask(reference: NativeSessionReference, suffix: number): PendingNativeInteraction {
    return { session: reference, turn: { nativeTurnId: 'workflow-turn', nativeRequestId: `ask-${reference.nativeSessionId}-${suffix}` },
      nativeRequestType: 'item/commandExecution/requestApproval', request: { command: 'test' }, responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE }
  }
  function runtime() { return Reflect.get(production.engine, 'nativeExecutions') as ApprovalExecutionCoordinator }
  async function mcp(token: string, input: Record<string, unknown>) {
    const client = new Client({ name: 'be001-production-review', version: '1.0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return await client.callTool({ name: 'interaction_respond', arguments: input })
    } finally { await client.close() }
  }

  beforeEach(async () => {
    const connectionString = process.env.TEST_DATABASE_URL!
    const parsed = new URL(connectionString)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Use an explicit isolated loopback test database')
    schema = `be001_life_${randomUUID().replaceAll('-', '')}`
    root = await mkdtemp(join(tmpdir(), 'be001-runtime-'))
    project = await mkdtemp(join(tmpdir(), 'be001-project-'))
    admin = new pg.Pool({ connectionString })
    await admin.query(`create schema "${schema}"`)
    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schema}`)
    config = loadConfig({ DATABASE_URL: url.toString(), DATABASE_POOL_MAX: '1', DATABASE_QUERY_TIMEOUT_MS: '5000', HARNESS_WORKSPACE_ROOT: root, HARNESS_TIMEOUT_MS: '5000', PORT: '4100' })
    config.workspaceStorageRoot = project
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
    sessions = new Map(); connections = new WeakMap()
    native = { starts: [], attaches: 0, responses: 0, closes: 0, cancels: 0 }
    vi.spyOn(CodexAppServerSessionManager.prototype, 'inspectMcpConfiguration').mockImplementation(async (cwd) => ({
      providerVersion: '0.154.0', binary: 'fixture', cwd, serverName: 'graphql', inspectionScope: 'effective_config', configured: {
        enabled: true, required: true, transport: 'streamable_http', url: 'http://127.0.0.1:4100/mcp',
        bearerTokenEnvironmentVariable: 'GRAPHQL_MCP_TOKEN', enabledTools: null, disabledTools: [], defaultToolsApprovalMode: null, tools: {},
      },
    }))
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
      yield event(this, 'turn.started', { threadId: reference.nativeSessionId, turnId, clientCorrelationId: input.clientCorrelationId })
      if (input.clientCorrelationId.startsWith('review-')) {
        const interactionId = /interaction (\S+)\./.exec(input.prompt)![1]!
        const interaction = (await interactions.get(interactionId))!
        await mcp(connections.get(this)!.token, {
          interactionId, optionId: interaction.responseOptions[0]!.optionId, expectedRevision: interaction.revision,
        })
        saved.turns.set(input.clientCorrelationId, { outcome: 'succeeded', output: { text: 'review result' } })
      } else if (saved.input.request.workflowNodeId === 'orchestrator') saved.turns.set(input.clientCorrelationId, success)
      else {
        saved.pending = [ask(reference, ++saved.asks)]
        yield event(this, 'interaction.pending', { nativeRequestId: saved.pending[0]!.turn.nativeRequestId })
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
    vi.spyOn(CodexAppServerSessionManager.prototype, 'reconcile').mockImplementation(async function (this: CodexAppServerSessionManager, reference, correlation) { return history(this, reference, correlation) })
    vi.spyOn(CodexAppServerSessionManager.prototype, 'pending').mockImplementation(async (_reference) => sessions.get(_reference.nativeSessionId)?.pending[0])
    vi.spyOn(CodexAppServerSessionManager.prototype, 'respond').mockImplementation(async function (this: CodexAppServerSessionManager, reference, requestId) {
      const saved = sessions.get(reference.nativeSessionId)!
      expect(saved.pending.some((item) => item.turn.nativeRequestId === requestId)).toBe(true)
      native.responses++
      if (saved.input.request.workflowNodeId === 'worker-a' && saved.asks < 2) saved.pending = [ask(reference, ++saved.asks)]
      else { saved.pending = []; saved.turns.set(`execution:${saved.input.request.executionId}`, success) }
    })
    vi.spyOn(CodexAppServerSessionManager.prototype, 'cancel').mockImplementation(async () => { native.cancels++; return true })
    vi.spyOn(CodexAppServerSessionManager.prototype, 'close').mockImplementation(async function (this: CodexAppServerSessionManager, reference) {
      expect(connections.get(this)?.sessionId).toBe(reference.nativeSessionId)
      native.closes++
    })
    vi.spyOn(OpenCodeNativeSessionManager.prototype, 'inspectNativeMcp').mockImplementation(async (cwd) => ({
      cwd, providerVersion: '1.18.31', serverName: 'graphql', nativeStatus: 'connected', transport: 'streamable-http',
      endpoint: 'http://127.0.0.1:4100/mcp', credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN',
      endpointMatches: true, baseConfigurationFilters: [], policyScope: 'base_configuration_only',
    }))
    for (const method of ['createSession', 'attachSession', 'startTurn', 'history', 'reconcile', 'pending', 'respond', 'cancel', 'close', 'closeForRestart'] as const) {
      vi.spyOn(OpenCodeNativeSessionManager.prototype, method).mockImplementation(CodexAppServerSessionManager.prototype[method] as never)
    }
    vi.spyOn(OpenCodeNativeSessionManager.prototype, 'dispose').mockResolvedValue()
    vi.spyOn(ReviewerDispatcher.prototype, 'reconcile').mockResolvedValue() // Drive the real dispatcher at the same crash cuts as the existing test.
    production = buildProductionApp(config, database, checkpoints, false)
    address = await production.app.listen({ host: '127.0.0.1', port: 0 })
  }, 60_000)

  afterEach(async () => {
    try {
      await production?.shutdown()
      for (const old of retired.splice(0)) await old.shutdown()
    } finally {
      await checkpoints?.close(); await database?.close()
      await admin?.query(`drop schema if exists "${schema}" cascade`)
      await admin?.query(`drop schema if exists "${schema}_checkpoints" cascade`)
      await admin?.end()
      if (root) await rm(root, { recursive: true, force: true })
      if (project) await rm(project, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  })

  async function start() {
    const workflows = new PostgresWorkflowRepository(database.pool)
    const saved = (await workflows.get('workspace-1', 'workflow-content-pipeline'))!
    await database.pool.query("update agent_configuration_versions set record=jsonb_set(record,'{harness}',$1::jsonb,true) where agent_id='agent-researcher'",
      [JSON.stringify({ harness: 'opencode', model: 'opencode-go/gpt-5.6-luna', variant: 'high', nativeAgent: 'build', thinking: false,
        autoApprove: false, advanced: { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, permissionRules: [
          { permission: '*', pattern: '*', effect: 'deny' },
          { permission: 'graphql_interaction_get', pattern: '*', effect: 'allow' },
          { permission: 'graphql_interaction_respond', pattern: '*', effect: 'allow' },
        ] } })])
    const nodes = [{ id: 'orchestrator', agentId: 'agent-researcher', name: 'Orchestrator' },
      { id: 'worker-a', agentId: 'agent-reviewer', name: 'Worker A' }, { id: 'worker-b', agentId: 'agent-reviewer', name: 'Worker B' }]
    await workflows.save('workspace-1', { ...saved, requiredAgentCount: 2, nodes,
      edges: [{ id: 'edge-0', source: 'orchestrator', target: 'worker-a' }, { id: 'edge-1', source: 'worker-a', target: 'worker-b' },
        { id: 'approval-worker-b', source: 'orchestrator', target: 'worker-b' }],
      approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-researcher' },
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
    return { run, pending: (await interactions.list({ runId: run.id, status: 'pending', limit: 10 }))[0]! }
  }

  it('persists retained reviewer/Worker closes at app.close, then survives restart and a lost acknowledgement with a succeeded Run', async () => {
    const { run, pending } = await start()
    const orchestrator = (await runs.listExecutions(run.id)).find((item) => item.agentId === 'agent-researcher')!
    expect(orchestrator.state).toBe('completed')
    await expect(new WorkerCredentialService(database.pool, access).issueForExecution(orchestrator.id)).rejects.toMatchObject({ code: 'WORKER_EXECUTION_INACTIVE' })
    expect((await runtime().reviewers.dispatchNext('agent-researcher', 'first-approval'))?.state).toBe('completed')
    await production.reconcile(() => undefined)
    const secondAsk = (await interactions.list({ runId: run.id, status: 'pending', limit: 10 }))[0]!
    expect(secondAsk.executionId).toBe(pending.executionId)
    expect(secondAsk.nativeRequestId).not.toBe(pending.nativeRequestId)
    const finish = vi.spyOn(PostgresInteractionDeliveryRepository.prototype, 'finishGraphResume').mockRejectedValueOnce(new Error('acknowledgement lost'))
    expect((await runtime().reviewers.dispatchNext('agent-researcher', 'test-worker'))?.state).toBe('completed')
    await production.reconcile(() => undefined)
    finish.mockRestore()
    expect((await runs.getExecution(pending.executionId))?.state).toBe('completed')
    expect((await runs.get(run.id))?.executionState).toBe('waiting')
    expect(native.responses).toBe(2)
    const budget = (await database.pool.query('select active_started_at,active_elapsed_ms from approval_execution_state where execution_id=$1', [pending.executionId])).rows[0]
    await database.pool.query("update interaction_graph_resumes set lease_expires_at=now()-interval '1 second' where interaction_id=$1", [secondAsk.id])
    const closureRows = async () => (await database.pool.query<{
      execution_id: string; generation: string; closed: boolean; workflow_node_id: string; closed_reference: NativeSessionReference | null
    }>(`select c.execution_id,c.generation::text,c.closed_at is not null as closed,e.workflow_node_id,c.closed_reference
      from execution_native_closures c join harness_executions e on e.id=c.execution_id
      where e.run_id=$1 order by c.generation`, [run.id])).rows
    const before = await closureRows()
    expect(before.filter((row) => !row.closed).map((row) => row.workflow_node_id).sort()).toEqual(['orchestrator', 'worker-b'])
    const waiting = await runs.get(run.id)
    const exchanges = await interactions.list({ runId: run.id, limit: 100 })
    const credentials = (await database.pool.query('select principal_id,revoked_at from worker_credential_bindings where run_id=$1 order by principal_id', [run.id])).rows
    const cancels = native.cancels
    const old = production
    await old.app.close()
    retired.push(old)
    // Before a fresh attach, not after: the old manager itself supplied closure.
    const disposed = await closureRows()
    expect(disposed.every((row) => row.closed)).toBe(true)
    expect(disposed.map((row) => row.generation)).toEqual(before.map((row) => row.generation))
    expect(await runs.get(run.id)).toEqual(waiting)
    expect(await interactions.list({ runId: run.id, limit: 100 })).toEqual(exchanges)
    expect((await database.pool.query('select principal_id,revoked_at from worker_credential_bindings where run_id=$1 order by principal_id', [run.id])).rows).toEqual(credentials)
    expect(native.cancels).toBe(cancels)
    expect((await database.pool.query('select stop_requested_at from runs where id=$1', [run.id])).rows[0].stop_requested_at).toBeNull()
    production = buildProductionApp(config, database, checkpoints, false)
    address = await production.app.listen({ host: '127.0.0.1', port: 0 })
    const report = vi.fn()
    await production.reconcile(report)
    expect(report).not.toHaveBeenCalled()
    expect((await database.pool.query('select state from interaction_graph_resumes where interaction_id=$1', [secondAsk.id])).rows[0].state).toBe('resumed')
    expect((await database.pool.query('select active_started_at,active_elapsed_ms from approval_execution_state where execution_id=$1', [pending.executionId])).rows[0]).toEqual(budget)
    expect((await runtime().reviewers.dispatchNext('agent-researcher', 'after-restart'))?.state).toBe('completed')
    await production.reconcile(report)
    expect(report).not.toHaveBeenCalled()
    expect((await runs.get(run.id))?.outcome).toBe('succeeded')
    expect((await runs.listExecutions(run.id)).map((item) => item.result?.outcome)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(native.responses).toBe(3)
    expect(native.starts.filter((id) => id.startsWith('execution:'))).toHaveLength(3)
    expect((await database.pool.query("select count(*)::int as count from worker_credential_bindings where purpose='reviewer' and execution_id=$1", [orchestrator.id])).rows[0].count).toBe(2)
    const after = await closureRows()
    expect(after.length).toBeGreaterThan(disposed.length)
    expect(after.every((row) => row.closed)).toBe(true)
    expect(after.slice(0, disposed.length)).toEqual(disposed)
  }, 20_000)
})
