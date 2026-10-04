import { agentWorkflowVersion } from './agentWorkflowFixture.js'
import { insertProviderRun, providerLaunchCredentials, providerAppEndpoint, stopProviderRun } from './wave25Br1003Runtime.js'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../../src/modules/access/workerCredentials.js'
import { openCodeMcpInspectorAdapter } from '../../src/modules/harnesses/opencodeMcpInspectorAdapter.js'
import { createWorkflowNativeCaptureChannel } from '../../src/modules/interactions/workflowNativeCapture.js'
import { createReviewNativeCaptureChannel } from '../../src/modules/interactions/reviewNativeCapture.js'
import { ReviewNativeProofServices } from '../../src/modules/interactions/reviewNativeProof.js'
import { PostgresRepeatReviewerBindings } from '../../src/modules/interactions/repeatReviewer.js'
import { PostgresWorkflowClosureStore } from '../../src/modules/interactions/workflowClosure.js'
import { createWorkflowRepositoryServices } from '../../src/modules/runs/workflowRepositoryServices.js'
import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { AgentConfigurationVersionSchema, type DurableInteraction } from '@graphql/contracts'
import { ExecutableWorkflowV3Schema, makeCurrentWorkflowFixture, WorkflowRunV3Schema } from '@graphql/contracts/wave25'
import { ApprovalPostgresSaver } from '../../src/infrastructure/approvalCheckpointSaver.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { OpenCodeNativeSessionManager } from '../../src/modules/harnesses/opencodeServer.js'
import { nativeMessageId } from '../../src/modules/harnesses/opencodeProtocol.js'
import { PostgresApprovalBudgetRepository } from '../../src/modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from '../../src/modules/interactions/execution.js'
import { InteractionService } from '../../src/modules/interactions/service.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../src/modules/interactions/runtimePorts.js'
import { Wave25InteractionRepository } from '../../src/modules/interactions/wave25/repository.js'
import { Wave25WorkerCredentialService } from '../../src/modules/interactions/wave25/credentials.js'
import { registerApprovalCheckpointResume } from '../../src/modules/runs/approvalCheckpointRegistration.js'
import { continuationValidator } from '../../src/modules/runs/continuation.js'
import { LangGraphWorkflowEngine } from '../../src/modules/runs/engine.js'
import { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { advanced, configuration, FixtureServer, permission } from '../opencode-fixtures.js'
import { agent3Database, seedAgent3 } from './wave25Agent3.js'

/** External HTTP/SSE-shaped provider port ONLY. All NativeHistory, response
 * receipts, graph observations and submission identities are produced by the
 * real OpenCode adapter. No provider process, network listener or model runs. */
export class Br1002OpenCodeServer extends FixtureServer {
  beforeReply?: () => Promise<void>
  constructor(readonly executionId: string, entry: boolean, options: { permissionPatterns?: string[] } = {}) {
    super()
    // Each execution owns a separate OpenCode process in production. Distinct
    // provider-issued session IDs also keep this deterministic fixture honest.
    this.config = { mcp: { 'graphql': { type: 'remote', url: providerAppEndpoint, enabled: true } } }
    this.mcpCredentialReferences['graphql'] = APP_MCP_TOKEN_ENVIRONMENT_VARIABLE
    this.mcp = { 'graphql': { status: 'connected' } }
    this.nextSessionIds.push(`ses_${executionId}`)
    this.onPrompt = (sessionID, body) => {
      const workflowCorrelation = `execution:${executionId}`
      if (body.messageID !== nativeMessageId(workflowCorrelation)) return // A review stays live until the test finishes it.
      if (entry) { this.complete(workflowCorrelation, 'entry complete', sessionID); return }
      const tool = this.assistant(String(body.messageID), 'Requesting permission', 'tool-calls', true, sessionID)
      const ask = { ...permission(`per_${executionId}`, sessionID),
        ...(options.permissionPatterns ? { patterns: options.permissionPatterns } : {}),
        tool: { messageID: String(tool.info.id), callID: `call_${executionId}` } }
      this.permissions.push(ask)
      this.emit('permission.asked', ask)
    }
  }
  override async request(path: string, init: RequestInit = {}, signal?: AbortSignal, generation?: number): Promise<Response> {
    const route = new URL(path, 'http://fixture.invalid').pathname
    const requestId = /^\/permission\/([^/]+)\/reply$/.exec(route)?.[1]
    const pending = requestId && this.permissions.find((item) => item.id === decodeURIComponent(requestId))
    if (pending) await this.beforeReply?.()
    const result = await super.request(path, init, signal, generation)
    if (pending && result.ok && init.method === 'POST') {
      // Actual reply endpoint accepted. The provider continues the SAME turn;
      // drop its terminal SSE notification, retaining only native history.
      this.finishFromHistory(`execution:${this.executionId}`, String(pending.sessionID))
    }
    return result
  }
  finishFromHistory(correlationId: string, sessionID: string) {
    const message = this.assistant(nativeMessageId(correlationId), 'finished', 'stop', true, sessionID)
    this.statuses.delete(sessionID)
    return message
  }
}

/** Real coordinator, dispatcher, SQL owner, repositories, registration and
 * ApprovalPostgresSaver. Only external transport and accepted filesystem
 * identity are substituted. Execution credential preparation uses the real inspector and SQL issuer.
 * Authenticated HTTP/MCP and a live provider are NOT qualified by this fixture. Reviewer decisions
 * below use a real issued SQL-scoped principal, not a fabricated binding. */
export async function br1002OpenCodeRuntime(handler: 'user' | 'orchestrator' = 'user',
  options: { permissionPatterns?: string[] } = {}) {
  const db = await agent3Database()
  let engine: LangGraphWorkflowEngine | undefined
  const adapters: OpenCodeNativeSessionManager[] = []
  try {
    const f = makeCurrentWorkflowFixture(randomUUID())
    const entry = f.version.definition.nodes.find((node) => node.id === f.version.entryNodeId)!
    const approval = handler === 'user' ? { handler } : { handler, designatedOrchestratorAgentId: entry.agentId }
    f.configurations = f.configurations.map((c) => AgentConfigurationVersionSchema.parse({ ...c,
      productRole: handler === 'orchestrator' && c.agentId === entry.agentId ? 'orchestrator' : 'coder',
      // Match validateReviewerBootstrap rather than enabling native auto-approval.
      // This is an isolated test configuration, not a production policy change.
      harness: handler === 'orchestrator' && c.agentId === entry.agentId ? {
        ...configuration(), autoApprove: false, advanced: { ...advanced(), permissionHandling: 'graphql_routed',
          permissionRules: [
            { permission: '*', pattern: '*', effect: 'deny' },
            { permission: 'graphql_interaction_get', pattern: '*', effect: 'allow' },
            { permission: 'graphql_interaction_respond', pattern: '*', effect: 'allow' },
          ] },
      } : configuration(),
    }))
    f.version.approval = approval
    f.version.definition.approval = approval
    if (handler === 'orchestrator') for (const node of f.version.definition.nodes) {
      if (node.id !== entry.id) f.version.definition.edges.push({ id: `approval-${node.id}`,
        kind: 'approval', source: entry.id, target: node.id })
    }
    f.version = agentWorkflowVersion(ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations }).version)
    f.run = WorkflowRunV3Schema.parse({ ...f.run, approval, agentConfigurationVersionIds: f.version.agentConfigurationVersionIds })
    await seedAgent3(db.pool, db.directory, f, { run: false })
    const access = new PostgresAccessService(db.pool)
    const authority = await access.issue({ name: 'BR1-002 Run authority', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000), grants: [
        { actions: ['runs:start', 'runs:stop'], scope: { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId] } },
        { actions: ['workspace_locations:read'], scope: { workspaceIds: [f.scope.workspaceId] } },
      ] })
    f.run = WorkflowRunV3Schema.parse({ ...f.run, authorizationPrincipalId: authority.principal.id })
    await insertProviderRun(db.pool, f)
    const user = await access.issue({ name: 'BR1-002 user', audience: 'user', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: {
        workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId], runIds: [f.run.id],
      } }] })
    const servers = new Map<string, Br1002OpenCodeServer>()
    const managers = new ExecutionScopedNativeSessionManagerResolver((context) => {
      let server = servers.get(context.executionId)
      if (!server) {
        server = new Br1002OpenCodeServer(context.executionId, context.agentId === entry.agentId, options)
        servers.set(context.executionId, server)
      }
      // FixtureServer retains external sessions/history across an adapter close.
      // A fresh review may attach to its completed host; its own live-start and
      // history settlement must then occur on that SAME manager/generation.
      const native = new OpenCodeNativeSessionManager({ server, ownerAgentId: context.agentId,
        appMcpServerName: 'graphql', expectedAppMcpEndpoint: 'http://127.0.0.1:4100/mcp/app' })
      adapters.push(native)
      return native
    })
    const saver = new ApprovalPostgresSaver(db.pool, undefined, { schema: db.schema })
    await saver.setup()
    const workflows = new PostgresWorkflowRepository(db.pool)
    const locations = new WorkspaceLocationService(db.pool, new PostgresCommandCoordinator(db.pool))
    vi.spyOn(locations, 'revalidateSnapshot').mockResolvedValue(undefined)
    const workflowCapture = createWorkflowNativeCaptureChannel()
    const nativeCapture = { capture: workflowCapture.capture.capture.bind(workflowCapture.capture) }
    const reviewCapture = createReviewNativeCaptureChannel()
    const runs = new PostgresRunRepository(db.pool, workflows, locations,
      { runtimeRoot: db.directory, ...createWorkflowRepositoryServices(workflowCapture.verify) })
    const repository = new Wave25InteractionRepository(db.pool, new ReviewNativeProofServices(reviewCapture.verify)), budgets = new PostgresApprovalBudgetRepository(db.pool)
    const credentials = new Wave25WorkerCredentialService(db.pool, access)
    const launchCredentials = providerLaunchCredentials(runs, locations, managers, credentials, (manager) => {
      if (!(manager instanceof OpenCodeNativeSessionManager)) throw new Error('Expected OpenCode native manager')
      return openCodeMcpInspectorAdapter(manager)
    }, db.pool)
    const native = new ApprovalExecutionCoordinator(runs, repository, budgets, managers, 600000,
      launchCredentials, continuationValidator(db.pool, locations),
      new PostgresWorkflowClosureStore(db.pool), new PostgresRepeatReviewerBindings(db.pool),
      nativeCapture, reviewCapture.capture)
    engine = new LangGraphWorkflowEngine(runs, workflows, native, saver, db.directory,
      locations, launchCredentials, repository, undefined, { workerParallelism: 2 })
    const activeEngine = engine
    const service = new InteractionService(repository, budgets, native, (i) => activeEngine.resumeInteraction(i))
    registerApprovalCheckpointResume(service, engine)
    const config = { configurable: { thread_id: f.run.id } }
    return { db, f, engine, native, runs, repository, service, saver, config, servers, credentials, access,
      nativeCapture, nativeVerification: workflowCapture.verify,
      principal: user.principal, authorizationPrincipalId: authority.principal.id,
      stop: () => stopProviderRun(runs, f, authority.principal.id),
      async pending() { return repository.list({ runId: f.run.id, limit: 100 }) },
      async receipts() { return (await db.pool.query(`select entity_id,effect_digest,first_sequence::text
        from run_graph_effects where run_id=$1 and effect_kind='graph.resume' order by entity_id`, [f.run.id])).rows },
      counts() {
        const calls = [...servers.values()].flatMap((server) => server.calls)
        return { sessions: calls.filter((c) => c.method === 'POST' && c.path.startsWith('/session?')).length,
          prompts: calls.filter((c) => c.path.includes('/prompt_async')).length,
          responses: calls.filter((c) => /^\/permission\/[^/]+\/reply/.test(c.path)).length }
      },
      async close() {
        try { await activeEngine.shutdown() }
        finally { try { for (const adapter of adapters) await adapter.dispose() } finally { await db.close() } }
      } }
  } catch (error) {
    try { await engine?.shutdown() } finally {
      try { for (const adapter of adapters) await adapter.dispose() } finally { await db.close() }
    }
    throw error
  }
}

export function br1002Response(interaction: DurableInteraction) {
  const option = interaction.responseOptions.find((item) => item.semantic === 'approve_once')
  if (!option) throw new Error('Expected the actual OpenCode approve-once option')
  return { interactionId: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision }
}
