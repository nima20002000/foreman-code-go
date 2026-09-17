import {
  CODEX_APPROVAL_OPTIONS_FIXTURE,
  DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
  DurableInteractionSchema,
  type AgentConfigurationVersion,
  type DurableInteraction,
} from '@graphql/contracts'
import { ManagementPrincipalSchema, type ManagementAction, type ManagementScope } from '@graphql/contracts/management'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import type { NativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { InteractionService } from '../src/modules/interactions/service.js'
import { buildProductionApp } from '../src/production.js'

vi.mock('../src/app.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app.js')>()
  return { ...actual, buildApp: vi.fn(actual.buildApp) }
})

const config = loadConfig({ DATABASE_URL: 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_composition' })
const scope = { workspaceIds: ['workspace-1'], workflowIds: ['workflow-1'], runIds: ['run-1'] }
const listUrl = '/api/interactions?workspaceId=workspace-1&workflowId=workflow-1&runId=run-1'
const headers = { authorization: 'Bearer test-operator' }
function operator(actions: ManagementAction[] = ['interactions:read', 'interactions:respond'], grantScope: ManagementScope = scope) {
  return ManagementPrincipalSchema.parse({
    id: 'operator-1', name: 'Composition test Operator', audience: 'operator',
    grants: [{ actions, scope: grantScope }], revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
}
function interaction(overrides: Partial<DurableInteraction> = {}): DurableInteraction {
  return DurableInteractionSchema.parse({
    id: 'interaction-1', revision: 0, workspaceId: 'workspace-1', workflowId: 'workflow-1',
    runId: 'run-1', executionId: 'execution-1', requestingAgentId: 'agent-1', harness: 'codex',
    providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'native-session-1', nativeRequestId: 'native-request-1',
    nativeRequestType: 'item/commandExecution/requestApproval', graphThreadId: 'thread-1',
    request: { command: ['true'] }, approval: { handler: 'operator' },
    responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE, status: 'pending', deliveryState: 'not_started',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides,
  })
}

let principal = operator()
let current = interaction()
let database: ReturnType<typeof createDatabase>
let checkpoints: ReturnType<typeof createCheckpointStore>
let production: ReturnType<typeof buildProductionApp>
const list = vi.fn<InteractionService['list']>()
const get = vi.fn<InteractionService['get']>()
const respond = vi.fn<InteractionService['respond']>()

it('production recovery drains every delivery page and coalesces concurrent ticks', async () => {
  const recover = vi.spyOn(InteractionService.prototype, 'recover')
    .mockResolvedValueOnce({ nextCursor: 'next-interaction', errors: [] })
    .mockResolvedValueOnce({ nextCursor: null, errors: [] })
  vi.spyOn(production.engine, 'reconcile').mockResolvedValue()
  const report = vi.fn()
  await Promise.all([production.reconcile(report), production.reconcile(report)])
  expect(recover.mock.calls).toEqual([[{ limit: 100 }], [{ limit: 100, afterId: 'next-interaction' }]])
  expect(report).not.toHaveBeenCalled()
})

it('production shutdown closes recovery admission and waits for the in-flight pass', async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => { finish = resolve })
  vi.spyOn(production.engine, 'reconcile').mockImplementation(() => pending)
  vi.spyOn(production.engine, 'shutdown').mockResolvedValue()
  const recover = vi.spyOn(InteractionService.prototype, 'recover')
  const running = production.reconcile(vi.fn())
  const stopping = production.shutdown()
  finish()
  await Promise.all([running, stopping])
  await production.reconcile(vi.fn())
  expect(recover).not.toHaveBeenCalled()
})

beforeEach(() => {
  principal = operator()
  current = interaction()
  list.mockReset().mockImplementation(async () => ({ items: [current], nextCursor: null }))
  get.mockReset().mockImplementation(async () => current)
  respond.mockReset().mockImplementation(async () => ({ interaction: current, replayed: false }))
  vi.spyOn(InteractionService.prototype, 'list').mockImplementation(list)
  vi.spyOn(InteractionService.prototype, 'get').mockImplementation(get)
  vi.spyOn(InteractionService.prototype, 'respond').mockImplementation(respond)
  vi.spyOn(PostgresCommandCoordinator.prototype, 'recordDenied').mockResolvedValue(undefined)
  vi.spyOn(PostgresAccessService.prototype, 'authenticate').mockImplementation(async (token, audience) => {
    if (token !== 'test-operator' || principal.audience !== audience) throw new DomainError('AUTH_REQUIRED', 'Authentication required.', 401)
    return principal
  })
  vi.mocked(buildApp).mockClear()
  // These are the production infrastructure constructors. No test assembles a
  // separate service graph, and no query/native process is needed for these checks.
  database = createDatabase(config.database)
  checkpoints = createCheckpointStore(config.database.connectionString, 'composition_checkpoints', config.database)
  production = buildProductionApp(config, database, checkpoints, false)
})

afterEach(async () => {
  await production.app.close()
  await production.engine.shutdown()
  await Promise.all([database.close(), checkpoints.close()])
  vi.restoreAllMocks()
})

it('uses one real approval runtime across production HTTP, Operator MCP, App MCP, and targeted resume', async () => {
  const options = vi.mocked(buildApp).mock.calls.at(-1)![0]
  const service = options.product!.interactions!
  const approvals: unknown = Reflect.get(production.engine, 'nativeExecutions')
  const repository: unknown = Reflect.get(production.engine, 'interactions')
  expect(approvals).toBeInstanceOf(ApprovalExecutionCoordinator)
  expect(repository).toBeInstanceOf(PostgresInteractionRepository)
  expect(service).toBeInstanceOf(InteractionService)
  expect(service).toHaveProperty('nativeRuntime', approvals)
  expect(service).toHaveProperty('interactions', repository)
  expect(approvals).toHaveProperty('credentials', Reflect.get(production.engine, 'workerCredentials'))
  expect(Reflect.get(production.engine, 'workerCredentials')).toHaveProperty('prepare', expect.any(Function))
  expect(options.operator!.services.interactions).toHaveProperty('service', service)
  expect(options.appMcp!.interactions).toHaveProperty('orchestration', service)
  expect(options.appMcp!.access).toBe(options.operator!.access)
  expect(options.mcpDetection?.service).toBeDefined()
  await production.app.ready()
  for (const url of ['/api/interactions', '/mcp/operator', '/mcp/tools']) {
    expect(production.app.hasRoute({ method: url === '/api/interactions' ? 'GET' : 'POST', url })).toBe(true)
  }
  const resume = vi.spyOn(production.engine, 'resumeInteraction').mockResolvedValue(undefined)
  const callback = Reflect.get(service, 'resumeGraph') as (value: DurableInteraction) => Promise<void>
  await callback(current)
  expect(resume).toHaveBeenCalledExactlyOnceWith(current)
})

it('constructs separate OpenCode managers with the pinned configuration, owner, and accepted directory', () => {
  const approvals: object = Reflect.get(production.engine, 'nativeExecutions') as object
  const managers = Reflect.get(approvals, 'managers') as NativeSessionManagerResolver
  // The factory consumes the harness portion; the execution coordinator validates
  // the complete durable configuration before it calls this factory.
  const configuration = {
    id: 'config-1', agentId: 'agent-1',
    harness: { harness: 'opencode', advanced: DEFAULT_OPENCODE_ADVANCED_CONFIGURATION },
  } as AgentConfigurationVersion
  const context = { executionId: 'execution-1', agentId: 'agent-1', workingDirectory: '/accepted/project', harness: 'opencode' as const, configuration }
  const first = managers.resolve(context)
  expect(first.manager).toBeInstanceOf(OpenCodeNativeSessionManager)
  expect(first.processState).toBe('needs_start')
  expect(first.manager).toHaveProperty('options.ownerAgentId', context.agentId)
  expect(first.manager).toHaveProperty('options.server.options.workingDirectory', context.workingDirectory)
  expect(first.manager).toHaveProperty('options.server.advancedConfiguration', configuration.harness.advanced)
  expect(managers.resolve(context)).toMatchObject({ manager: first.manager, processState: 'needs_start', lifecycle: 'allocated' })
  const second = managers.resolve({ ...context, executionId: 'execution-2' })
  expect(second.manager).not.toBe(first.manager)
  expect(() => managers.resolve({ ...context, workingDirectory: '/unaccepted' })).toThrow()
})

it.each(['GET', 'POST'] as const)('requires authentication for interaction %s', async (method) => {
  const response = await production.app.inject({ method, url: method === 'GET' ? listUrl : '/api/interactions/interaction-1/respond' })
  expect(response.statusCode).toBe(401)
  expect(list).not.toHaveBeenCalled()
  expect(respond).not.toHaveBeenCalled()
})

it.each(['GET', 'POST'] as const)('does not accept capabilities:read for interaction %s', async (method) => {
  principal = operator(['capabilities:read'], {})
  const response = await production.app.inject({ method, headers, url: method === 'GET' ? listUrl : '/api/interactions/interaction-1/respond' })
  expect(response.statusCode).toBe(403)
  expect(list).not.toHaveBeenCalled()
  expect(respond).not.toHaveBeenCalled()
})

it('passes all validated list filters through under the actual scoped grant', async () => {
  const response = await production.app.inject({ method: 'GET', headers, url: `${listUrl}&status=pending&limit=7` })
  expect(response.statusCode).toBe(200)
  expect(list).toHaveBeenCalledExactlyOnceWith({
    workspaceId: 'workspace-1', workflowId: 'workflow-1', runId: 'run-1', handler: 'operator', status: 'pending', limit: 7,
  })
  expect(response.json().items).toHaveLength(1)
})

it('allows HEAD with read-only grants', async () => {
  principal = operator(['interactions:read'])
  expect((await production.app.inject({ method: 'HEAD', headers, url: listUrl })).statusCode).toBe(200)
})

it.each([
  '/api/interactions',
  `${listUrl.replace('workspace-1', 'workspace-other')}`,
  `${listUrl.replace('workflow-1', 'workflow-other')}`,
  `${listUrl.replace('run-1', 'run-other')}`,
])('rejects a list outside its full grant: %s', async (url) => {
  expect((await production.app.inject({ method: 'GET', headers, url })).statusCode).toBe(403)
  expect(list).not.toHaveBeenCalled()
})

it.each(['workspaceId', 'workflowId', 'runId'] as const)('checks the stored %s, not caller-supplied get/respond scope', async (field) => {
  current = interaction({ [field]: 'outside-grant' })
  const read = await production.app.inject({ method: 'GET', headers, url: '/api/interactions/interaction-1' })
  const write = await production.app.inject({
    method: 'POST', headers, url: '/api/interactions/interaction-1/respond',
    payload: { interactionId: current.id, optionId: current.responseOptions[0]!.optionId, expectedRevision: 0 },
  })
  expect(read.statusCode).toBe(404)
  expect(write.statusCode).toBe(404)
  expect(respond).not.toHaveBeenCalled()
})

it.each(['user', 'orchestrator'] as const)('never lets an Operator take a %s-assigned interaction', async (handler) => {
  current = interaction({ approval: handler === 'user' ? { handler } : { handler, designatedOrchestratorAgentId: 'agent-reviewer' } })
  const read = await production.app.inject({ method: 'GET', headers, url: '/api/interactions/interaction-1' })
  const write = await production.app.inject({
    method: 'POST', headers, url: '/api/interactions/interaction-1/respond',
    payload: { interactionId: current.id, optionId: current.responseOptions[0]!.optionId, expectedRevision: 0 },
  })
  expect(read.statusCode).toBe(404)
  expect(write.statusCode).toBe(404)
  expect(respond).not.toHaveBeenCalled()
})

it('does not leak out-of-scope rows or their cursor', async () => {
  const hidden = interaction({ id: 'interaction-hidden', runId: 'run-other' })
  list.mockResolvedValue({ items: [current, hidden, interaction({ id: 'user-only', approval: { handler: 'user' } })], nextCursor: hidden.id })
  const response = await production.app.inject({ method: 'GET', headers, url: listUrl })
  expect(response.statusCode).toBe(200)
  expect(response.json().items.map((item: DurableInteraction) => item.id)).toEqual([current.id])
  expect(response.json().nextCursor).toBeNull()
})

it('rejects an unauthorized cursor before listing', async () => {
  get.mockResolvedValue(interaction({ id: 'hidden-cursor', runId: 'run-other' }))
  expect((await production.app.inject({ method: 'GET', headers, url: `${listUrl}&cursor=hidden-cursor` })).statusCode).toBe(404)
  expect(list).not.toHaveBeenCalled()
})

it('preserves the authenticated Operator identity for responses, without requiring read permission', async () => {
  principal = operator(['interactions:respond'])
  const payload = { interactionId: current.id, optionId: current.responseOptions[0]!.optionId, expectedRevision: 0 }
  const response = await production.app.inject({ method: 'POST', headers, url: '/api/interactions/interaction-1/respond', payload })
  expect(response.statusCode).toBe(200)
  expect(respond).toHaveBeenCalledExactlyOnceWith({ kind: 'operator', principal }, payload)
})

it('does not allow read permission to make a decision', async () => {
  principal = operator(['interactions:read'])
  const response = await production.app.inject({
    method: 'POST', headers, url: '/api/interactions/interaction-1/respond',
    payload: { interactionId: current.id, optionId: current.responseOptions[0]!.optionId, expectedRevision: 0 },
  })
  expect(response.statusCode).toBe(403)
  expect(respond).not.toHaveBeenCalled()
})

it('keeps browser CSRF protection on interaction decisions', async () => {
  const response = await production.app.inject({
    method: 'POST', headers: { cookie: 'graphql_operator=test-operator' }, url: '/api/interactions/interaction-1/respond',
    payload: { interactionId: current.id, optionId: current.responseOptions[0]!.optionId, expectedRevision: 0 },
  })
  expect(response.statusCode).toBe(403)
  expect(response.json().error.code).toBe('CSRF_ORIGIN_REQUIRED')
  expect(respond).not.toHaveBeenCalled()
})

it('rejects a mismatched payload identity before delivery', async () => {
  const response = await production.app.inject({
    method: 'POST', headers, url: '/api/interactions/interaction-1/respond',
    payload: { interactionId: 'interaction-other', optionId: current.responseOptions[0]!.optionId, expectedRevision: 0 },
  })
  expect(response.statusCode).toBe(400)
  expect(respond).not.toHaveBeenCalled()
})
