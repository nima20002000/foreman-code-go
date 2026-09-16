import type {
  AgentConfigurationVersion, AgentHarness, HarnessExecution, HarnessExecutionRequest,
  NativeHarnessEvent, NativeSessionReference,
} from '@graphql/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeLanes } from './helpers/nativeLanes.js'

import { DEFAULT_WORKER_CREDENTIAL_TTL_MS, type IssuedWorkerCredential } from '../src/modules/access/workerCredentials.js'
import { WorkerLaunchCredentialService } from '../src/modules/harnesses/mcpDetection.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart } from '../src/modules/harnesses/port.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'

const createdAt = '2026-09-16T00:00:00.000Z'

afterEach(() => vi.restoreAllMocks())

function fixture(harness: AgentHarness = 'codex', started = true) {
  const configuration: AgentConfigurationVersion = {
    id: 'config-1', workspaceId: 'workspace-1', agentId: 'agent-1', version: 1,
    prompt: {}, assignedSkills: [], contentHash: 'sha256:pinned', createdAt,
    harness: harness === 'codex'
      ? { harness, model: 'fixture', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' }
      : { harness, model: 'fixture', variant: 'high', nativeAgent: 'plan', thinking: true, autoApprove: false },
  }
  let execution: HarnessExecution = {
    id: 'execution-1', runId: 'run-1', workflowNodeId: 'node-1', agentId: configuration.agentId,
    agentConfigurationVersionId: configuration.id, attempt: 1, input: {},
    state: started ? 'waiting' : 'starting', createdAt,
    workingDirectory: '/project', runtimeDirectory: '/runtime',
    ...(started ? { nativeSessionId: 'exact-native-session' } : {}),
  }
  const session: NativeSessionReference = {
    harness, providerVersion: harness === 'codex' ? '0.154.0' : '1.18.31', nativeSessionId: 'exact-native-session',
  }
  const context = {
    harness, executionId: execution.id, agentId: configuration.agentId, workingDirectory: '/project', configuration,
  }
  const request: HarnessExecutionRequest = {
    executionId: execution.id, runId: execution.runId, workspaceId: configuration.workspaceId,
    workflowNodeId: execution.workflowNodeId, workingDirectory: '/project', runtimeDirectory: '/runtime',
    configuration, input: {},
  }
  function manager() {
    return {
      harness,
      capabilities: vi.fn(async () => ({ providerVersion: session.providerVersion })),
      createSession: vi.fn(async (_input: NativeSessionStart) => { void _input; return session }),
      attachSession: vi.fn(async (reference: NativeSessionReference, _input: NativeSessionStart) => { void _input; return reference }),
      startTurn: vi.fn(async function* (): AsyncIterable<NativeHarnessEvent> {
        yield { sequence: 0, type: 'turn.completed', occurredAt: createdAt, payload: {} }
      }),
      pending: vi.fn(async () => undefined),
      history: vi.fn(async (): Promise<NativeHistory> => ({ events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded' } })),
      reconcile: vi.fn(async (): Promise<NativeHistory> => ({ events: [], pendingInteractions: [] })),
      cancel: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
    }
  }
  const managers: Array<ReturnType<typeof manager>> = []
  const resolver = new ExecutionScopedNativeSessionManagerResolver(() => {
    const instance = manager()
    managers.push(instance)
    return instance as unknown as NativeHarnessSessionManager
  })
  const issued: IssuedWorkerCredential[] = []
  const credentials = {
    prepare: vi.fn(async () => {
      const credential: IssuedWorkerCredential = {
        principalId: `principal-${issued.length + 1}`,
        environment: Object.freeze({
          agentId: configuration.agentId,
          variables: Object.freeze({ GRAPHQL_APP_MCP_TOKEN: `token-${issued.length + 1}` }),
        }),
        expiresAt: new Date(Date.now() + DEFAULT_WORKER_CREDENTIAL_TTL_MS).toISOString(),
      }
      issued.push(credential)
      return { credential, detection: {} as never }
    }),
    renew: vi.fn(async () => new Date(Date.now() + DEFAULT_WORKER_CREDENTIAL_TTL_MS).toISOString()),
    revoke: vi.fn(async () => undefined),
    revokeForExecution: vi.fn(async () => 1),
  }
  const budgets = {
    ensure: vi.fn(async () => undefined), assertActive: vi.fn(async () => undefined),
    beginWait: vi.fn(async () => undefined), finish: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
  }
  const runs = {
    getExecution: vi.fn(async () => execution),
    get: vi.fn(async () => ({ id: execution.runId, workspaceId: configuration.workspaceId })),
    getExecutionConfiguration: vi.fn(async () => configuration),
    ensureExecution: vi.fn(async () => ({ execution, created: !execution.nativeSessionId })),
    updateExecution: vi.fn(async (next: HarnessExecution) => { execution = next }),
    recordActivity: vi.fn(async () => undefined),
    appendNativeEvent: vi.fn(async () => undefined),
  }
  const interactions = { coordination: nativeLanes(), getForExecution: vi.fn(async () => undefined) }
  const coordinator = new ApprovalExecutionCoordinator(runs as never, interactions as never, budgets as never, resolver, 60_000, credentials)
  const observe = () => coordinator.ensureObserve({
    candidate: execution, request, approval: { handler: 'user' }, workflowId: 'workflow-1', graphThreadId: 'thread-1',
    owner: { client: {}, assertOwned() {} } as never, signal: new AbortController().signal,
  })
  return { configuration, context, session, resolver, managers, coordinator, credentials, issued, budgets, runs, observe }
}

it('does not mistake allocation or startup for residency, and fences stale handles', () => {
  const f = fixture()
  const first = f.resolver.resolve(f.context)
  expect(first.lifecycle).toBe('allocated')
  expect(f.resolver.resolve(f.context).processState).toBe('needs_start')
  expect(() => first.markResident!()).toThrow('unstarted')
  first.beginStart!()
  expect(first.lifecycle).toBe('starting')
  expect(f.resolver.resolve(f.context).processState).toBe('needs_start')
  expect(() => first.beginStart!()).toThrow('already starting')
  first.markResident!()
  expect(f.resolver.resolve(f.context).processState).toBe('resident')
  f.resolver.release(f.context, first.manager)
  expect(first.lifecycle).toBe('released')
  const second = f.resolver.resolve(f.context)
  f.resolver.release(f.context, first.manager, 'failed')
  expect(f.resolver.resolve(f.context)).toBe(second)
  expect(() => first.markResident!()).toThrow('released')
})

it('evicts preflight failures before attach, and retries with a fresh manager', async () => {
  const f = fixture()
  const first = f.resolver.resolve(f.context)
  f.credentials.prepare.mockRejectedValueOnce(new Error('preflight failed'))
  await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('preflight failed')
  expect(first.lifecycle).toBe('failed')
  expect(f.managers[0]!.attachSession).not.toHaveBeenCalled()
  expect(f.credentials.revokeForExecution).toHaveBeenCalledWith(f.context.executionId)
  await f.coordinator.attachOwnedSession(f.context, f.session)
  expect(f.managers).toHaveLength(2)
  expect(f.resolver.resolve(f.context).lifecycle).toBe('resident')
  expect(f.managers[1]!.attachSession.mock.calls[0]![0]).toBe(f.session)
  expect(f.managers[1]!.createSession).not.toHaveBeenCalled()
  expect(f.managers[1]!.startTurn).not.toHaveBeenCalled()
})

for (const started of [false, true]) {
  it(`cleans credential preflight failures in ensureObserve (${started ? 'recovery' : 'first start'})`, async () => {
    const f = fixture('codex', started)
    f.credentials.prepare.mockRejectedValueOnce(new Error('preflight failed'))
    await expect(f.observe()).rejects.toThrow('preflight failed')
    expect(f.credentials.revokeForExecution).toHaveBeenCalledWith(f.context.executionId)
    const failed = f.managers[0]!
    expect(failed.createSession).not.toHaveBeenCalled()
    expect(failed.attachSession).not.toHaveBeenCalled()
    const settled = await f.observe()
    expect(settled.state).toBe('completed')
    expect(settled.execution.result?.outcome).toBe('failed')
    expect(f.managers).toHaveLength(1)
    expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
  })
}

it('revokes resident credentials after attachment failure without preparing another environment', async () => {
  const f = fixture()
  await f.coordinator.attachOwnedSession(f.context, f.session)
  const resident = f.resolver.resolve(f.context)
  f.managers[0]!.history.mockRejectedValueOnce(new Error('attachment failed'))
  await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('attachment failed')
  expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
  expect(f.credentials.revokeForExecution).toHaveBeenCalledWith(f.context.executionId)
  expect(f.managers[0]!.close).toHaveBeenCalledWith(f.session)
  expect(resident.lifecycle).toBe('failed')
})

for (const harness of ['codex', 'opencode'] as const) {
  it(`renews ${harness} after a two-hour wait without changing its process, environment, or native identity`, async () => {
    const f = fixture(harness)
    await f.coordinator.attachOwnedSession(f.context, f.session)
    const credential = f.issued[0]!
    const originalExpiry = credential.expiresAt
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(originalExpiry) + 2 * 60 * 60 * 1000)
    await f.coordinator.attachOwnedSession(f.context, f.session)
    await f.coordinator.attachOwnedSession(f.context, f.session)
    expect(f.credentials.renew).toHaveBeenCalledTimes(1)
    expect(f.credentials.renew).toHaveBeenCalledWith(f.context.executionId, { principalId: credential.principalId })
    expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
    expect(f.managers).toHaveLength(1)
    const manager = f.managers[0]!
    expect(manager.attachSession.mock.calls[0]![1].environment).toBe(credential.environment)
    expect(manager.attachSession).toHaveBeenCalledTimes(1)
    expect(manager.history).toHaveBeenCalledTimes(2)
    expect(credential.expiresAt).toBe(originalExpiry)
    for (const [reference] of manager.attachSession.mock.calls) expect(reference).toBe(f.session)
    expect(manager.createSession).not.toHaveBeenCalled()
    expect(manager.startTurn).not.toHaveBeenCalled()
    expect(manager.close).not.toHaveBeenCalled()
  })
}

it('fails closed when renewal is refused rather than replacing a paused native process', async () => {
  const f = fixture()
  await f.coordinator.attachOwnedSession(f.context, f.session)
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.issued[0]!.expiresAt) + 1)
  f.credentials.renew.mockRejectedValueOnce(new Error('revoked credential'))
  await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('revoked credential')
  expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
  expect(f.managers[0]!.attachSession).toHaveBeenCalledTimes(1)
  expect(f.managers[0]!.createSession).not.toHaveBeenCalled()
  expect(f.credentials.revokeForExecution).toHaveBeenCalledWith(f.context.executionId)
})

it('never rotates a paused process when a provider has no same-token renewal support', async () => {
  const f = fixture()
  // Exercise the optional provider seam without changing an active process environment.
  Reflect.deleteProperty(f.credentials, 'renew')
  await f.coordinator.attachOwnedSession(f.context, f.session)
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.issued[0]!.expiresAt) + 1)
  await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('cannot be renewed')
  expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
  expect(f.managers).toHaveLength(1)
  expect(f.managers[0]!.createSession).not.toHaveBeenCalled()
  expect(f.managers[0]!.startTurn).not.toHaveBeenCalled()
  expect(f.credentials.revokeForExecution).toHaveBeenCalledWith(f.context.executionId)
})

it('prepares a fresh environment only after process release and reattaches the exact recovery identity', async () => {
  const f = fixture()
  await f.coordinator.attachOwnedSession(f.context, f.session)
  const old = f.managers[0]!
  await old.close()
  f.resolver.release(f.context, old as unknown as NativeHarnessSessionManager)
  await f.coordinator.attachOwnedSession(f.context, f.session)
  expect(f.credentials.prepare).toHaveBeenCalledTimes(2)
  expect(f.managers).toHaveLength(2)
  const replacement = f.managers[1]!
  expect(replacement.attachSession.mock.calls[0]![0]).toBe(f.session)
  expect(replacement.attachSession.mock.calls[0]![1].environment).toBe(f.issued[1]!.environment)
  expect(f.issued[1]!.principalId).not.toBe(f.issued[0]!.principalId)
  expect(replacement.createSession).not.toHaveBeenCalled()
  expect(replacement.startTurn).not.toHaveBeenCalled()
})

it('does not start a process with an expired prepared credential', async () => {
  const f = fixture()
  f.credentials.prepare.mockResolvedValueOnce({
    credential: { principalId: 'expired', environment: { agentId: 'agent-1', variables: {} }, expiresAt: createdAt },
    detection: {} as never,
  })
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(createdAt) + 1)
  await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('not live')
  expect(f.managers[0]!.attachSession).not.toHaveBeenCalled()
  expect(f.credentials.revokeForExecution).toHaveBeenCalledWith(f.context.executionId)
})

it('a concurrent startup loser does not revoke the winning startup credentials', async () => {
  const f = fixture()
  const prepared = await f.credentials.prepare()
  f.credentials.prepare.mockClear()
  let unblock!: () => void
  let announce!: () => void
  const started = new Promise<void>((resolve) => { announce = resolve })
  const gate = new Promise<void>((resolve) => { unblock = resolve })
  f.credentials.prepare.mockImplementationOnce(async () => { announce(); await gate; return prepared })
  const first = f.coordinator.attachOwnedSession(f.context, f.session)
  await started
  await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('already starting')
  expect(f.credentials.revokeForExecution).not.toHaveBeenCalled()
  unblock()
  await first
  expect(f.resolver.resolve(f.context).lifecycle).toBe('resident')
})

it('fences reuse until failed resident cleanup finishes', async () => {
  const f = fixture()
  await f.coordinator.attachOwnedSession(f.context, f.session)
  let unblock!: () => void
  let announce!: () => void
  const closing = new Promise<void>((resolve) => { announce = resolve })
  const gate = new Promise<void>((resolve) => { unblock = resolve })
  f.managers[0]!.history.mockRejectedValueOnce(new Error('attachment failed'))
  f.managers[0]!.close.mockImplementationOnce(async () => { announce(); await gate })
  const failed = expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('attachment failed')
  await closing
  await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('being released')
  expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
  unblock()
  await failed
  expect(f.resolver.resolve(f.context).lifecycle).toBe('allocated')
})

it('finalizes newly terminal work and reuses the persisted finish time before any active-time assertion', async () => {
  const f = fixture('codex', false)
  const first = await f.observe()
  expect(first.state).toBe('completed')
  const activeChecks = f.budgets.assertActive.mock.calls.length
  expect(f.budgets.finish).toHaveBeenCalledWith(f.context.executionId, first.execution.finishedAt)
  f.budgets.assertActive.mockRejectedValue(new Error('must not re-check a completed execution'))
  const replay = await f.observe()
  expect(replay).toEqual(first)
  expect(f.budgets.assertActive).toHaveBeenCalledTimes(activeChecks)
  expect(f.budgets.finish).toHaveBeenLastCalledWith(f.context.executionId, first.execution.finishedAt)
  expect(f.managers).toHaveLength(1)
  expect(f.managers[0]!.createSession).toHaveBeenCalledTimes(1)
  expect(f.managers[0]!.startTurn).toHaveBeenCalledTimes(1)
})

it('still revokes and releases terminal work when budget finalization needs retry', async () => {
  const f = fixture('codex', false)
  f.budgets.finish.mockRejectedValueOnce(new Error('accounting unavailable'))
  await expect(f.observe()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'accounting unavailable' })] })
  expect(f.credentials.revokeForExecution).toHaveBeenCalledWith(f.context.executionId)
  expect(f.managers[0]!.close).toHaveBeenCalledWith(f.session)
  const persisted = await f.runs.getExecution()
  expect(persisted.state).toBe('completed')
  await f.observe()
  expect(f.budgets.finish).toHaveBeenLastCalledWith(f.context.executionId, persisted.finishedAt)
  expect(f.managers).toHaveLength(1)
  expect(f.managers[0]!.startTurn).toHaveBeenCalledTimes(1)
  f.budgets.finish.mockRejectedValueOnce(new Error('accounting unavailable again'))
  await expect(f.observe()).rejects.toThrow('accounting unavailable again')
  expect(f.credentials.revokeForExecution).toHaveBeenCalledTimes(3)
})

it('revokes superseded credentials only after preflight and before a new process credential is issued', async () => {
  const order: string[] = []
  const detection = { preflight: async () => { order.push('preflight'); return {} } }
  const credentials = {
    revokeForExecution: async () => { order.push('revoke'); return 1 },
    issueForExecution: async () => { order.push('issue'); return {} },
  }
  const launch = new WorkerLaunchCredentialService(detection as never, credentials as never, 'runner-1')
  await launch.prepare({ executionId: 'execution-1', harness: 'codex', workingDirectory: '/project' })
  expect(order).toEqual(['preflight', 'revoke', 'issue'])
})

it('revokes a credential issued while the launch signal was being aborted', async () => {
  const controller = new AbortController()
  const credential = { principalId: 'aborted-start' }
  const credentials = {
    revokeForExecution: vi.fn(async () => 1),
    issueForExecution: vi.fn(async () => { controller.abort(); return credential }),
    revoke: vi.fn(async () => undefined),
  }
  const launch = new WorkerLaunchCredentialService({ preflight: async () => ({}) } as never, credentials as never, 'runner-1')
  await expect(launch.prepare({
    executionId: 'execution-1', harness: 'codex', workingDirectory: '/project', signal: controller.signal,
  })).rejects.toThrow()
  expect(credentials.revoke).toHaveBeenCalledWith(credential)
})
