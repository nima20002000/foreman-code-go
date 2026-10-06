import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionPreferencesSchema,
  type AgentHarness, type CompactionState, type NativeSessionReference, type SessionPreferences } from '@foreman-code/contracts'
import { WorkerConversationReceiptSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHarnessSessionManager, NativeHistory, NativeInitialTurnInput, NativeSessionStart,
  NativeTurnInput, NativeCompactInput } from '../harnesses/port.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { createRemoteExecutionHandler } from '../runs/remote/executionRouter.js'
import { WorkerConversationHost, type WorkerConversationHostPorts } from './workerHost.js'
import { pendingSessionControls } from '../harnesses/sessionControlDefaults.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { DeviceApplicationChannel, extensionDescriptors, type DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../devices/deviceWire.js'
import { negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'

/** Provider I/O fixture only; these cases do not qualify native installations. */
class ProviderFixture implements NativeHarnessSessionManager {
  creates = 0
  compactCalls = 0
  modes: Array<NativeTurnInput['sessionMode']> = []
  prompts: string[] = []
  configured: SessionPreferences | null = null
  holdCompact = false
  releaseCompact: (() => void) | undefined
  latestCompaction: CompactionState | undefined
  private readonly histories = new Map<string, NativeHistory>()
  constructor(readonly harness: AgentHarness, readonly session: NativeSessionReference) {}
  async capabilities() {
    return { provider: this.harness, providerVersion: 'provider-fixture', persistentSessions: true, reconnect: true,
      sameRequestResponses: true, cancellation: true, history: true, configurationInspection: false,
      mcpDetection: false, supportedInteractionKinds: [] }
  }
  async inspectMcp(): Promise<never> { throw new Error('MCP setup is not replaced by this fixture.') }
  async configureSessionPreferences(preferences: SessionPreferences) { this.configured = preferences }
  async applySessionPreferences(_session: NativeSessionReference, preferences: SessionPreferences) { this.configured = preferences }
  appliedSessionPreferences() { return this.configured }
  async sessionControlCapabilities() {
    return { ...pendingSessionControls({ harness: 'codex', model: 'model-fixture', reasoningEffort: 'low',
      sandbox: 'read-only', serviceTier: 'standard' }), plan: { supported: true, reason: null } }
  }
  contextSnapshot() {
    return { nativeSessionId: this.session.nativeSessionId, model: 'model-fixture', generation: 'fixture-generation',
      sequence: 1, observedAt: '2026-10-05T00:00:00.000Z', source: this.harness,
      accuracy: 'native' as const, usedTokens: 50, capacityTokens: 1000, lifetimeTokens: 350, cost: null, stale: false }
  }
  async createSession() { this.creates++; return this.session }
  async attachSession() { return this.session }
  async forkSession() { this.creates++; return this.session }
  async *startTurn(_session: NativeSessionReference, input: NativeTurnInput) {
    this.modes.push(input.sessionMode)
    this.prompts.push(input.prompt)
    const id = `fixture-turn-${this.prompts.length}`
    await input.onSubmitted?.(id)
    await input.onSettingsApplied?.()
    const result = { outcome: 'succeeded' as const, output: { text: input.prompt } }
    this.histories.set(input.clientCorrelationId, { correlationId: input.clientCorrelationId,
      nativeTurnId: id, terminalTurn: { correlationId: input.clientCorrelationId, providerId: id, result },
      events: [], pendingInteractions: [], terminalResult: result })
    yield { sequence: this.prompts.length, type: 'turn.completed', occurredAt: '2026-10-05T00:00:00.000Z', payload: {} }
  }
  async *startInitialTurn(_start: NativeSessionStart, input: NativeInitialTurnInput) {
    this.creates++
    await input.onSessionObserved(this.session)
    await input.onMessageSubmitted?.({ kind: 'message', nativeSessionId: this.session.nativeSessionId,
      nativeMessageId: 'observed-message', clientCorrelationId: input.clientCorrelationId })
    yield* this.startTurn(this.session, input)
  }
  async compactSession(_session: NativeSessionReference, input: NativeCompactInput) {
    await input.onDispatch?.()
    this.compactCalls++
    const state: CompactionState = { requestId: input.requestId, nativeSessionId: this.session.nativeSessionId,
      nativeOperationId: 'observed-boundary', status: 'running', beforeTokens: 50,
      observedAt: '2026-10-05T00:00:00.000Z', message: 'Compacting fixture context.' }
    this.latestCompaction = state
    await input.onProgress(state)
    if (this.holdCompact) await new Promise<void>(resolve => { this.releaseCompact = resolve })
    this.latestCompaction = { ...state, status: 'completed' }
    return this.latestCompaction
  }
  async reconcileCompaction(_session: NativeSessionReference, state: CompactionState) { return this.latestCompaction ?? state }
  async pending() { return undefined }
  async respond() {}
  async cancel() { return true }
  async history(): Promise<NativeHistory> { return { events: [], pendingInteractions: [] } }
  async reconcile(_session: NativeSessionReference, correlationId: string) {
    return this.histories.get(correlationId) ?? { events: [], pendingInteractions: [] }
  }
  async close() {}
}

const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })
async function setup(harness: AgentHarness = 'codex') {
  const f = workerConversationFixture('operator', harness)
  const root = await mkdtemp(join(tmpdir(), 'worker-chat-host-'))
  closing.push(() => rm(root, { recursive: true, force: true }))
  const journal = await RemoteOperationJournal.open(join(root, 'operations.json'), { initializeNewInstallation: true })
  closing.push(() => journal.close())
  const manager = new ProviderFixture(harness, f.session)
  let allowed = true
  let current = f.connection
  const observed = { sessions: [] as NativeSessionReference[], turns: [] as string[] }
  const ports: WorkerConversationHostPorts = {
    journal: journal.conversations, currentBinding: () => current,
    authorize: async () => { if (!allowed) throw new Error('Current Main authority denied the operation.') },
    allocate: async () => ({ manager,
      start: async ({ correlationId }) => {
        if (!('operatorId' in f.configuration)) throw new Error('This fixture starts only Operator native sessions.')
        return { kind: 'operator', correlationId, configuration: f.configuration, workingDirectory: f.binding.workingDirectory }
      }, nativeOwner: async () => f.nativeOwner, close: async () => {} }),
    observeSession: async (_binding, session) => {
      expect((await journal.conversations.read(f.binding))?.session).toEqual(session)
      observed.sessions.push(session)
    },
    observeSubmission: async (_binding, correlationId) => { observed.turns.push(correlationId) },
  }
  const host = new WorkerConversationHost(ports)
  closing.push(async () => { manager.releaseCompact?.(); await host.shutdown() })
  const request = (input: Record<string, unknown>) => host.handle({ ...input, binding: f.binding }, current)
  const open = { method: 'conversation.open', operationId: 'original-message', mode: 'create', configuration: f.configuration }
  return { ...f, journal, manager, ports, host, observed, request, open,
    deny: () => { allowed = false }, replaceConnection: () => { current = { ...current, connectionEpoch: randomUUID() } } }
}
function receipt(value: unknown) {
  return WorkerConversationReceiptSchema.parse((value as { receipt: unknown }).receipt)
}

it('closes only the idle old owner and attaches the same session under the requested App MCP access', async () => {
  const f = await setup()
  const allocation = await f.ports.allocate(f.binding, f.configuration, f.connection, AbortSignal.timeout(1000))
  const closeOld = vi.fn(async () => {})
  f.ports.allocate = async () => ({ ...allocation, close: closeOld })
  await f.request(f.open)
  const next = { ...f.binding, appMcpAccess: 'scoped' as const }
  const owner = { ...f.nativeOwner, processIdentityDigest: 'c'.repeat(64) }
  const recover = vi.fn(async (...args: Parameters<NonNullable<WorkerConversationHostPorts['recover']>>) => {
    const [record, configuration, connection, signal, request] = args
    expect(configuration).toEqual(f.configuration)
    expect(signal.aborted).toBe(false)
    expect(closeOld).toHaveBeenCalledOnce()
    expect(record.applicationAccessChange?.state).toBe('reserved')
    expect('applicationAccess' in request && request.applicationAccess)
      .toEqual({ kind: 'operator-chat-mcp', token: 'normally-issued-credential' })
    await f.journal.conversations.recoveredOwner(f.binding, connection, f.nativeOwner, owner, next)
    return { ...allocation, nativeOwner: async () => owner }
  }) satisfies WorkerConversationHostPorts['recover']
  f.ports.recover = recover
  const request = { method: 'conversation.open', binding: next, previousBinding: f.binding,
    mode: 'attach', source: f.session, operationId: 'access-message', configuration: f.configuration,
    applicationAccess: { kind: 'operator-chat-mcp', token: 'normally-issued-credential' } }
  const changed = receipt(await f.host.handle(request, f.connection))
  expect(changed.binding).toEqual(next)
  expect(changed.session).toEqual(f.session)
  expect(changed.nativeOwner).toEqual(owner)
  expect(f.manager.creates).toBe(1)
  expect(f.manager.prompts).toEqual([])
  expect(receipt(await f.host.handle(request, f.connection)).nativeOwner).toEqual(owner)
  expect(closeOld).toHaveBeenCalledOnce()
  expect(recover).toHaveBeenCalledOnce()
})

it('keeps the old owner alive when an access handoff addresses another native session', async () => {
  const f = await setup()
  const allocation = await f.ports.allocate(f.binding, f.configuration, f.connection, AbortSignal.timeout(1000))
  const closeOld = vi.fn(async () => {})
  f.ports.allocate = async () => ({ ...allocation, close: closeOld })
  await f.request(f.open)
  await expect(f.host.handle({ method: 'conversation.open', binding: { ...f.binding, appMcpAccess: 'scoped' },
    previousBinding: f.binding, mode: 'attach', source: { ...f.session, nativeSessionId: 'foreign-session' },
    operationId: 'foreign-access', configuration: f.configuration }, f.connection)).rejects.toThrow('settled Operator')
  expect(closeOld).not.toHaveBeenCalled()
  expect((await f.journal.conversations.read(f.binding))?.applicationAccessChange).toBeUndefined()
})

it('keeps fresh inspection separate from the first admitted Claude message owner', async () => {
  const f = await setup('claude')
  const base = await f.ports.allocate(f.binding, f.configuration, f.connection, AbortSignal.timeout(1000))
  const inspected = new ProviderFixture('claude', f.session)
  const closeInspection = vi.fn(async () => {})
  f.ports.prepare = vi.fn(async () => ({ ...base, manager: inspected, close: closeInspection }))
  const nativeStart = vi.fn(async (input: Parameters<typeof base.start>[0]) => {
    expect(closeInspection).toHaveBeenCalledOnce()
    return base.start(input)
  })
  const allocate = vi.fn(async () => ({ ...base, start: nativeStart }))
  f.ports.allocate = allocate
  await f.request({ method: 'conversation.capabilities', configuration: f.configuration })
  expect(allocate).not.toHaveBeenCalled()
  expect(f.manager.creates).toBe(0)
  const value = await f.request({ method: 'conversation.initial-turn', operationId: 'message-creation',
    correlationId: 'actual-native-message', configuration: f.configuration, prompt: 'One admitted task' })
  expect(receipt(value).creation?.operationId).toBe('message-creation')
  await vi.waitFor(() => expect(f.manager.prompts).toEqual(['One admitted task']))
  expect(nativeStart).toHaveBeenCalledWith({ correlationId: 'actual-native-message', instructionsDelivered: false })
  expect(allocate).toHaveBeenCalledOnce()
  expect(closeInspection).toHaveBeenCalledOnce()
  expect(f.manager.creates).toBe(1)
})

it('inspects a cold saved chat on a separate preparation and rechecks its scoped credential before attachment', async () => {
  const f = await setup('claude')
  f.binding.appMcpAccess = 'scoped'
  const created = receipt(await f.request(f.open))
  expect(created.session).toEqual(f.session)
  await f.host.shutdown()
  const inspectManager = new ProviderFixture('claude', f.session)
  const preparedClose = vi.fn(async () => {})
  const delivered = vi.fn(async () => {})
  const allocated = await f.ports.allocate(f.binding, f.configuration, f.connection, AbortSignal.timeout(1000))
  const prepare = vi.fn(async () => ({ ...allocated, manager: inspectManager,
    deliverClaudeCredential: delivered, close: preparedClose }))
  const recover = vi.fn(async () => allocated)
  const restored = new WorkerConversationHost({ ...f.ports, prepare, recover })
  const request = (input: Record<string, unknown>) => restored.handle({ ...input, binding: f.binding }, f.connection)
  try {
    await Promise.all([request({ method: 'conversation.capabilities', configuration: f.configuration }),
      request({ method: 'conversation.capabilities', configuration: f.configuration })])
    expect(prepare).toHaveBeenCalledOnce()
    expect(recover).not.toHaveBeenCalled()
    await request({ method: 'conversation.refresh-mcp', configuration: f.configuration,
      applicationAccess: { kind: 'operator-chat-mcp', token: 'recorded-scoped-credential' } })
    expect(delivered).toHaveBeenCalledWith('recorded-scoped-credential', expect.any(AbortSignal))
    await request({ ...f.open, mode: 'attach', source: f.session,
      applicationAccess: { kind: 'operator-chat-mcp', token: 'recorded-scoped-credential' } })
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ session: f.session }), f.configuration,
      f.connection, expect.any(AbortSignal), expect.objectContaining({ applicationAccess: {
        kind: 'operator-chat-mcp', token: 'recorded-scoped-credential' } }))
    expect(preparedClose).toHaveBeenCalledOnce()
    expect((await f.journal.conversations.read(f.binding))?.session).toEqual(f.session)
  } finally { await restored.shutdown() }
})

it('closes an unused prepared owner without closing a conversation that has admitted native input', async () => {
  const f = await setup('claude')
  const allocate = f.ports.allocate
  const close = vi.fn(async () => {})
  f.ports.allocate = async (...args) => ({ ...await allocate(...args), close })
  await f.request({ method: 'conversation.capabilities', configuration: f.configuration })
  expect(await f.request({ method: 'conversation.release-preparation' })).toEqual({ acknowledged: true })
  expect(close).toHaveBeenCalledTimes(1)
  expect(f.manager.creates).toBe(0)
  await f.request(f.open)
  await expect(f.request({ method: 'conversation.release-preparation' })).rejects.toThrow('cannot close an admitted model message')
  expect(close).toHaveBeenCalledTimes(1)
  expect((await f.journal.conversations.read(f.binding))?.closed).toBe(false)
})

for (const harness of ['codex', 'claude', 'opencode'] as const) {
  it(`forwards native Plan, preferences and separate usage through the ${harness} adapter port`, async () => {
    const f = await setup(harness)
    const preferences = SessionPreferencesSchema.parse(harness === 'claude' ? { autoCompact: 'off' } : {})
    expect(receipt(await f.request({ ...f.open, preferences })).session).toEqual(f.session)
    await f.request({ method: 'conversation.start-turn', session: f.session, prompt: 'One planned task',
      correlationId: 'planned-message', sessionMode: 'plan', preferences })
    await vi.waitFor(async () => expect((await f.journal.conversations.read(f.binding))?.turns[0]?.status).toBe('completed'))
    expect(f.manager.prompts).toEqual(['One planned task'])
    expect(f.manager.modes).toEqual(['plan'])
    expect((await f.journal.conversations.read(f.binding))?.turns[0]?.sessionMode).toBe('plan')
    const controls = await f.request({ method: 'conversation.controls-read', session: f.session })
    expect(controls).toMatchObject({ context: { usedTokens: 50, capacityTokens: 1000, lifetimeTokens: 350 }, preferences })
    expect(receipt(controls).closed).toBe(false)
    await f.request({ method: 'conversation.start-turn', session: f.session, prompt: 'Regular follow-up',
      correlationId: 'regular-message', sessionMode: 'regular' })
    await vi.waitFor(() => expect(f.manager.modes).toEqual(['plan', 'regular']))
    expect(f.manager.creates).toBe(1)
  })
}

it('deduplicates concurrent native session creation and refuses mismatched configuration before allocation', async () => {
  const f = await setup()
  const results = await Promise.all([f.request(f.open), f.request(f.open)])
  await vi.waitFor(() => expect(f.observed.sessions).toHaveLength(1))
  expect(results.map(value => receipt(value).binding)).toEqual([f.binding, f.binding])
  expect(f.manager.creates).toBe(1)
  await expect(f.request({ ...f.open, configuration: { ...f.configuration, version: 2 } })).rejects.toThrow('configuration differs')
  expect(f.manager.creates).toBe(1)
})

it('rejects a changed configuration before persisting a new conversation owner', async () => {
  const f = await setup('opencode')
  const allocate = vi.spyOn(f.ports, 'allocate')
  await expect(f.request({ ...f.open, configuration: { ...f.configuration, version: 2 } }))
    .rejects.toThrow('configuration differs')
  expect(allocate).not.toHaveBeenCalled()
  expect(await f.journal.conversations.read(f.binding)).toBeUndefined()
})

it('reauthorizes controls and rejects a foreign native session or replaced channel', async () => {
  const f = await setup()
  await f.request(f.open)
  await expect(f.request({ method: 'conversation.cancel', session: { ...f.session, nativeSessionId: 'foreign' } }))
    .rejects.toThrow('not resident')
  f.deny()
  await expect(f.request({ method: 'conversation.controls-read', session: f.session })).rejects.toThrow('authority denied')
  const other = await setup()
  other.replaceConnection()
  await expect(other.host.handle({ ...other.open, binding: other.binding }, other.connection)).rejects.toThrow('connection changed')
  expect(other.manager.creates).toBe(0)
})

it('retains compaction across a lost response without blocking reads or dispatching twice', async () => {
  const f = await setup()
  await f.request(f.open)
  f.manager.holdCompact = true
  const compact = { method: 'conversation.compact', session: f.session,
    requestId: 'original-compact', correlationId: 'original-compact-correlation' }
  await f.request(compact)
  await vi.waitFor(() => expect(f.manager.compactCalls).toBe(1))
  const replay = await f.request(compact)
  expect(replay).toMatchObject({ compaction: { status: 'running', nativeOperationId: 'observed-boundary' } })
  expect(await f.request({ method: 'conversation.controls-read', session: f.session })).toMatchObject({ context: { usedTokens: 50 } })
  await expect(f.request({ method: 'conversation.start-turn', session: f.session, prompt: 'too early', correlationId: 'early' }))
    .rejects.toThrow('pending')
  f.manager.releaseCompact!()
  await vi.waitFor(async () => expect((await f.journal.conversations.read(f.binding))?.compactions[0]?.state.status).toBe('completed'))
  expect(await f.request(compact)).toMatchObject({ compaction: { status: 'completed' } })
  expect(f.manager.compactCalls).toBe(1)
  expect((await f.journal.conversations.read(f.binding))?.closed).toBe(false)
})

it('forks independently, keeps its source untouched and carries real initial-message observations', async () => {
  const f = await setup()
  const source = { ...f.session, nativeSessionId: 'observed-source-session' }
  const before = structuredClone(source)
  expect(receipt(await f.request({ ...f.open, mode: 'fork', source })).session).toEqual(f.session)
  expect(source).toEqual(before)
  expect(f.session.nativeSessionId).not.toBe(source.nativeSessionId)
  const initial = await setup('claude')
  await initial.request({ method: 'conversation.initial-turn', operationId: 'initial-request', configuration: initial.configuration,
    prompt: 'Initial task', correlationId: 'initial-correlation', sessionMode: 'plan' })
  await vi.waitFor(async () => expect((await initial.journal.conversations.read(initial.binding))?.turns[0]?.status).toBe('completed'))
  expect(initial.observed.sessions).toEqual([initial.session])
  expect((await initial.journal.conversations.read(initial.binding))?.turns[0]?.nativeSubmission).toMatchObject({
    nativeSessionId: initial.session.nativeSessionId, nativeMessageId: 'observed-message' })
})

it('routes chats on execution-v1 without entering the workflow handler', async () => {
  const f = await setup()
  const workflow = vi.fn(async () => { throw new Error('A chat must not enter workflow dispatch.') })
  const route = createRemoteExecutionHandler({ handle: workflow }, undefined, {
    handle: raw => f.host.handle(raw, f.connection),
  })
  expect(receipt(await route({ ...f.open, binding: f.binding })).session).toEqual(f.session)
  expect(workflow).not.toHaveBeenCalled()
  expect(() => route({ method: 'conversation.cancel', binding: f.binding })).toThrow()
  expect(workflow).not.toHaveBeenCalled()
  const unsupported = createRemoteExecutionHandler({ handle: workflow })
  expect(() => unsupported({ ...f.open, binding: f.binding })).toThrow('chat runtime is unavailable')
})

it('reads persisted ownership without allocating another native process', async () => {
  const f = await setup()
  const allocate = vi.spyOn(f.ports, 'allocate')
  expect(await f.request({ method: 'conversation.status' })).toEqual({ receipt: undefined })
  expect(allocate).not.toHaveBeenCalled()
  await f.request(f.open)
  const cold = new WorkerConversationHost(f.ports)
  try {
    expect(receipt(await cold.handle({ method: 'conversation.status', binding: f.binding }, f.connection)).session)
      .toEqual(f.session)
    expect(allocate).toHaveBeenCalledOnce()
    expect(f.manager.creates).toBe(1)
  } finally { await cold.shutdown() }
})

class MemorySocket extends EventEmitter {
  bufferedAmount = 0
  peer: MemorySocket | undefined
  closed = false
  send(text: string) {
    queueMicrotask(() => { if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false) })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

it('carries conversation operations on the paired channel and applies Main denial before effects', async () => {
  const f = await setup()
  const left = new MemorySocket()
  const right = new MemorySocket()
  left.peer = right
  right.peer = left
  const mainSocket = adaptDeviceSocket(left)
  const workerSocket = adaptDeviceSocket(right)
  const mainRegistration: DeviceExtensionRegistration = { namespace: 'execution-v1', version: 1,
    role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }
  const workerRegistration: DeviceExtensionRegistration = { ...mainRegistration, role: 'server',
    handle: async (raw, context) => ({ payload: await f.host.handle(raw, context.binding, context.signal) }) }
  const extensions = negotiateDeviceExtensions(extensionDescriptors([mainRegistration]), extensionDescriptors([workerRegistration]))
  const lifetime = new AbortController()
  const revalidate = vi.fn(async () => {})
  const main = new DeviceApplicationChannel({ side: 'main', binding: f.connection, socket: mainSocket,
    signal: lifetime.signal, extensions, registrations: [mainRegistration], revalidate })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding: f.connection, socket: workerSocket,
    signal: lifetime.signal, extensions, registrations: [workerRegistration] })
  const readers = [main.run(mainSocket.messages[Symbol.asyncIterator](), 10_000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 10_000)]
  for (const task of readers) void task.catch(() => {})
  try {
    const result = await main.request('execution-v1', { ...f.open, binding: f.binding })
    expect(receipt(result.payload).session).toEqual(f.session)
    expect(revalidate).toHaveBeenCalled()
    f.deny()
    await expect(main.request('execution-v1', { method: 'conversation.start-turn', binding: f.binding,
      session: f.session, prompt: 'Denied message', correlationId: 'denied-message' })).rejects.toThrow()
    expect(f.manager.prompts).toEqual([])
    expect((await f.journal.conversations.read(f.binding))?.turns).toEqual([])
  } finally {
    lifetime.abort()
    main.close()
    worker.close()
    await Promise.allSettled(readers)
    await Promise.all([main.join(), worker.join()])
  }
})
