import { CODEX_APPROVAL_OPTIONS_FIXTURE, DEFAULT_HARNESS_DEFAULTS, DurableInteractionSchema, type AgentConfigurationVersion, type DurableInteraction } from '@foreman-code/contracts'
import { ManagementPrincipalSchema, type ManagementAction, type ManagementScope } from '@foreman-code/contracts/management'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'

import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { Wave25InteractionRepository } from '../src/modules/interactions/wave25/repository.js'
import type { NativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { InteractionService } from '../src/modules/interactions/service.js'
import { buildProductionApp } from '../src/production.js'
import { randomUUID } from 'node:crypto'
import * as nativeRetention from '../src/modules/harnesses/installedNativeQualificationRetention.js'
import { ProductionDeviceRuntime } from '../src/modules/devices/productionRuntime.js'
import type { DeviceEndpoint } from '../src/modules/devices/deviceEndpoint.js'
import { RunWorktrees } from '../src/modules/runs/runWorktrees.js'

vi.mock('../src/app.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app.js')>()
  return { ...actual, buildApp: vi.fn(actual.buildApp) }
})

const config = loadConfig({ DATABASE_URL: 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_composition' })
const scope = { workspaceIds: ['workspace-1'], workflowIds: ['workflow-1'], runIds: ['run-1'] }
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
    nativeRequestType: 'item/commandExecution/requestApproval', graphThreadId: 'run-1',
    request: { command: ['true'] }, approval: { handler: 'user' },
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
  expect(RunWorktrees.prototype.cleanup).toHaveBeenCalledExactlyOnceWith(report)
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
  vi.spyOn(RunWorktrees.prototype, 'cleanup').mockResolvedValue(undefined)
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
  expect(repository).toBeInstanceOf(Wave25InteractionRepository)
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
  expect(production.app.hasRoute({ method: 'GET', url: '/api/interactions' })).toBe(false)
  for (const url of ['/mcp', '/mcp']) expect(production.app.hasRoute({ method: 'POST', url })).toBe(true)
  const resume = vi.spyOn(production.engine, 'resumeInteraction').mockResolvedValue(undefined)
  const callback = Reflect.get(service, 'atomicApprovalResume') as
    Parameters<InteractionService['useAtomicApprovalResume']>[0] | undefined
  expect(callback).toBeTypeOf('function')
  // Construction-level wiring only: the spied engine receives the exact claim;
  // no SQL checkpoint, native response, or resume receipt is manufactured here.
  const claim = { interaction: current, ownerToken: 'composition-resume-owner' }
  await callback!(claim)
  expect(resume).toHaveBeenCalledExactlyOnceWith(current, claim)
})

it('retains Worker qualification against the outgoing profile-check channel', async () => {
  await production.app.close()
  const retained = vi.spyOn(nativeRetention, 'createInstalledNativeQualificationRetention')
  const binding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1, keyRevision: 1, authorizationRevision: 1 }
  const captureRequest = vi.fn(() => ({ binding, request: vi.fn() }))
  const currentBinding = vi.fn(() => undefined)
  vi.spyOn(ProductionDeviceRuntime.prototype, 'endpointForDomains').mockReturnValue(
    { captureRequest, currentBinding } as unknown as DeviceEndpoint)
  const run = vi.fn(async () => { throw new Error('Construction must not qualify a native runtime') })
  production = buildProductionApp(config, database, checkpoints, false, undefined, undefined, { codex: { harness: 'codex', revision: 'fixture', run } })
  expect(retained.mock.calls[0]![0].currentBinding(binding.deviceId)).toEqual(binding)
  expect(captureRequest).toHaveBeenCalledExactlyOnceWith(binding.deviceId, 'host-harness-check-v1')
  expect(currentBinding).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})

it.each(['codex'] as const)('constructs separate native %s managers for each accepted execution', (harness) => {
  const approvals: object = Reflect.get(production.engine, 'nativeExecutions') as object
  const managers = Reflect.get(approvals, 'managers') as NativeSessionManagerResolver
  // The factory consumes the harness portion; the execution coordinator validates
  // the complete durable configuration before it calls this factory.
  const configuration = {
    id: 'config-1', agentId: 'agent-1',
    harness: DEFAULT_HARNESS_DEFAULTS.codex,
  } as AgentConfigurationVersion
  const context = { executionId: 'execution-1', agentId: 'agent-1', workingDirectory: '/accepted/project', harness, configuration }
  const first = managers.resolve(context)
  expect(first.manager).toBeInstanceOf(CodexAppServerSessionManager)
  expect(first.processState).toBe('needs_start')

  expect(managers.resolve(context)).toMatchObject({ manager: first.manager, processState: 'needs_start', lifecycle: 'allocated' })
  const second = managers.resolve({ ...context, executionId: 'execution-2' })
  expect(second.manager).not.toBe(first.manager)
  expect(() => managers.resolve({ ...context, workingDirectory: '/unaccepted' })).toThrow()
})

it('does not register the removed Operator approval HTTP routes', async () => {
  expect(production.app.hasRoute({ method: 'GET', url: '/api/interactions' })).toBe(false)
  expect(production.app.hasRoute({ method: 'GET', url: '/api/interactions/:interactionId' })).toBe(false)
  expect(production.app.hasRoute({ method: 'POST', url: '/api/interactions/:interactionId/respond' })).toBe(false)
})
