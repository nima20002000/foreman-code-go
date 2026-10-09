import { SessionPreferencesSchema, type CompactionState } from '@foreman-code/contracts'
import { appLauncherConnection } from '../src/modules/harnesses/appMcpLauncher.js'
import { nativeConnection } from '../src/modules/harnesses/nativeMcpCommon.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { CODEX_INTERACTION_SUPPORT,
  type CodexHarnessConfiguration, type NativeSessionReference, type PendingNativeInteraction,
  type InteractionResponseValue } from '@foreman-code/contracts'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { afterEach, beforeEach, describe, it, onTestFailed, vi } from 'vitest'

import type { NativeResponseAvailabilityQuery } from '../src/modules/harnesses/responseAvailability.js'
import { DomainError } from '../src/modules/errors.js'
import { NativeDeliveryError } from '../src/modules/harnesses/errors.js'
import { assertOriginalWorkflowTerminal } from '../src/modules/interactions/workflowTerminalSource.js'
import type { WorkflowNativeSessionStart, AgentChatNativeSessionStart } from '../src/modules/harnesses/port.js'
import type { ThreadItem, Turn } from '../src/modules/harnesses/codexMethodTypes.js'
import type { JsonObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { isObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { codexResponseSurfaceFixtures } from './fixtures/codex-response-surfaces.js'
import {
  calls, collect, emit, errorCode, finish, fixture, fixtureProtocol, fixtureQualification,
  input, nativeThread, processesForRequests, state, until, type Fixture,
} from './fixtures/codex-test-helpers.js'
import { writeNativeAcceptanceEvidence } from './helpers/nativeAcceptanceEvidence.js'
import { completeTestResourceCleanup, createTestRoot, registerTestResourceCleanup, removeTestRoot,
  type TestRoot } from '../../../scripts/test-resources.mjs'

// Only qualification is replaced here. Every lifecycle/translation/transport path
// below runs the repository implementation, including the pinned native schema gate.
vi.doMock('../src/modules/harnesses/codexProtocol.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/codexProtocol.js')>('../src/modules/harnesses/codexProtocol.js')
  return { ...actual, qualifyCodex: fixtureQualification, assertCodexUnchanged: async () => undefined }
})
vi.doMock('../src/modules/harnesses/codexStdioTransport.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/codexStdioTransport.js')>('../src/modules/harnesses/codexStdioTransport.js')
  class TestTransport extends actual.CodexStdioTransport {
    constructor(...args: ConstructorParameters<typeof actual.CodexStdioTransport>) { args[7] = 500; super(...args) }
  }
  return { ...actual, CodexStdioTransport: TestTransport }
})
const { CodexAppServerSessionManager } = await import('../src/modules/harnesses/codexAppServer.js')
type Manager = InstanceType<typeof CodexAppServerSessionManager>
const managers: Manager[] = []
let f: Fixture
let manager: Manager
let source: WorkflowNativeSessionStart
let scratch: TestRoot
let scratchCleanupId: string
const invocation = { directory: process.env.FOREMAN_CODE_TEST_ROOT!, token: process.env.FOREMAN_CODE_TEST_OWNER! }
function makeManager(): Manager { const value = new CodexAppServerSessionManager(f.binary); managers.push(value); return value }
function codex(value = source): CodexHarnessConfiguration {
  const harness = value.request.configuration.harness
  assert.equal(harness.harness, 'codex')
  return harness as CodexHarnessConfiguration
}
async function flag(name: string): Promise<void> { await writeFile(join(f.directory, name), '') }
async function unflag(name: string): Promise<void> { await rm(join(f.directory, name), { force: true }) }
async function json(name: string, value: unknown): Promise<void> { await writeFile(join(f.directory, name), JSON.stringify(value)) }
async function wire(method?: string): Promise<JsonObject[]> {
  return (await calls(f.directory)).flatMap((entry) => isObject(entry.wire) && (!method || entry.wire.method === method) ? [entry.wire] : [])
}
async function start(session: NativeSessionReference, prompt = 'wait', correlation = 'turn-correlation') {
  const result = collect(manager.startTurn(session, { prompt, clientCorrelationId: correlation }))
  await until(async () => (await manager.history(session)).events.some((event) => event.type === 'turn.started' && event.payload.clientCorrelationId === correlation))
  return { result }
}
async function pending(session: NativeSessionReference): Promise<PendingNativeInteraction> {
  return until(() => manager.pending(session))
}
async function inject(session: NativeSessionReference, method: string, extra: JsonObject = {}, id = 4000): Promise<void> {
  const current = await state(f.directory, session.nativeSessionId)
  await emit(f.directory, { id, method, params: {
    threadId: session.nativeSessionId, turnId: current.turns.at(-1)!.id, startedAtMs: 1, ...extra,
  } })
}
function responseQuery(value: PendingNativeInteraction): NativeResponseAvailabilityQuery {
  const { nativeRequestId, nativeTurnId } = value.turn
  assert(nativeRequestId && nativeTurnId)
  return { nativeRequestId, nativeRequestType: value.nativeRequestType, expectedNativeTurnId: nativeTurnId }
}
async function respond(session: NativeSessionReference, value: PendingNativeInteraction, semantic = 'approve_once') {
  const option = value.responseOptions.find((entry) => entry.semantic === semantic)
  assert(option, `missing ${semantic}`)
  await manager.respond(session, value.turn.nativeRequestId!, option)
}
async function assertCode(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => errorCode(error) === code, code)
}
async function assertDead(pid: number): Promise<void> {
  await until(async () => { try { process.kill(pid, 0); return false } catch { return true } })
}
async function assertSpawnedEnvironment(expected: Record<string, string | null>, launches: number): Promise<void> {
  const processes = await processesForRequests(f.directory, 'thread/start', 'thread/resume', 'thread/fork')
  assert.equal(processes.length, launches)
  assert.equal(new Set(processes.map((entry) => entry.pid)).size, launches)
  assert.deepEqual(processes.at(-1)!.environmentMatches,
    Object.fromEntries(Object.keys(expected).map((key) => [key, true])))
  for (const entry of await calls(f.directory)) {
    if (typeof entry.pid !== 'number') continue
    assert(isObject(entry.environmentMatches))
    for (const [key, value] of Object.entries(expected)) {
      if (value === null) assert.equal(entry.environmentMatches[key], true, key)
    }
  }
  await assertMetadataProcessesClosed()
}
async function assertMetadataProcessesClosed(): Promise<void> {
  for (const entry of await processesForRequests(f.directory, 'model/list')) {
    assert(typeof entry.pid === 'number')
    await assertDead(entry.pid)
  }
}

describe('Codex fixture user-message contract', () => {
  const userMessage = {
    type: 'userMessage', id: 'native-item-123', clientId: 'application-request-456',
    content: [{ type: 'text', text: 'hello', text_elements: [] }],
  } satisfies ThreadItem
  const turn = {
    id: 'native-turn-1', items: [userMessage], itemsView: 'full', status: 'inProgress',
    error: null, startedAt: 1, completedAt: null, durationMs: null,
  } satisfies Turn
  const surfaces: Array<{ name: string; validate(item: JsonObject): void }> = [
    { name: 'turn/start response', validate: (item) => fixtureProtocol.response('turn/start', {
      turn: { ...turn, items: [item] },
    }) },
    { name: 'thread/read response', validate: (item) => fixtureProtocol.response('thread/read', {
      thread: nativeThread({ turns: [{ ...turn, items: [item as ThreadItem] }] }),
    }) },
    { name: 'thread/turns/list response', validate: (item) => fixtureProtocol.response('thread/turns/list', {
      data: [{ ...turn, items: [item] }], nextCursor: null, prevCursor: null,
    }) },
    ...['turn/started', 'turn/completed'].map((method) => ({
      name: `${method} notification`, validate: (item: JsonObject) => fixtureProtocol.notification({
        method, params: { threadId: 'native-thread-1', turn: { ...turn, items: [item] } },
      }),
    })),
    ...['item/started', 'item/completed'].map((method) => ({
      name: `${method} notification`, validate: (item: JsonObject) => fixtureProtocol.notification({
        method, params: { threadId: 'native-thread-1', turnId: turn.id, item, startedAtMs: 1, completedAtMs: 2 },
      }),
    })),
  ]

  for (const surface of surfaces) {
    it(`validates separate native/app identities and nullable clientId on ${surface.name}`, () => {
      assert.doesNotThrow(() => surface.validate(userMessage))
      const uncorrelated = { ...userMessage, clientId: null } satisfies ThreadItem
      assert.doesNotThrow(() => surface.validate(uncorrelated))
      const noClientId: JsonObject = { ...userMessage }
      delete noClientId.clientId
      assert.doesNotThrow(() => surface.validate(noClientId))
      assert.doesNotThrow(() => surface.validate({ ...userMessage, id: userMessage.clientId }))
    })

    it(`rejects malformed user-message identities and content on ${surface.name}`, () => {
      const missingId: JsonObject = { ...userMessage }
      delete missingId.id
      for (const item of [
        missingId,
        { ...userMessage, id: 123 },
        { ...userMessage, clientId: 456 },
        { ...userMessage, content: {} },
        { ...userMessage, content: [{ type: 'text', text: 123 }] },
        { ...userMessage, content: [{ type: 'localImage', path: 123 }] },
        { ...userMessage, content: [{ type: 'text', text: 'hello', text_elements: [
          { byteRange: { start: 'bad', end: 1 } },
        ] }] },
      ]) assert.throws(() => surface.validate(item))
    })

    it(`validates other thread item variants on ${surface.name}`, () => {
      const agentMessage = { type: 'agentMessage', id: 'assistant-item', text: 'hello', phase: 'commentary' }
      const command = { type: 'commandExecution', id: 'command-item', command: 'printf hello',
        commandActions: [], cwd: process.cwd(), status: 'completed' }
      assert.doesNotThrow(() => surface.validate(agentMessage))
      assert.doesNotThrow(() => surface.validate(command))
      assert.throws(() => surface.validate({ ...agentMessage, text: 123 }))
      assert.throws(() => surface.validate({ ...agentMessage, memoryCitation: { entries: [{}], threadIds: [] } }))
      assert.throws(() => surface.validate({ ...command, commandActions: [{}] }))
      assert.throws(() => surface.validate({ type: 'inventedItem', id: 'unknown-item' }))
    })
  }

  it('validates the native turn identity in steer acknowledgements', () => {
    assert.doesNotThrow(() => fixtureProtocol.response('turn/steer', { turnId: turn.id }))
    assert.throws(() => fixtureProtocol.response('turn/steer', {}))
    assert.throws(() => fixtureProtocol.response('turn/steer', { turnId: 123 }))
  })
})

// Executable fixtures use a POSIX shebang. Pure protocol tests cover portable shapes.
describe.skipIf(process.platform === 'win32')('Codex app-server regressions against the real manager', () => {
  beforeEach(async () => {
    // This file exercises a 500 ms wire deadline; fixture persistence uses owned temporary storage.
    scratch = createTestRoot(tmpdir(), 'foreman-code-codex-wire-')
    scratchCleanupId = registerTestResourceCleanup(invocation, {
      kind: 'codex-wire-fixture', directory: scratch.directory, owner: scratch.token,
    })
    f = await fixture({ root: scratch })
    await flag('record-wire-timing')
    manager = makeManager()
    source = input(f.directory)
  })
  afterEach(async context => {
    const results = await Promise.allSettled(managers.splice(0).map((value) => value.shutdown()))
    if (context.task.result?.state === 'fail' || results.some(value => value.status === 'rejected')) {
      let timing = ''
      try { timing = await readFile(join(f.directory, 'wire-timing.jsonl'), 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await writeNativeAcceptanceEvidence(`codex-fixture-${randomUUID()}.json`, {
        test: context.task.name, calls: await calls(f.directory),
        wireTiming: timing.split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown),
      })
    }
    const failure = results.find((value) => value.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    removeTestRoot(scratch)
    completeTestResourceCleanup(invocation, scratchCleanupId)
  })

  it('lets an unattended workflow Agent call only its App MCP tools without native prompts', async () => {
    await manager.createSession(source)
    const chats = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'none')
    managers.push(chats)
    await chats.createSession({ kind: 'agent-chat', conversationId: 'attended-chat', workflowId: 'saved-workflow',
      workflowNodeId: 'chat-node', correlationId: 'chat-request', configuration: source.request.configuration,
      workingDirectory: f.directory })
    const [workflow, chat] = (await wire('thread/start')).map(frame => (frame.params as JsonObject).config as JsonObject)
    assert.equal(workflow!['mcp_servers.graphql.default_tools_approval_mode'], 'approve')
    assert.deepEqual(Object.keys(workflow!).filter(key => key.endsWith('.default_tools_approval_mode')),
      ['mcp_servers.graphql.default_tools_approval_mode'])
    assert.equal(chat!['mcp_servers.graphql.default_tools_approval_mode'], undefined)
  })

  it('owns two node chats independently with one Agent configuration and no workflow execution descriptor', async () => {
    const chats = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'none')
    managers.push(chats)
    const first: AgentChatNativeSessionStart = { kind: 'agent-chat', conversationId: 'node-chat-one',
      workflowId: 'saved-workflow', workflowNodeId: 'first-node', correlationId: 'same-request',
      configuration: source.request.configuration, workingDirectory: f.directory }
    const second = { ...first, conversationId: 'node-chat-two', workflowNodeId: 'second-node' }
    const one = await chats.createSession(first)
    const two = await chats.createSession(second)
    assert.notEqual(one.nativeSessionId, two.nativeSessionId)
    assert.deepEqual(await chats.createSession(first), one)
    await assert.rejects(chats.attachSession(one, second), errorCode('CODEX_SESSION_OWNER_MISMATCH'))
    const starts = await wire('thread/start')
    assert.equal(starts.length, 2)
    for (const frame of starts) {
      assert.equal((frame.params as JsonObject).sandbox, codex().sandbox)
      assert.equal((frame.params as JsonObject).cwd, f.directory)
    }
  })

  it('releases the native fence when dispatch metadata cannot be saved before sending', async () => {
    const session = await manager.createSession(source)
    await assert.rejects(manager.compactSession(session, { requestId: 'compact-request', clientCorrelationId: 'control-request',
      onProgress: async () => {}, onDispatch: async () => { throw new Error('Dispatch storage failed') } }), /Dispatch storage failed/)
    assert.equal((await wire('thread/compact/start')).length, 0)
    const task = await start(session, 'follow-up', 'after-preflight')
    await finish(f.directory, session.nativeSessionId)
    await task.result
  })

  it('recovers a resident compaction from native history when completion notifications are lost', async () => {
    const session = await manager.createSession(source)
    await flag('drop-compact-events')
    const abort = new AbortController()
    let control: CompactionState | undefined
    const operation = manager.compactSession(session, { requestId: 'compact-request', clientCorrelationId: 'control-request',
      onProgress: async value => { control = value } }, abort.signal)
    await until(async () => (await wire('thread/compact/start')).length === 1)
    abort.abort(new Error('Completion notification lost'))
    await assert.rejects(operation)
    const recovered = await manager.reconcileCompaction(session, { ...control!, status: 'uncertain' })
    assert.equal(recovered.status, 'completed')
    assert.equal((await wire('thread/compact/start')).length, 1)
    const turn = await start(session, 'follow-up', 'after-compaction')
    await finish(f.directory, session.nativeSessionId)
    await turn.result
  })

  it('preserves definite compaction rejection and permits another command and follow-up turn', async () => {
    const session = await manager.createSession(source)
    await flag('reject-compact')
    let control: CompactionState | undefined
    await assert.rejects(manager.compactSession(session, { requestId: 'rejected-control', clientCorrelationId: 'rejected-control',
      onProgress: async value => { control = value } }), error => {
      assert.equal((error as { uncertain: boolean }).uncertain, false)
      return true
    })
    assert.equal((await manager.reconcileCompaction(session, { ...control!, status: 'uncertain' })).status, 'failed')
    await unflag('reject-compact')
    const completed = await manager.compactSession(session, { requestId: 'next-control', clientCorrelationId: 'next-control',
      onProgress: async () => {} })
    assert.equal(completed.status, 'completed')
    const followup = await start(session, 'next task', 'after-rejection')
    await finish(f.directory, session.nativeSessionId)
    await followup.result
  })

  it.each(['timeout', 'disconnect'] as const)(
    'recovers a cold compaction after %s through thread read without another dispatch', async outcome => {
    const session = await manager.createSession(source)
    await flag('drop-compact-events')
    if (outcome === 'disconnect') await flag('disconnect-compact')
    const abort = new AbortController()
    let control: CompactionState | undefined
    const operation = manager.compactSession(session, { requestId: 'cold-compact-request', clientCorrelationId: 'cold-control',
      onProgress: async value => { control = value } }, abort.signal)
    const rejected = assert.rejects(operation)
    await until(async () => (await wire('thread/compact/start')).length === 1)
    if (outcome === 'timeout') abort.abort(new DOMException('Native response timed out', 'TimeoutError'))
    await rejected
    await manager.shutdown()
    const before = (await wire()).length
    const cold = makeManager()
    const recovered = await cold.readCompaction(session, source, { ...control!, status: 'uncertain' })
    assert.equal(recovered.status, 'completed')
    const reads = (await wire()).slice(before).map(entry => entry.method)
    assert(reads.includes('thread/read'))
    assert(!reads.includes('thread/resume'))
    assert(!reads.includes('turn/start'))
    assert.equal((await wire('thread/compact/start')).length, 1)
  })

  it('offers budgets from native default usage and retains the capacity while an override is applied', async () => {
    const session = await manager.createSession(source)
    assert.deepEqual((await manager.sessionControlCapabilities(session)).contextBudgets, [])
    await assertCode(manager.applySessionPreferences(session,
      SessionPreferencesSchema.parse({ contextBudget: 100000 })), 'CODEX_CONTEXT_BUDGET_INVALID')
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'default-window' }))
    const turnId = (await state(f.directory, session.nativeSessionId)).turns.at(-1)!.id
    const usage = { inputTokens: 900, cachedInputTokens: 0, outputTokens: 100,
      reasoningOutputTokens: 0, totalTokens: 1000 }
    await emit(f.directory, { method: 'thread/tokenUsage/updated', params: {
      threadId: session.nativeSessionId, turnId,
      tokenUsage: { last: usage, total: usage, modelContextWindow: 200000 },
    } })
    await until(async () => manager.contextSnapshot(session)?.capacityTokens === 200000)
    assert.deepEqual((await manager.sessionControlCapabilities(session)).contextBudgets, [100000, 200000])
    await manager.applySessionPreferences(session, SessionPreferencesSchema.parse({ contextBudget: 100000 }))
    assert.equal(manager.appliedSessionPreferences(session)?.contextBudget, 100000)
    await emit(f.directory, { method: 'thread/tokenUsage/updated', params: {
      threadId: session.nativeSessionId, turnId,
      tokenUsage: { last: usage, total: usage, modelContextWindow: 100000 },
    } })
    await until(async () => manager.contextSnapshot(session)?.capacityTokens === 100000)
    const capabilities = await manager.sessionControlCapabilities(session)
    assert.equal(capabilities.modelCapacity, 200000)
    assert.deepEqual(capabilities.contextBudgets, [100000, 200000])
    const last = (await wire('thread/resume')).at(-1)!
    assert.equal((last.params as { config: Record<string, unknown> }).config.model_context_window, 100000)
  })

  it('preserves a saved budget on creation and cold resume without inventing model capacity', async () => {
    source = { ...source, sessionPreferences: SessionPreferencesSchema.parse({ contextBudget: 100000 }) }
    const session = await manager.createSession(source)
    const capabilities = await manager.sessionControlCapabilities(session)
    assert.deepEqual(capabilities.contextBudgets, [])
    assert.equal(capabilities.modelCapacity, null)
    assert(capabilities.contextBudgetReason)
    assert.equal(manager.appliedSessionPreferences(session)?.contextBudget, 100000)
    const creation = (await wire('thread/start')).at(-1)!
    assert.equal((creation.params as { config: Record<string, unknown> }).config.model_context_window, 100000)
    await manager.closeForRestart(session)
    const resumed = makeManager()
    assert.deepEqual(await resumed.attachSession(session, source), session)
    assert.equal(resumed.appliedSessionPreferences(session)?.contextBudget, 100000)
    assert.deepEqual((await resumed.sessionControlCapabilities(session)).contextBudgets, [])
    const resumes = (await wire('thread/resume')).length
    await assertCode(resumed.applySessionPreferences(session,
      SessionPreferencesSchema.parse({ contextBudget: 200000 })), 'CODEX_CONTEXT_BUDGET_INVALID')
    assert.equal((await wire('thread/resume')).length, resumes)
    await resumed.applySessionPreferences(session, SessionPreferencesSchema.parse({}))
    assert.equal(resumed.appliedSessionPreferences(session)?.contextBudget, null)
    const last = (await wire('thread/resume')).at(-1)!
    assert.equal((last.params as { config: Record<string, unknown> }).config.model_context_window, undefined)
  })

  it('reattaches an original resident without launching, resuming, replaying or reading turn history', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const waiting = await pending(session)
    const lifetime = manager.originalSessionLifetime(session, source)!
    assert(lifetime.residency.nativeTurnId)
    lifetime.assertCurrent()
    const launches = (await calls(f.directory)).filter((entry) => typeof entry.pid === 'number').length
    assert.deepEqual(await manager.reattachOriginalSession(session, source, lifetime.residency), session)
    assert.equal((await wire('thread/resume')).length, 0)
    assert.equal((await wire('turn/start')).length, 1)
    assert.equal((await wire('thread/turns/list')).length, 0)
    assert.equal((await calls(f.directory)).filter((entry) => typeof entry.pid === 'number').length, launches)
    const read = (await wire('thread/read')).at(-1)!.params as JsonObject
    assert.equal(read.includeTurns, false)
    await manager.respondOriginal(session, source, lifetime.residency, waiting.turn.nativeRequestId!, waiting.responseOptions[0]!)
    await result
  })

  it('refuses cold original recovery before launching and never labels a resumed saved thread original', async () => {
    const session = await manager.createSession(source)
    const pin = manager.originalSessionLifetime(session, source)!.residency
    await manager.closeForRestart(session)
    const replacement = makeManager()
    const before = await calls(f.directory)
    assert.equal(replacement.originalSessionLifetime(session, source), undefined)
    await assertCode(replacement.reattachOriginalSession(session, source, pin), 'CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE')
    assert.deepEqual(await calls(f.directory), before)
    await replacement.attachSession(session, source)
    assert.equal(replacement.originalSessionLifetime(session, source), undefined)
    await assertCode(replacement.reattachOriginalSession(session, source, pin), 'CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE')
  })

  it('never restores original residency after a disconnected manager resumes in a new generation', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const lifetime = manager.originalSessionLifetime(session, source)!
    const launched = (await processesForRequests(f.directory, 'thread/start'))[0]
    assert(launched && typeof launched.pid === 'number')
    process.kill(launched.pid, 'SIGTERM')
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'transport.disconnected'))
    await result
    assert.equal(manager.originalSessionLifetime(session, source), undefined)
    await manager.reconcile(session, 'turn-correlation')
    assert.equal(manager.originalSessionLifetime(session, source), undefined)
    assert.throws(lifetime.assertCurrent)
    const before = await wire()
    await assertCode(manager.cancelOriginalTurn(session, source, lifetime.residency), 'CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE')
    assert.deepEqual(await wire(), before)
  })

  it('fences original controls by owner, accepted configuration, environment, connection and exact turn', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const lifetime = manager.originalSessionLifetime(session, source)!
    const pin = lifetime.residency
    const before = await wire()
    await assertCode(manager.cancelOriginalTurn(session, input(f.directory, 'other-agent'), pin), 'CODEX_SESSION_OWNER_MISMATCH')
    const changed = structuredClone(source); codex(changed).sandbox = 'danger-full-access'
    await assertCode(manager.cancelOriginalTurn(session, changed, pin), 'CODEX_SESSION_CONFIGURATION_MISMATCH')
    const changedEnvironment = structuredClone(source)
    changedEnvironment.environment = { agentId: changedEnvironment.environment!.agentId,
      variables: { ...changedEnvironment.environment!.variables, GRAPHQL_MCP_TOKEN: 'different-token' } }
    await assertCode(manager.cancelOriginalTurn(session, changedEnvironment, pin), 'CODEX_SESSION_ENVIRONMENT_REFRESH_REQUIRED')
    for (const changedPin of [{ ...pin, connectionId: 'other' }, { ...pin, runtimeGeneration: 1 },
      { ...pin, nativeTurnId: 'other-turn' }, { ...pin, session: { ...session, nativeSessionId: 'other-session' } }]) {
      await assertCode(manager.cancelOriginalTurn(session, source, changedPin), 'CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE')
    }
    await assertCode(manager.cancelOriginalTurn(session, { ...source, nativeTurnId: 'other-turn' }, pin), 'CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE')
    assert.deepEqual(await wire(), before)
    assert.equal(await manager.cancelOriginalTurn(session, source, pin), true)
    await result
  })

  it('does not expose original turn control before durable ACK admission completes', async () => {
    const session = await manager.createSession(source)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered = false
    const events = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'blocked-admission',
      onSubmitted: async () => { entered = true; await gate } }))
    await until(async () => entered)
    assert.equal(manager.originalSessionLifetime(session, source), undefined)
    release()
    await until(async () => manager.originalSessionLifetime(session, source))
    const pin = manager.originalSessionLifetime(session, source)!.residency
    assert.equal(await manager.cancelOriginalTurn(session, source, pin), true)
    await events
  })

  it('captured original lifetime cannot be retargeted by mutable readbacks or a later turn', async () => {
    const session = await manager.createSession(source)
    const lifetime = manager.originalSessionLifetime(session, source)!
    lifetime.residency.session.nativeSessionId = 'caller-mutation'
    lifetime.assertCurrent()
    const { result } = await start(session)
    assert.throws(lifetime.assertCurrent, (error: unknown) => errorCode(error) === 'CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE')
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('rejects late original reattachment after its live channel disconnects', async () => {
    const session = await manager.createSession(source)
    const lifetime = manager.originalSessionLifetime(session, source)!
    await flag('read-delay')
    const read = manager.reattachOriginalSession(session, source, lifetime.residency)
    void read.catch(() => undefined)
    await until(async () => (await wire('thread/read')).length > 0)
    const launched = (await processesForRequests(f.directory, 'thread/start'))[0]
    assert(launched && typeof launched.pid === 'number')
    process.kill(launched.pid, 'SIGTERM')
    await assert.rejects(read)
    assert.equal(manager.originalSessionLifetime(session, source), undefined)
    assert.throws(lifetime.assertCurrent)
    assert.equal((await wire('thread/resume')).length, 0)
  })

  it.each(['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN'])(
    'recognizes a managed worker launcher using %s and permits only its scoped execution credential', async tokenName => {
    const entry = nativeConnection({ ...appLauncherConnection(), environmentVariables: [tokenName] })
    await json('mcp.json', { enabled: true, transport: { ...entry, type: 'stdio' } })
    const inspected = await manager.inspectMcpConfiguration(f.directory)
    assert.equal(inspected.configured.automaticEndpoint, true)
    assert.equal(inspected.configured.bearerTokenEnvironmentVariable, tokenName)
    assert.equal((await manager.inspectMcp()).endpointMatches, true)
    const session = await manager.createSession(source)
    assert.equal(session.harness, 'codex')
    assert(session.nativeSessionId)
  })

  it('filters inherited database secrets on launch, credential refresh and cold resume', async () => {
    const environment = source.environment!
    const inherited = {
      DATABASE_URL: 'postgresql://test-only-owner:test-only-password@localhost/test-only-database',
      TEST_DATABASE_URL: 'postgresql://test-only-owner:test-only-password@localhost/test-only-database',
      PGPASSWORD: 'test-only-password',
      GRAPHQL_PRODUCTION_DB_PASSWORD: 'test-only-production-password',
      OPERATOR_TOKEN: 'test-only-operator-token',
      GRAPHQL_OPERATOR_TOKEN: 'test-only-operator-token',
      GRAPHQL_APP_TOKEN: 'test-only-app-token',
      GRAPHQL_MCP_TOKEN: 'test-only-ambient-token',
      TEST_VISIBLE_SETTING: 'retained-setting',
      NO_COLOR: 'ambient-color',
    }
    const expected: Record<string, string | null> = {
      ...Object.fromEntries(Object.keys(inherited).map((key) => [key, null])),
      GRAPHQL_MCP_TOKEN: environment.variables.GRAPHQL_MCP_TOKEN!,
      TEST_VISIBLE_SETTING: inherited.TEST_VISIBLE_SETTING,
      TEST_AGENT_ID: 'agent-a',
      NO_COLOR: '1',
    }
    for (const [key, value] of Object.entries(inherited)) vi.stubEnv(key, value)
    try {
      await json('expected-environment.json', expected)
      const session = await manager.createSession(source)
      await assertSpawnedEnvironment(expected, 1)

      source.environment = {
        agentId: environment.agentId,
        variables: { ...environment.variables, GRAPHQL_MCP_TOKEN: 'replacement-scoped-token' },
      }
      expected.GRAPHQL_MCP_TOKEN = 'replacement-scoped-token'
      await json('expected-environment.json', expected)
      await manager.refreshProcessEnvironment(session, source.environment!)
      await assertSpawnedEnvironment(expected, 2)
      assert.equal((await wire('thread/resume')).length, 1)

      await manager.closeForRestart(session)
      const replacement = makeManager()
      assert.deepEqual(await replacement.attachSession(session, source), session)
      await assertSpawnedEnvironment(expected, 3)
      assert.equal((await wire('thread/start')).length, 1)
      assert.equal((await wire('thread/resume')).length, 2)
      await collect(replacement.startTurn(session, { prompt: 'complete', clientCorrelationId: 'environment-recovered' }))
      assert.equal((await replacement.history(session)).terminalResult?.outcome, 'succeeded')
      for (const [key, value] of Object.entries(inherited)) assert.equal(process.env[key], value)
    } finally {
      vi.unstubAllEnvs()
    }
  }, 15_000)

  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'PGPASSWORD',
    'FOREMAN_CODE_PRODUCTION_DB_PASSWORD', 'GRAPHQL_PRODUCTION_DB_PASSWORD']) {
    it(`rejects ${key} reinjection on launch, credential refresh and cold resume`, async () => {
      const invalid = structuredClone(source)
      invalid.environment = {
        agentId: source.environment!.agentId,
        variables: { ...source.environment!.variables, [key]: 'test-only-database-secret' },
      }
      await assertCode(manager.createSession(invalid), 'CODEX_ENVIRONMENT_INVALID')
      assert.equal((await calls(f.directory)).length, 0)

      const session = await manager.createSession(source)
      const beforeRefresh = await calls(f.directory)
      await assertCode(manager.refreshProcessEnvironment(session, invalid.environment!), 'CODEX_ENVIRONMENT_INVALID')
      assert.deepEqual(await calls(f.directory), beforeRefresh)
      assert.equal((await processesForRequests(f.directory, 'thread/start')).length, 1)
      await assertMetadataProcessesClosed()
      assert.equal((await wire('thread/resume')).length, 0)
      await manager.inspectConfiguration(session)

      await manager.closeForRestart(session)
      const replacement = makeManager()
      const before = await calls(f.directory)
      await assertCode(replacement.attachSession(session, invalid), 'CODEX_ENVIRONMENT_INVALID')
      assert.deepEqual(await calls(f.directory), before)
      assert.deepEqual(await replacement.attachSession(session, source), session)
      await collect(replacement.startTurn(session, { prompt: 'complete', clientCorrelationId: 'valid-environment' }))
      assert.equal((await replacement.history(session)).terminalResult?.outcome, 'succeeded')
    }, 15_000)
  }

  it('resumes saved sessions on a newer compatible binary without rewriting their provenance', async () => {
    const session = await manager.createSession(source)
    await manager.dispose()
    await json('version.json', 'codex-cli 0.160.0')
    const replacement = makeManager()
    assert.deepEqual(await replacement.attachSession(session, source), session)
    assert.equal((await replacement.capabilities()).providerVersion, 'codex-cli 0.160.0')
    const fork = await replacement.forkSession(session, source)
    assert.equal(fork.providerVersion, 'codex-cli 0.160.0')
    assert.equal(session.providerVersion, 'codex-cli 0.154.0')
  })

  it('reports the installed version and model/list contract when discovery returns an invalid model identity', async () => {
    await json('version.json', 'codex-cli 0.160.0')
    await json('models.json', { models: [{ slug: '', supported_reasoning_levels: [{ effort: 'medium' }] }] })
    await assert.rejects(manager.discoverModels(f.directory), error => error instanceof Error
      && errorCode(error) === 'CODEX_MODEL_CATALOG_INVALID' && error.message.includes('0.160.0')
      && error.message.includes('model/list catalog response contract'))
    assert.equal((await wire('model/list')).length, 1)
    assert.equal((await wire('thread/start')).length, 0)
    await assertMetadataProcessesClosed()
  })

  it('F01: refuses another Agent, workspace, run, or workflow-node owner on loaded attachment', async () => {
    const session = await manager.createSession(source)
    await assertCode(manager.attachSession(session, input(f.directory, 'agent-b')), 'CODEX_SESSION_OWNER_MISMATCH')
    for (const key of ['workspaceId', 'runId', 'workflowNodeId'] as const) {
      const changed = structuredClone(source); changed.request[key] = 'other'
      await assertCode(manager.attachSession(session, changed), 'CODEX_SESSION_OWNER_MISMATCH')
    }
    assert.equal((await wire('thread/resume')).length, 0)
  })

  it('rejects a foreign qualified release identity for an already loaded session', async () => {
    const session = await manager.createSession(source)
    const foreign = { ...session, providerVersion: 'codex-cli 0.156.1' }
    await assertCode(manager.attachSession(foreign, source), 'CODEX_SESSION_VERSION_MISMATCH')
    await assertCode(collect(manager.startTurn(foreign, { prompt: 'no turn', clientCorrelationId: 'foreign' })), 'CODEX_SESSION_VERSION_MISMATCH')
    await assertCode(manager.close(foreign), 'CODEX_SESSION_VERSION_MISMATCH')
    assert.equal((await manager.history(session)).terminalResult, undefined)
  })

  it('preserves observed version provenance and rejects altered loaded references', async () => {
    const pinned = new CodexAppServerSessionManager(f.binary)
    managers.push(pinned)
    const session = await pinned.createSession(source)
    assert.equal(session.providerVersion, 'codex-cli 0.154.0')
    assert.equal((await pinned.history(session)).terminalResult, undefined)
    assert.equal((await pinned.sessionControlCapabilities(session)).compact.supported, true)
    await assertCode(pinned.history({ ...session, providerVersion: '0.154.0' }), 'CODEX_SESSION_VERSION_MISMATCH')
    await assertCode(pinned.history({ ...session, providerVersion: 'codex-cli 0.156.1' }), 'CODEX_SESSION_VERSION_MISMATCH')
  })

  it('F02: refuses every accepted configuration change, not just model/effort/cwd', async () => {
    codex().sandbox = 'danger-full-access'
    const session = await manager.createSession(source)
    const mutations: Array<(value: WorkflowNativeSessionStart) => void> = [
      (value) => { value.request.configuration.id = 'another-version' },
      (value) => { value.request.configuration.version += 1 },
      (value) => { value.request.configuration.contentHash = 'sha256:other' },
      (value) => { value.request.configuration.prompt.system = 'different instructions' },
      (value) => { codex(value).sandbox = 'read-only' },
      (value) => { codex(value).serviceTier = 'priority' },
      (value) => { codex(value).advanced!.approvalPolicy = 'never' },
      (value) => { codex(value).advanced!.approvalsReviewer = 'auto_review' },
      (value) => { codex(value).advanced!.additionalWritableDirectories = ['/other'] },
      (value) => { codex(value).advanced!.sessionPersistence = 'ephemeral' },
      (value) => { codex(value).advanced!.shellEnvironment.inherit = 'none' },
      (value) => { codex(value).advanced!.webSearch = 'disabled' },
      (value) => { codex(value).advanced!.mcpServers = { other: { enabled: false, required: false } } },
    ]
    for (const mutate of mutations) {
      const changed = structuredClone(source); mutate(changed)
      await assertCode(manager.attachSession(session, changed), 'CODEX_SESSION_CONFIGURATION_MISMATCH')
    }
    const changed = structuredClone(source)
    changed.environment = { agentId: 'agent-a', variables: { ...changed.environment!.variables, GRAPHQL_MCP_TOKEN: 'new-token' } }
    await assertCode(manager.attachSession(session, changed), 'CODEX_SESSION_ENVIRONMENT_REFRESH_REQUIRED')
    assert.equal((await wire('thread/read')).length, 0)
  })

  it('F02: snapshots caller-owned input and returned history without mutable aliases', async () => {
    const accepted = structuredClone(source)
    const session = await manager.createSession(source)
    codex().sandbox = 'danger-full-access'
    assert.deepEqual(await manager.attachSession(session, accepted), session)
    const history = await manager.history(session)
    ;(history.events as unknown[]).length = 0
    assert((await manager.history(session)).events.length > 0)
  })

  it('proves a freshly created owned thread is idle without remote history recovery', async () => {
    const session = await manager.createSession(source)
    const history = await manager.reconcile(session, 'prospective-turn')
    assert.equal(history.terminalResult, undefined)
    assert.deepEqual(history.pendingInteractions, [])
    assert.doesNotThrow(() => canonicalGraphJson(history))
    assert.equal((await wire('thread/read')).length, 0)
    assert.equal((await wire('thread/turns/list')).length, 0)
  })

  it('F03: rejected second start restores the previous completed result and permits another turn', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'first' }))
    const previous = (await manager.history(session)).terminalResult
    const reconciled = await manager.reconcile(session, 'first')
    assert.equal(reconciled.terminalTurn?.correlationId, 'first')
    assert.deepEqual(reconciled.terminalTurn?.result, previous)
    assert.equal((await wire('thread/read')).length, 0)
    assert.equal((await wire('thread/turns/list')).length, 0)
    await assertCode(collect(manager.startTurn(session, { prompt: 'reject', clientCorrelationId: 'rejected' })), 'CODEX_APP_SERVER_REQUEST_FAILED')
    assert.deepEqual((await manager.history(session)).terminalResult, previous)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'third' }))
    assert.equal((await wire('turn/start')).length, 3)
    assert.equal((await manager.history(session)).terminalResult?.outcome, 'succeeded')
  })

  for (const previous of [false, true]) it(`F04: cancellation during ${previous ? 'subsequent' : 'first'} startup interrupts only the new turn`, async () => {
    const session = await manager.createSession(source)
    if (previous) await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'old' }))
    const events = collect(manager.startTurn(session, { prompt: 'slow-start', clientCorrelationId: 'new' }))
    await until(async () => (await wire('turn/start')).length === (previous ? 2 : 1))
    assert.equal(await manager.cancel(session), true)
    await events
    const requests = await wire('turn/interrupt')
    assert.equal(requests.length, 1)
    assert.equal((requests[0]!.params as JsonObject).turnId, previous ? 'turn-2' : 'turn-1')
    assert.equal((await manager.history(session)).terminalResult?.outcome, 'canceled')
  })

  it('F04: retries the native startup window before the new turn becomes interruptible', async () => {
    const session = await manager.createSession(source)
    await flag('interrupt-startup-race')
    const events = collect(manager.startTurn(session, { prompt: 'slow-start', clientCorrelationId: 'new' }))
    await until(async () => (await wire('turn/start')).length === 1)
    assert.equal(await manager.cancel(session), true)
    await events
    assert.equal((await wire('turn/interrupt')).length, 2)
    assert.equal((await manager.history(session)).terminalResult?.outcome, 'canceled')
  })

  it('withdraws unsent preparation without interrupting the previous completed turn', async () => {
    const uncredentialed = structuredClone(source)
    delete uncredentialed.environment
    const { CodexStdioTransport } = await import('../src/modules/harnesses/codexStdioTransport.js')
    let preparing!: () => void
    const prepared = new Promise<void>((resolve) => { preparing = resolve })
    const fileManager = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'none', {
      prepare: async ({ clientCorrelationId, signal }) => {
        if (clientCorrelationId !== 'unsent') return undefined
        preparing()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
        })
        return undefined
      },
    }, {
      mode: 'native',
      transport: (...args) => {
        const readyId = randomUUID()
        args[2] = { ...args[2], TEST_CODEX_TRANSPORT_READY: readyId }
        return new class extends CodexStdioTransport {
          override async request(
            ...input: Parameters<InstanceType<typeof CodexStdioTransport>['request']>
          ): Promise<unknown> {
            if (input[0] === 'initialize') {
              // Start the RPC deadline after the fixture has installed its input handler.
              await until(async () => (await calls(f.directory)).some(call => call.nativeReady === readyId))
            }
            return super.request(...input)
          }
        }(...args)
      },
    })
    managers.push(fileManager)
    const session = await fileManager.createSession(uncredentialed)
    await collect(fileManager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'previous' }))
    const previous = (await fileManager.history(session)).terminalResult
    const stream = collect(fileManager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'unsent' }))
    const rejected = assert.rejects(stream, (error: unknown) => {
      assert(error instanceof NativeDeliveryError)
      assert.equal(error.operation, 'turn_submission')
      assert.equal(error.delivery, 'not_sent')
      assert.equal(error.cleanup, 'confirmed')
      assert(error.cause instanceof Error)
      assert.equal(error.cause.name, 'AbortError')
      return true
    })
    await prepared
    assert.equal(await fileManager.cancel(session), false)
    await rejected
    assert.equal((await wire('turn/start')).length, 1)
    assert.equal((await wire('turn/interrupt')).length, 0)
    assert.deepEqual((await fileManager.history(session)).terminalResult, previous)
    await collect(fileManager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'after-cancel' }))
    assert.equal((await wire('turn/start')).length, 2)
  })

  it('F05: foreign, old-turn and malformed notifications cannot clear approval or replace the answer', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'old' }))
    const { result } = await start(session, 'approval', 'new')
    const interaction = await pending(session)
    const current = (await state(f.directory, session.nativeSessionId)).turns.at(-1)!
    await emit(f.directory, { method: 'turn/completed', params: { threadId: 'foreign', turn: { ...current, status: 'completed' } } })
    await emit(f.directory, { method: 'item/completed', params: {
      threadId: session.nativeSessionId, turnId: 'turn-1', completedAtMs: 2,
      item: { id: 'stale', type: 'agentMessage', phase: 'final_answer', text: 'WRONG' },
    } })
    await emit(f.directory, { method: 'turn/completed', params: { threadId: session.nativeSessionId, turn: { status: 'bad' } } })
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'native.malformed'))
    assert.equal((await manager.pending(session))?.turn.nativeRequestId, interaction.turn.nativeRequestId)
    assert.equal((await manager.history(session)).terminalResult, undefined)
    await respond(session, interaction)
    await result
    assert.deepEqual((await manager.history(session)).terminalResult?.output, { text: 'approved-agent-a' })
  })

  it('F06: completed native recovery produces a terminal result and permits continuation', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'recover' }))
    const history = await manager.reconcile(session, 'recover')
    assert.deepEqual(history.terminalResult?.output, { text: 'recovered-answer' })
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'after-recovery' }))
    assert.equal((await wire('turn/start')).length, 2)
  })

  it('retains the exact native terminal source when recovering a disconnected workflow turn', async () => {
    const session = await manager.createSession(source)
    const execution = { id: source.request.executionId, agentId: source.request.configuration.agentId }
    const correlationId = `execution:${execution.id}`
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: correlationId }))
    const history = await manager.reconcile(session, correlationId)
    assert.equal(history.terminalTurn?.result.outcome, 'succeeded')
    assertOriginalWorkflowTerminal(execution, session, history)
    assert.equal((await wire('turn/start')).length, 1)
  })

  it('recovers a lost start acknowledgement by clientId while retaining the native item and turn identities', async () => {
    const session = await manager.createSession(source)
    const clientCorrelationId = 'application-request-456'
    await assert.rejects(collect(manager.startTurn(session, { prompt: 'lost-start', clientCorrelationId })))
    const native = (await state(f.directory, session.nativeSessionId)).turns[0]!
    const userMessage = (native.items as JsonObject[])[0]!
    assert.equal(userMessage.type, 'userMessage')
    assert.equal(userMessage.clientId, clientCorrelationId)
    assert.notEqual(userMessage.id, clientCorrelationId)
    await assertCode(manager.reconcile(session, 'wrong-correlation'), 'CODEX_CORRELATION_MISMATCH')
    await assertCode(collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'unsafe-retry' })), 'CODEX_TURN_ACTIVE')
    const history = await manager.reconcile(session, clientCorrelationId)
    assert.deepEqual(history.terminalResult?.output, { text: 'recovered-answer' })
    assert.equal(history.nativeTurnId, native.id)
    assert.equal(history.terminalTurn?.providerId, native.id)
    assert.equal(history.terminalTurn?.correlationId, clientCorrelationId)
    assert.equal((await wire('turn/start')).length, 1)
    assert.equal((await wire('thread/start')).length, 1)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'next' }))
  })

  it('recovers a lost steer acknowledgement by clientId only in its expected turn without replay or retargeting', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const native = (await state(f.directory, session.nativeSessionId)).turns[0]!
    const expectedTurnId = String(native.id)
    const clientCorrelationId = 'application-steer-456'
    await assertCode(manager.steerTurn(session, {
      prompt: 'lost-steer', clientCorrelationId, expectedTurnId,
    }), 'CODEX_APP_SERVER_TIMEOUT')
    const persisted = (await state(f.directory, session.nativeSessionId)).turns[0]!
    const userMessage = (persisted.items as JsonObject[]).at(-1)!
    assert.equal(userMessage.clientId, clientCorrelationId)
    assert.notEqual(userMessage.id, clientCorrelationId)
    const before = await manager.history(session)
    assert.deepEqual(await manager.reconcileSteers(session, [
      { clientCorrelationId, expectedTurnId: 'another-turn' },
      { clientCorrelationId: String(userMessage.id), expectedTurnId },
      { clientCorrelationId: 'missing-steer', expectedTurnId },
    ]), [])
    assert.deepEqual(await manager.reconcileSteers(session, [{ clientCorrelationId, expectedTurnId }]), [{
      nativeSessionId: session.nativeSessionId, nativeTurnId: expectedTurnId, correlationId: clientCorrelationId,
    }])
    assert.deepEqual(await manager.history(session), before)
    assert.equal((await wire('turn/steer')).length, 1)
    assert.equal((await wire('turn/start')).length, 1)
    assert.equal((await wire('thread/start')).length, 1)
    await finish(f.directory, session.nativeSessionId)
    await result
    assert.deepEqual(await manager.reconcileSteers(session, [{ clientCorrelationId, expectedTurnId }]), [{
      nativeSessionId: session.nativeSessionId, nativeTurnId: expectedTurnId, correlationId: clientCorrelationId,
    }])
  })

  it('keeps a lost start fenced when the native item id matches but clientId does not', async () => {
    const session = await manager.createSession(source)
    const clientCorrelationId = 'application-request-456'
    await assert.rejects(collect(manager.startTurn(session, { prompt: 'lost-start', clientCorrelationId })))
    const persisted = await state(f.directory, session.nativeSessionId)
    const userMessage = (persisted.turns[0]!.items as JsonObject[])[0]!
    userMessage.id = clientCorrelationId
    userMessage.clientId = 'another-request'
    await json(`state-${session.nativeSessionId}.json`, persisted)
    await assertCode(manager.reconcile(session, clientCorrelationId), 'CODEX_RECONCILIATION_UNCERTAIN')
    await assertCode(collect(manager.startTurn(session, {
      prompt: 'complete', clientCorrelationId: 'unsafe-retry',
    })), 'CODEX_TURN_ACTIVE')
    assert.equal((await wire('turn/start')).length, 1)
  })

  it('rejects conflicting start correlations in native history without replay', async () => {
    const session = await manager.createSession(source)
    const clientCorrelationId = 'application-request-456'
    await assert.rejects(collect(manager.startTurn(session, { prompt: 'lost-start', clientCorrelationId })))
    const persisted = await state(f.directory, session.nativeSessionId)
    const duplicate = structuredClone(persisted.turns[0]!)
    duplicate.id = 'another-turn'
    const duplicateUserMessage = (duplicate.items as JsonObject[])[0]!
    duplicateUserMessage.id = 'another-native-item'
    persisted.turns.push(duplicate)
    await json(`state-${session.nativeSessionId}.json`, persisted)
    await assertCode(manager.reconcile(session, clientCorrelationId), 'CODEX_CORRELATION_AMBIGUOUS')
    assert.equal((await wire('turn/start')).length, 1)
  })

  it('rejects conflicting steer correlations across native turns', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const persisted = await state(f.directory, session.nativeSessionId)
    const native = persisted.turns[0]!
    const clientCorrelationId = 'application-steer-456'
    const userMessage = { type: 'userMessage', id: 'native-steer-item', clientId: clientCorrelationId, content: [] }
    const items = native.items as JsonObject[]
    items.push(userMessage)
    persisted.turns.push({ ...structuredClone(native), id: 'another-turn' })
    await json(`state-${session.nativeSessionId}.json`, persisted)
    await assertCode(manager.reconcileSteers(session, [{
      clientCorrelationId, expectedTurnId: String(native.id),
    }]), 'CODEX_CORRELATION_AMBIGUOUS')
    assert.equal((await wire('turn/steer')).length, 0)
    assert.equal((await wire('turn/start')).length, 1)
    await emit(f.directory, { method: 'turn/completed', params: {
      threadId: session.nativeSessionId, turn: { ...native, status: 'completed' },
    } })
    await result
  })

  it('rejects another thread during steer reconciliation without changing the live owner', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const persisted = await state(f.directory, session.nativeSessionId)
    const before = await manager.history(session)
    persisted.id = 'another-thread'
    await json(`state-${session.nativeSessionId}.json`, persisted)
    await assertCode(manager.reconcileSteers(session, [{
      clientCorrelationId: 'application-steer-456', expectedTurnId: 'turn-1',
    }]), 'CODEX_SESSION_ID_MISMATCH')
    assert.deepEqual(await manager.history(session), before)
    assert.equal((await wire('thread/turns/list')).length, 0)
    persisted.id = session.nativeSessionId
    await json(`state-${session.nativeSessionId}.json`, persisted)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('keeps the active turn owner when reconciling an older clientId', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'older-request' }))
    const { result } = await start(session, 'wait', 'active-request')
    const before = await manager.history(session)
    await assertCode(manager.reconcile(session, 'older-request'), 'CODEX_SESSION_BUSY')
    assert.deepEqual(await manager.history(session), before)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('F07: failed restart cleans the candidate process and retains the original session', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'recover' }))
    await flag('fail-resume')
    await assertCode(manager.reconcile(session, 'recover'), 'CODEX_APP_SERVER_REQUEST_FAILED')
    const pids = (await processesForRequests(f.directory, 'thread/start', 'thread/resume'))
      .flatMap(entry => typeof entry.pid === 'number' ? [entry.pid] : [])
    assert.equal(pids.length, 2)
    await assertDead(pids[1]!)
    await assertMetadataProcessesClosed()
    await unflag('fail-resume')
    assert.equal((await manager.reconcile(session, 'recover')).terminalResult?.outcome, 'succeeded')
  })

  it('F12: a late turn ID remains correlated after timeout and cancellation reaches it', async () => {
    const session = await manager.createSession(source)
    const events = collect(manager.startTurn(session, { prompt: 'late-start', clientCorrelationId: 'late' }))
    await assertCode(events, 'CODEX_APP_SERVER_TIMEOUT')
    const canceled = manager.cancel(session)
    assert.equal(await canceled, true)
    await until(async () => (await manager.history(session)).terminalResult?.outcome === 'canceled')
    assert.equal((await wire('turn/start')).length, 1)
    assert.equal((await wire('turn/interrupt')).length, 1)
  })

  it('F12: an uncertain thread/start is never duplicated, and its late identity is recoverable', async () => {
    await flag('late-thread-start')
    await assertCode(manager.createSession(source), 'CODEX_APP_SERVER_TIMEOUT')
    await assertCode(manager.createSession(source), 'CODEX_SESSION_CREATION_UNCERTAIN')
    const session = await until(async () => { try { return await manager.reconcileSessionCreation(source) } catch { return undefined } })
    assert.deepEqual(await manager.createSession(source), session)
    assert.equal((await wire('thread/start')).length, 1)
  })

  it('retains an incomplete fixture notification until its remaining bytes arrive', async () => {
    const session = await manager.createSession(source)
    const message = JSON.stringify({ method: 'thread/name/updated',
      params: { threadId: session.nativeSessionId, threadName: 'split-notification' } }) + '\n'
    const midpoint = Math.floor(message.length / 2)
    const inbox = join(f.directory, 'inbox-agent-a.jsonl')
    await appendFile(inbox, message.slice(0, midpoint))
    await until(async () => (await calls(f.directory)).some(entry => entry.inboxBufferedLength === midpoint))
    assert(!(await manager.history(session)).events.some(event => event.type === 'transport.disconnected'))
    await appendFile(inbox, message.slice(midpoint))
    await until(async () => (await manager.history(session)).events
      .some(event => event.payload.threadName === 'split-notification'))
    const history = await manager.history(session)
    assert.equal(history.events.filter(event => event.payload.threadName === 'split-notification').length, 1)
    assert(!history.events.some(event => event.type === 'native.malformed' || event.type === 'transport.disconnected'))
  })

  it('retains large qualified events with bounded history and monotonic cursors', async () => {
    const session = await manager.createSession(source)
    const large = 'x'.repeat(1_100_000)
    await emit(f.directory, { method: 'thread/name/updated',
      params: { threadId: session.nativeSessionId, threadName: large } })
    await until(async () => (await manager.history(session)).events.some((event) => event.payload.threadName === large))
    const batch = Array.from({ length: 1_100 }, (_, value) => JSON.stringify({ method: 'thread/name/updated',
      params: { threadId: session.nativeSessionId, threadName: `thread-name-${value}` } })).join('\n') + '\n'
    await appendFile(join(f.directory, 'inbox-agent-a.jsonl'), batch)
    await until(async () => (await manager.history(session)).events.some((event) => event.payload.threadName === 'thread-name-1099'))
    const history = await manager.history(session)
    assert(history.events.length <= 1024)
    assert((history.firstRetainedSequence ?? 0) > 0)
    assert.equal(history.events.at(-1)!.sequence + 1, history.nextSequence)
  }, 15_000)

  it('F15: native resolution clears the addressed prompt and a duplicate cannot reopen it', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const value = await pending(session)
    const original = (await state(f.directory, session.nativeSessionId)).turns.at(-1)!
    await emit(f.directory, { method: 'serverRequest/resolved', params: { threadId: session.nativeSessionId, requestId: 901 } })
    await until(async () => (await manager.history(session)).pendingInteractions.length === 0)
    await inject(session, 'item/commandExecution/requestApproval', {
      itemId: 'command-901', command: 'printf harmless', cwd: f.directory, availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    }, 901)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(await manager.pending(session), undefined)
    assert.equal((await wire()).filter((message) => message.id === 901 && message.error).length, 0)
    await emit(f.directory, { method: 'turn/completed', params: { threadId: session.nativeSessionId, turn: { ...original, status: 'completed' } } })
    await result
    assert(value.turn.nativeRequestId)
  })

  for (const surface of ['workflow', 'operator', 'agent-chat', 'selected-run-continuation']) {
    it(`inspects a current ${surface} callback from its explicit native startup shape`, async () => {
      const fixtureSource = codexResponseSurfaceFixtures(f.directory).find((entry) => entry.surface === surface)!
      const scoped = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, fixtureSource.appMcpAccess)
      managers.push(scoped)
      const session = await scoped.createSession(fixtureSource.source)
      const events = collect(scoped.startTurn(session, { prompt: 'approval', clientCorrelationId: `${surface}-fixture-turn` }))
      const value = await until(() => scoped.pending(session))
      const lifetime = scoped.originalSessionLifetime(session, fixtureSource.source)!
      assert(lifetime)
      assert.equal(lifetime.residency.nativeTurnId, value.turn.nativeTurnId)
      assert.deepEqual(await scoped.reattachOriginalSession(session, fixtureSource.source, lifetime.residency), session)
      lifetime.assertCurrent()
      const query = responseQuery(value)
      const before = await wire()
      const inspected = await scoped.inspectResponseAvailability(session, query)
      assert.equal(inspected.state, 'available')
      assert.equal(inspected.path, 'live_callback')
      assert(inspected.generation)
      assert.deepEqual(await wire(), before)
      if (fixtureSource.appMcpAccess === 'none') assert.equal(fixtureSource.source.environment, undefined)
      if (fixtureSource.surface === 'selected-run-continuation') assert.equal(fixtureSource.runtimeRole, 'agent-chat')
      const current = await state(f.directory, session.nativeSessionId)
      await emit(f.directory, { method: 'turn/completed', params: { threadId: session.nativeSessionId,
        turn: { ...current.turns.at(-1)!, status: 'completed', completedAt: 2 } } }, fixtureSource.inboxAgentId)
      await events
      assert.equal((await scoped.inspectResponseAvailability(session, query)).state, 'unavailable')
    })
  }

  it('inspects only the exact live response callback without native writes or history changes', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const value = await pending(session)
    const query = responseQuery(value)
    const beforeWire = await wire()
    const beforeHistory = await manager.history(session)
    const available = await manager.inspectResponseAvailability(session, query)
    assert.equal(available.state, 'available')
    assert.equal(available.path, 'live_callback')
    assert.equal(available.reason, 'live_callback')
    assert.equal(available.qualified, true)
    assert(available.generation)
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(manager.inspectResponseAvailability(session, query, aborted.signal))
    for (const [changed, reason] of [
      [{ ...query, nativeRequestId: 'not-the-callback' }, 'callback_lost'],
      [{ ...query, nativeRequestType: 'item/fileChange/requestApproval' }, 'identity_mismatch'],
      [{ ...query, expectedNativeTurnId: 'older-turn' }, 'identity_mismatch'],
    ] as const) {
      const rejected = await manager.inspectResponseAvailability(session, changed)
      assert.equal(rejected.state, 'unavailable')
      assert.equal(rejected.reason, reason)
    }
    assert.equal((await manager.inspectResponseAvailability({ ...session, nativeSessionId: 'another-thread' }, query)).state, 'unavailable')
    assert.deepEqual(await wire(), beforeWire)
    assert.deepEqual(await manager.history(session), beforeHistory)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('fences a conflicting exact RPC identity without replying to either approval', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const value = await pending(session)
    const query = responseQuery(value)
    const before = await wire()
    await inject(session, 'item/commandExecution/requestApproval', {
      itemId: 'different-command', command: 'printf conflicting-command', cwd: f.directory,
      availableDecisions: ['accept', 'decline'],
    }, 901)
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'protocol.conflicting_request_identity'))
    const availability = await manager.inspectResponseAvailability(session, query)
    assert.equal(availability.state, 'recovery_required')
    assert.equal(availability.reason, 'identity_mismatch')
    await assertCode(manager.respond(session, query.nativeRequestId, value.responseOptions[0]!), 'NATIVE_RESPONSE_RECONCILIATION_REQUIRED')
    assert.deepEqual(await wire(), before)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('requires response recovery after submission or uncertainty instead of offering the callback again', async () => {
    await flag('no-resolution')
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const value = await pending(session)
    const query = responseQuery(value)
    const controller = new AbortController()
    const response = manager.respond(session, query.nativeRequestId, value.responseOptions[0]!, controller.signal)
    void response.catch(() => undefined)
    assert.equal((await manager.inspectResponseAvailability(session, query)).state, 'recovery_required')
    await until(async () => (await manager.history(session)).interactionDeliveries?.[0]?.state === 'submitted')
    assert.equal((await manager.inspectResponseAvailability(session, query)).state, 'recovery_required')
    assert.equal((await manager.inspectResponseAvailability(session, query)).reason, 'response_in_flight')
    controller.abort(new Error('stop waiting for delivery confirmation'))
    await assert.rejects(response)
    const before = await wire()
    assert.equal((await manager.inspectResponseAvailability(session, query)).state, 'recovery_required')
    assert.deepEqual(await wire(), before)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('reports a consumed exact callback without inferring which response was delivered', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const value = await pending(session)
    const query = responseQuery(value)
    await emit(f.directory, { method: 'serverRequest/resolved', params: { threadId: session.nativeSessionId, requestId: 901 } })
    await until(async () => (await manager.history(session)).pendingInteractions.length === 0)
    const before = await wire()
    const consumed = await manager.inspectResponseAvailability(session, query)
    assert.equal(consumed.state, 'unavailable')
    assert.equal(consumed.reason, 'request_consumed')
    assert.equal(consumed.path, null)
    assert.deepEqual(await wire(), before)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('requires a fresh callback after same-manager native reconnection', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const old = await pending(session)
    const oldQuery = responseQuery(old)
    const original = await manager.inspectResponseAvailability(session, oldQuery)
    const launched = (await processesForRequests(f.directory, 'thread/start'))[0]
    assert(launched && typeof launched.pid === 'number')
    process.kill(launched.pid, 'SIGTERM')
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'transport.disconnected'))
    await result
    await manager.reconcile(session, 'turn-correlation')
    const recovered = await manager.inspectResponseAvailability(session, oldQuery)
    assert.equal(recovered.state, 'recovery_required')
    assert.equal(recovered.path, null)
    await inject(session, 'item/commandExecution/requestApproval', {
      itemId: 'command-901', command: 'printf harmless', cwd: f.directory,
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    }, 901)
    const fresh = await pending(session)
    assert.notEqual(fresh.turn.nativeRequestId, old.turn.nativeRequestId)
    const available = await manager.inspectResponseAvailability(session, responseQuery(fresh))
    assert.equal(available.state, 'available')
    assert.notEqual(available.generation, original.generation)
    assert.equal((await manager.inspectResponseAvailability(session, oldQuery)).state, 'recovery_required')
  })

  it('does not alias a saved callback after cold attach reuses the same turn and native RPC ID', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const old = await pending(session)
    const oldQuery = responseQuery(old)
    await manager.closeForRestart(session)
    await result
    assert.equal((await manager.inspectResponseAvailability(session, oldQuery)).state, 'unavailable')
    const replacement = makeManager()
    await replacement.attachSession(session, source)
    await replacement.reconcile(session, 'turn-correlation')
    assert.equal((await replacement.inspectResponseAvailability(session, oldQuery)).reason, 'callback_lost')
    await inject(session, 'item/commandExecution/requestApproval', {
      itemId: 'different-command-901', command: 'printf fresh-command', cwd: f.directory,
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    }, 901)
    const fresh = await until(() => replacement.pending(session))
    assert.equal(fresh.turn.nativeTurnId, old.turn.nativeTurnId)
    assert.notEqual(fresh.turn.nativeRequestId, old.turn.nativeRequestId)
    assert.notEqual(fresh.responseOptions[0]!.optionId, old.responseOptions[0]!.optionId)
    const before = await wire()
    assert.equal((await replacement.inspectResponseAvailability(session, oldQuery)).state, 'unavailable')
    assert.equal((await replacement.inspectResponseAvailability(session, responseQuery(fresh))).state, 'available')
    await assertCode(replacement.respond(session, oldQuery.nativeRequestId, old.responseOptions[0]!), 'NATIVE_RESPONSE_UNKNOWN_REQUEST')
    assert.deepEqual(await wire(), before)
    assert.equal((await wire('thread/start')).length, 1)
    assert.equal((await wire('turn/start')).length, 1)
  })

  it('F16/F17: pipe submission keeps the mapping; uncertain responses cannot be retransmitted', async () => {
    await flag('no-resolution')
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const value = await pending(session)
    const option = value.responseOptions[0]!
    const abort = new AbortController()
    const response = manager.respond(session, value.turn.nativeRequestId!, option, abort.signal)
    void response.catch(() => undefined)
    await until(async () => (await manager.history(session)).interactionDeliveries?.[0]?.state === 'submitted')
    assert.equal(await manager.pending(session), undefined)
    assert.equal((await manager.history(session)).pendingInteractions.length, 1)
    assert(!(await manager.history(session)).events.some((event) => event.type === 'interaction.responded'))
    abort.abort(new Error('stop awaiting confirmation'))
    await assert.rejects(response)
    await assertCode(manager.respond(session, value.turn.nativeRequestId!, option), 'NATIVE_RESPONSE_RECONCILIATION_REQUIRED')
    await manager.reconcile(session, 'turn-correlation')
    await assertCode(manager.respond(session, value.turn.nativeRequestId!, option), 'NATIVE_RESPONSE_RECONCILIATION_REQUIRED')
    assert.equal((await wire()).filter((message) => message.id === 901 && message.result).length, 1)
    await emit(f.directory, { method: 'serverRequest/resolved', params: { threadId: session.nativeSessionId, requestId: 901 } })
    await until(async () => (await manager.history(session)).pendingInteractions.length === 0)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('restart closes a pending approval without selecting or widening a native permission', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    await pending(session)
    await manager.closeForRestart(session)
    await result.catch(() => undefined)
    assert.equal((await wire()).filter((message) => message.id === 901 && message.result).length, 0)
    assert.equal((await wire()).filter((message) => message.id === 901 && message.error).length, 0)
  })

  it('F18/F32: duplicate native requests are idempotent and legitimate concurrent requests are retained', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'multi')
    await until(async () => (await manager.history(session)).pendingInteractions.length === 2)
    const first = await pending(session)
    await respond(session, first)
    const second = await pending(session)
    assert.notEqual(first.turn.nativeRequestId, second.turn.nativeRequestId)
    await respond(session, second)
    await result
    assert.equal((await wire()).filter((message) => [901, 1901].includes(message.id as number) && message.error).length, 0)
    assert.equal((await wire()).filter((message) => [901, 1901].includes(message.id as number) && message.result).length, 2)
  })

  it('F19/F10: qualified tool approval choices have exact semantics and empty descriptions are safe', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    await inject(session, 'item/tool/requestUserInput', { itemId: 'tool', isBlocking: true, autoResolutionMs: null, questions: [{
      id: 'mcp_tool_call_approval_tool', header: 'Approve app tool call?', question: 'Allow?', isOther: false, isSecret: false,
      options: ['Allow', 'Allow for this session', "Allow and don't ask me again", 'Cancel'].map((label) => ({ label, description: '' })),
    }] })
    const value = await pending(session)
    assert.deepEqual(value.responseOptions.map((option) => option.semantic), ['approve_once', 'allow_session', 'persistent_policy_change', 'cancel'])
    assert(value.responseOptions.every((option) => option.scopeSummary === undefined))
    assert.equal(value.responseOptions.at(-1)!.interruptsCurrentTurn, false)
    await respond(session, value, 'cancel')
    const response = (await wire()).find((entry) => entry.id === 4000 && entry.result)!
    assert.deepEqual(response.result, { answers: { mcp_tool_call_approval_tool: { answers: ['Cancel'] } } })
    await finish(f.directory, session.nativeSessionId); await result
  })

  it('keeps generic questions pending until an explicit valid answer is supplied', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    await inject(session, 'item/tool/requestUserInput', { itemId: 'tool', isBlocking: true, autoResolutionMs: null, questions: [{
      id: 'generic', header: 'Question', question: 'Choose', isOther: false, isSecret: false,
      options: ['Decline', 'Cancel'].map((label) => ({ label, description: '' })),
    }] })
    const value = await pending(session)
    const option = value.responseOptions[0]!
    assert.equal(option.input?.kind, 'questions')
    assert.equal((await wire()).filter((message) => message.id === 4000 && message.result).length, 0)
    await assert.rejects(manager.respond(session, value.turn.nativeRequestId!, { ...option,
      response: { generic: { answers: ['invented'] } } }))
    assert.equal((await manager.pending(session))?.turn.nativeRequestId, value.turn.nativeRequestId)
    await manager.respond(session, value.turn.nativeRequestId!, { ...option,
      response: { generic: { answers: ['Decline'] } } })
    assert.deepEqual((await wire()).find((message) => message.id === 4000 && message.result)!.result,
      { answers: { generic: { answers: ['Decline'] } } })
    assert(!(await manager.history(session)).events.some((event) => event.type === 'interaction.unsupported'))
    assert.equal(await manager.pending(session), undefined)
    await finish(f.directory, session.nativeSessionId); await result
  })

  it('answers the supported MCP approval question only after an explicit offered choice', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    await inject(session, 'item/tool/requestUserInput', { itemId: 'tool', isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'mcp_tool_call_approval_tool', header: 'Approve app tool call?', question: 'Allow?',
        isOther: false, isSecret: false, options: ['Allow', 'Cancel'].map((label) => ({ label, description: '' })) }] })
    const value = await pending(session)
    assert.equal((await wire()).filter((message) => message.id === 4000 && (message.result || message.error)).length, 0)
    await respond(session, value)
    assert.deepEqual((await wire()).find((entry) => entry.id === 4000 && entry.result)!.result,
      { answers: { mcp_tool_call_approval_tool: { answers: ['Allow'] } } })
    assert(!(await manager.history(session)).events.some((event) => event.type === 'interaction.unsupported'))
    await finish(f.directory, session.nativeSessionId); await result
  })

  for (const mode of ['url', 'form'] as const) it(`F20: ${mode} confirmation has an exact native acceptance path`, async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const extra = mode === 'url' ? { url: 'https://example.invalid/authorize', elicitationId: 'authorization-1' } : { requestedSchema: { type: 'object', properties: {} } }
    await inject(session, 'mcpServer/elicitation/request', { mode, message: 'Confirm', serverName: 'app', _meta: null, ...extra })
    const value = await pending(session)
    await respond(session, value)
    assert.deepEqual((await wire()).find((entry) => entry.id === 4000 && entry.result)!.result, { action: 'accept', content: mode === 'url' ? null : {}, _meta: null })
    await finish(f.directory, session.nativeSessionId); await result
  })

  it('F20: qualified elicitation scope metadata is preserved, not guessed from labels', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    await inject(session, 'mcpServer/elicitation/request', {
      mode: 'form', message: 'Allow tool', serverName: 'app', requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
    })
    const value = await pending(session)
    assert(value.responseOptions.some((option) => option.semantic === 'persistent_policy_change' && option.mutatesPersistentPolicy))
    await respond(session, value, 'allow_session')
    assert.deepEqual((await wire()).find((entry) => entry.id === 4000 && entry.result)!.result, { action: 'accept', content: {}, _meta: { persist: 'session' } })
    await finish(f.directory, session.nativeSessionId); await result
  })

  it('answers standalone elicitations explicitly without attaching them to an old turn', async () => {
    const session = await manager.createSession(source)
    for (const afterTurn of [false, true]) {
      if (afterTurn) await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'old' }))
      const id = afterTurn ? 4001 : 4000
      await emit(f.directory, { id, method: 'mcpServer/elicitation/request', params: { threadId: session.nativeSessionId, turnId: null,
        mode: 'url', url: 'https://example.invalid/', elicitationId: 'standalone', serverName: 'app', message: 'Authorize', _meta: null } })
      const value = await pending(session)
      assert.equal(value.turn.nativeTurnId, undefined)
      assert.equal((await wire()).filter((entry) => entry.id === id && entry.result).length, 0)
      const availability = await manager.inspectResponseAvailability(session, {
        nativeRequestId: value.turn.nativeRequestId!, nativeRequestType: value.nativeRequestType,
      })
      assert.equal(availability.state, 'available')
      await respond(session, value)
      assert.deepEqual((await wire()).find((entry) => entry.id === id && entry.result)!.result,
        { action: 'accept', content: null, _meta: null })
      assert(!(await manager.history(session)).events.some((event) => event.type === 'interaction.unsupported'))
      assert.equal(await manager.pending(session), undefined)
    }
  })

  it.each(['form', 'openai/form', 'openaiForm'])('validates %s data-entry forms before writing the user response', async (mode) => {
    let phase = 'creating session'
    onTestFailed(() => { console.error(`Codex ${mode} data-entry failure during ${phase}`) })
    const session = await manager.createSession(source)
    phase = 'starting turn'
    const { result } = await start(session)
    phase = 'injecting form'
    const requestedSchema = { type: 'object', properties: { email: { type: 'string', format: 'email' } },
      required: ['email'], ...(mode === 'form' ? {} : { additionalProperties: false }) }
    await inject(session, 'mcpServer/elicitation/request', { mode, serverName: 'app', message: 'Enter email', _meta: null,
      requestedSchema }, 4002)
    phase = 'waiting for form'
    const value = await pending(session)
    const option = value.responseOptions[0]!
    assert.equal((await wire()).filter((entry) => entry.id === 4002 && entry.result).length, 0)
    const invalidResponses: InteractionResponseValue[] = [{}, { email: 'invalid' }, { email: 42 },
      ...(mode === 'form' ? [] : [{ email: 'user@example.com', extra: true }])]
    for (const response of invalidResponses) {
      phase = `rejecting invalid form: ${JSON.stringify(response)}`
      await assert.rejects(manager.respond(session, value.turn.nativeRequestId!, { ...option, response }))
    }
    assert.equal((await manager.pending(session))?.turn.nativeRequestId, value.turn.nativeRequestId)
    assert.equal((await wire()).filter((entry) => entry.id === 4002 && entry.result).length, 0)
    const response: InteractionResponseValue = { email: 'user@example.com', ...(mode === 'form' ? { extra: true } : {}) }
    phase = 'delivering valid form'
    await manager.respond(session, value.turn.nativeRequestId!, { ...option, response })
    phase = 'reading delivered form'
    assert.deepEqual((await wire()).find((entry) => entry.id === 4002 && entry.result)!.result,
      { action: 'accept', content: response, _meta: null })
    assert(!(await manager.history(session)).events.some((event) => event.type === 'interaction.unsupported'))
    assert.equal(await manager.pending(session), undefined)
    phase = 'finishing turn'
    await finish(f.directory, session.nativeSessionId)
    phase = 'draining terminal turn'
    await result
  })

  it('rejects a malformed standard form envelope before offering input', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    await inject(session, 'mcpServer/elicitation/request', { mode: 'form', serverName: 'app', message: 'Enter email',
      requestedSchema: { type: 'object', additionalProperties: false,
        properties: { email: { type: 'string', format: 'email' } }, required: ['email'] } }, 4003)
    const rejected = await until(async () => (await wire()).find((entry) => entry.id === 4003 && entry.error))
    assert(isObject(rejected.error))
    assert.equal(rejected.error.code, -32602)
    assert.equal(await manager.pending(session), undefined)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('does not resend answered questions for repeated or conflicting callback identities', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const question = { itemId: 'question', isBlocking: true, autoResolutionMs: null, questions: [{
      id: 'generic', header: 'Question', question: 'Choose', isOther: true, isSecret: false, options: null,
    }] }
    await inject(session, 'item/tool/requestUserInput', question)
    const value = await pending(session)
    await manager.respond(session, value.turn.nativeRequestId!, { ...value.responseOptions[0]!,
      response: { generic: { answers: ['User-entered answer'] } } })
    await inject(session, 'item/tool/requestUserInput', question)
    await inject(session, 'item/tool/requestUserInput', { ...question, itemId: 'conflicting-question' })
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'protocol.conflicting_request_identity'))
    assert.equal((await wire()).filter((entry) => entry.id === 4000 && (entry.result || entry.error)).length, 1)
    assert.equal((await manager.history(session)).events.filter((event) => event.type === 'interaction.unsupported').length, 0)
    await finish(f.directory, session.nativeSessionId); await result
  })

  it('advertises question and schema-validated form support', async () => {
    const capabilities = await manager.capabilities()
    assert.deepEqual(capabilities.interactionSupport, CODEX_INTERACTION_SUPPORT)
    assert(capabilities.supportedInteractionKinds.includes('mcp_tool_call_approval_question'))
    assert(capabilities.supportedInteractionKinds.includes('mcp_confirmation'))
    assert(capabilities.supportedInteractionKinds.includes('tool_user_input'))
    assert(capabilities.supportedInteractionKinds.includes('mcp_elicitation'))
  })

  it.each(['foreign-thread', 'old-turn'])('keeps form responses behind the %s ownership fence', async (target) => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    await inject(session, 'mcpServer/elicitation/request', { mode: 'form', serverName: 'app', message: 'Enter email',
      _meta: null, requestedSchema: { type: 'object', properties: { email: { type: 'string' } } },
      ...(target === 'foreign-thread' ? { threadId: 'foreign-thread' } : { turnId: 'old-turn' }) })
    await until(async () => (await wire()).some((entry) => entry.id === 4000 && entry.error))
    assert.equal((await wire()).filter((entry) => entry.id === 4000 && entry.result).length, 0)
    assert(!(await manager.history(session)).events.some((event) => event.type === 'interaction.unsupported'))
    await finish(f.directory, session.nativeSessionId); await result
  })

  it('F22: distinct network and exec policy amendments retain distinct option IDs and targets', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const decisions = [
      { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow', host: 'a.example' } } },
      { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'deny', host: 'b.example' } } },
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } },
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'diff'] } },
    ]
    await inject(session, 'item/commandExecution/requestApproval', { itemId: 'cmd', availableDecisions: decisions })
    const value = await pending(session)
    assert.equal(new Set(value.responseOptions.map((option) => option.optionId)).size, 4)
    assert(value.responseOptions[0]!.label.includes('allow') && value.responseOptions[0]!.label.includes('a.example'))
    assert(value.responseOptions[1]!.label.includes('deny') && value.responseOptions[1]!.label.includes('b.example'))
    await manager.respond(session, value.turn.nativeRequestId!, value.responseOptions[1]!)
    assert.deepEqual((await wire()).find((entry) => entry.id === 4000 && entry.result)!.result, { decision: decisions[1] })
    await finish(f.directory, session.nativeSessionId); await result
  })

  for (const kind of ['command', 'file', 'permissions', 'tool', 'elicitation']) it(`F23: ephemeral ${kind} requests never offer session grants`, async () => {
    codex().advanced!.sessionPersistence = 'ephemeral'
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const requests: Record<string, [string, JsonObject]> = {
      command: ['item/commandExecution/requestApproval', { itemId: 'cmd', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] }],
      file: ['item/fileChange/requestApproval', { itemId: 'file', reason: null, grantRoot: null }],
      permissions: ['item/permissions/requestApproval', { itemId: 'permission', cwd: f.directory, permissions: {} }],
      tool: ['item/tool/requestUserInput', { itemId: 'tool', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'mcp_tool_call_approval_t', header: 'Approve app tool call?', question: 'Allow?', isOther: false, isSecret: false, options: ['Allow', 'Allow for this session', 'Cancel'].map((label) => ({ label, description: '' })) }] }],
      elicitation: ['mcpServer/elicitation/request', { mode: 'form', serverName: 'app', message: 'Confirm', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', persist: 'session' } }],
    }
    const [method, params] = requests[kind]!
    await inject(session, method, params)
    const value = await pending(session)
    assert(!value.responseOptions.some((option) => option.semantic === 'allow_session'))
    await manager.respond(session, value.turn.nativeRequestId!, value.responseOptions[0]!)
    await finish(f.directory, session.nativeSessionId); await result
  })

  it('F24: fresh logged-out login uses a control transport with no execution thread', async () => {
    await flag('logged-out')
    await assertCode(manager.createSession(source), 'CODEX_APP_SERVER_AUTH_UNQUALIFIED')
    const result = await manager.startDeviceCodeLogin()
    assert.equal(result.loginId, 'login-1')
    assert.equal((await wire('thread/start')).length, 0)
    await manager.cancelLogin(undefined, 'login-1')
    const pid = (await calls(f.directory)).find((entry) => typeof entry.pid === 'number')!.pid as number
    await assertDead(pid)
    await unflag('logged-out')
    await manager.createSession(source)
  })

  it('F25: native approval_mode and unordered tool sets normalize semantically', async () => {
    codex().advanced!.mcpServers = { 'graphql': {
      enabled: true, required: true, enabledTools: ['a', 'b'], disabledTools: ['c', 'd'], defaultToolsApprovalMode: 'prompt',
      tools: { b: { approvalMode: 'writes', enabled: false }, a: { approvalMode: 'prompt' } },
    } }
    await json('mcp.json', { enabled: true, required: true, enabled_tools: ['b', 'a'], disabled_tools: ['d', 'c'],
      default_tools_approval_mode: 'prompt', tools: { a: { approval_mode: 'prompt', enabled: true }, b: { enabled: false, approval_mode: 'writes' } },
      transport: { type: 'streamable_http', bearer_token_env_var: 'GRAPHQL_MCP_TOKEN' } })
    await manager.createSession(source)
    const changed = input(f.directory, 'agent-b'); codex(changed).advanced = structuredClone(codex().advanced!)
    codex(changed).advanced!.mcpServers['graphql']!.tools!.a!.approvalMode = 'auto'
    await assertCode(manager.createSession(changed), 'CODEX_MCP_POLICY_MISMATCH')
  })

  it('accepts the native priority response for requested fast mode on start and resume', async () => {
    await flag('native-priority-tier')
    codex().serviceTier = 'priority'
    const session = await manager.createSession(source)
    await manager.dispose()
    manager = makeManager()
    await manager.attachSession(session, source)
    assert.equal(((await wire('thread/resume')).at(-1)?.params as JsonObject).serviceTier, 'fast')
    const native = await state(f.directory, session.nativeSessionId)
    assert.equal(native.settings.serviceTier, 'priority')
  })

  for (const setting of ['model', 'effort', 'fast']) it(`F26: rejects unsupported model catalog ${setting} before thread creation`, async () => {
    if (setting === 'model') codex().model = 'unavailable'
    if (setting === 'effort') codex().reasoningEffort = 'xhigh'
    if (setting === 'fast') {
      codex().serviceTier = 'priority'
      await json('models.json', { models: [{ slug: 'test-model', supported_reasoning_levels: [{ effort: 'medium' }], additional_speed_tiers: [] }] })
    }
    await assert.rejects(manager.createSession(source))
    assert.equal((await wire('thread/start')).length, 0)
  })

  it('rechecks observed version and authentication after a compatible replacement', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'recover' }))
    await json('version.json', 'codex-cli 0.155.0')
    const compatible = await manager.createSession(input(f.directory, 'agent-b'))
    assert.equal(compatible.providerVersion, 'codex-cli 0.155.0')
    assert.equal((await manager.reconcile(session, 'recover')).terminalResult?.outcome, 'succeeded')
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'auth-recover' }))
    await flag('logged-out')
    await assertCode(manager.createSession(input(f.directory, 'agent-c')), 'CODEX_APP_SERVER_AUTH_UNQUALIFIED')
    await assertCode(manager.reconcile(session, 'auth-recover'), 'CODEX_APP_SERVER_AUTH_UNQUALIFIED')
    await unflag('logged-out')
    assert.equal((await manager.reconcile(session, 'auth-recover')).terminalResult?.outcome, 'succeeded')
  })

  it('resumes a saved thread across compatible Codex releases while retaining its provenance', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'recover' }))
    await json('version.json', 'codex-cli 0.156.1')
    assert.equal((await manager.reconcile(session, 'recover')).terminalResult?.outcome, 'succeeded')
    assert.equal((await wire('thread/resume')).length, 1)
    assert.equal(session.providerVersion, 'codex-cli 0.154.0')
    await unflag('version.json')
    assert.equal((await manager.reconcile(session, 'recover')).terminalResult?.outcome, 'succeeded')
  })

  it('F29: the manager accepts contract-valid Windows writable paths rather than checking only slash prefixes', async () => {
    codex().sandbox = 'workspace-write'; codex().advanced!.additionalWritableDirectories = ['C:\\work']
    const session = await manager.createSession(source)
    const params = (await wire('thread/start'))[0]!.params as JsonObject
    assert.deepEqual((params.config as JsonObject).sandbox_workspace_write, {
      writable_roots: ['C:\\work'], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false,
    })
    assert(session.nativeSessionId)
  })

  it('F30: refresh can add credentials to an owner-bound session with no original environment', async () => {
    await flag('no-mcp'); delete source.environment
    const session = await manager.createSession(source)
    await unflag('no-mcp')
    await assertCode(manager.refreshProcessEnvironment(session, { agentId: 'agent-a', variables: {} }), 'CODEX_SCOPED_ENVIRONMENT_REQUIRED')
    assert.equal((await wire('thread/resume')).length, 0)
    await manager.refreshProcessEnvironment(session, { agentId: 'agent-a', variables: { TEST_AGENT_ID: 'agent-a', GRAPHQL_MCP_TOKEN: 'new' } })
    assert.equal((await wire('thread/resume')).length, 1)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'refreshed' }))
  })

  it('F31: restart reapplies accepted settings after persisted native drift, and rejects unapplied drift', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'recover' }))
    const native = await state(f.directory, session.nativeSessionId)
    native.settings.sandbox = { type: 'dangerFullAccess' }; native.settings.model = 'other-model'; native.settings.serviceTier = 'fast'
    await json(`state-${session.nativeSessionId}.json`, native)
    await flag('ignore-resume-settings')
    await assertCode(manager.reconcile(session, 'recover'), 'CODEX_EFFECTIVE_SETTINGS_MISMATCH')
    await unflag('ignore-resume-settings')
    await manager.reconcile(session, 'recover')
    const params = (await wire('thread/resume')).at(-1)!.params as JsonObject
    assert.equal(params.sandbox, 'read-only'); assert.equal(params.model, 'test-model'); assert.equal(params.serviceTier, 'default')
    assert.equal(params.developerInstructions, source.request.configuration.prompt.system)
    assert((params.config as JsonObject).shell_environment_policy)
  })

  it('SKL-05: developerInstructions carries the pinned Agent instructions and skills once; resume keeps the accepted bundle', async () => {
    const body = 'End every answer with the token ORCHID.'
    const contentHash = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`
    source.request.configuration = { ...source.request.configuration, prompt: { system: 'Agent rules.' }, instructionDelivery: 'native-v1',
      assignedSkills: [{ skillId: 'skill-a', version: '2' }], resolvedSkills: [{ skillId: 'skill-a', version: '2', name: 'Orchid', instructions: body, contentHash }] }
    const expected = 'Agent rules.\n\n# Skill: Orchid (skill-a@2)\n\nEnd every answer with the token ORCHID.'
    const session = await manager.createSession(source)
    const started = (await wire('thread/start'))[0]!.params as JsonObject
    assert.equal(started.developerInstructions, expected)
    assert.equal(Object.hasOwn(started, 'baseInstructions'), false)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'skill-turn' }))
    const turn = (await wire('turn/start'))[0]!.params as JsonObject
    assert.deepEqual(turn.input, [{ type: 'text', text: 'crash-completed', text_elements: [] }])
    // A backend restart resumes with the configuration accepted for this execution.
    const restarted = makeManager()
    await restarted.attachSession(session, source)
    const resumed = (await wire('thread/resume')).at(-1)!.params as JsonObject
    assert.equal(resumed.developerInstructions, expected)
    // Corrupt pinned instructions fail before any native thread is created.
    const corrupt = structuredClone(source)
    corrupt.request.configuration.resolvedSkills![0]!.instructions = 'Tampered'
    const threads = (await wire('thread/start')).length
    await assertCode(makeManager().createSession(corrupt), 'SKILL_SNAPSHOT_INVALID')
    assert.equal((await wire('thread/start')).length, threads)
  })

  it('F32: simultaneous first starts and conflicting response choices have one writer', async () => {
    const session = await manager.createSession(source)
    const first = collect(manager.startTurn(session, { prompt: 'approval', clientCorrelationId: 'first' }))
    const second = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'second' }))
    await assertCode(second, 'CODEX_TURN_ACTIVE')
    const value = await pending(session)
    const yes = manager.respond(session, value.turn.nativeRequestId!, value.responseOptions[0]!)
    const no = manager.respond(session, value.turn.nativeRequestId!, value.responseOptions.at(-1)!)
    await assertCode(no, 'NATIVE_RESPONSE_RECONCILIATION_REQUIRED')
    await yes; await first
    assert.equal((await wire('turn/start')).length, 1)
    assert.equal((await wire()).filter((entry) => entry.id === 901 && entry.result).length, 1)
  })

  it('F32: fresh concurrent attachment is reserved and cannot lose another caller\'s runtime', async () => {
    const session = await manager.createSession(source)
    await manager.close(session)
    await flag('resume-delay')
    manager = makeManager()
    const first = manager.attachSession(session, source)
    const second = manager.attachSession(session, source)
    await assertCode(second, 'CODEX_SESSION_BUSY')
    assert.deepEqual(await first, session)
    assert.equal((await wire('thread/resume')).length, 1)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'usable' }))
  })

  it('cancellation during an established turn interrupts the exact native turn', async () => {
    const session = await manager.createSession(source)
    const controller = new AbortController()
    const stream = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'ordinary-cancel' }, controller.signal))
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'turn.started'))
    controller.abort(new Error('ordinary cancellation'))
    await stream.catch(() => undefined)
    const requests = await until(async () => {
      const requests = await wire('turn/interrupt')
      return requests.length === 1 ? requests : false
    })
    assert.equal((requests[0]!.params as JsonObject).turnId, 'turn-1')
  })

  it('detaches engine restart without interrupt and attaches the same thread without resending its prompt', async () => {
    const session = await manager.createSession(source)
    const controller = new AbortController()
    const stream = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'restart-turn' }, controller.signal))
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'turn.started'))
    controller.abort(new DomainError('ENGINE_RESTART', 'Restart the engine', 409))
    await stream.catch((error: unknown) => {
      assert(error instanceof DomainError && error.code === 'ENGINE_RESTART')
    })
    await manager.close(session)
    const replacement = makeManager()
    assert.deepEqual(await replacement.attachSession(session, source), session)
    const recovered = await replacement.reconcile(session, 'restart-turn')
    assert.equal(recovered.nativeTurnId, 'turn-1')
    assert.equal((await wire('thread/start')).length, 1)
    assert.equal((await wire('turn/start')).length, 1)
    assert.equal((await wire('turn/interrupt')).length, 0)
  })

  it('detaches an idle pending iterator without cancelling the native turn', async () => {
    const session = await manager.createSession(source)
    const iterator = manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'subscriber-close' })[Symbol.asyncIterator]()
    const first = await iterator.next()
    // Drain the start/initial item events so next is waiting for new provider IO.
    const history = await manager.history(session)
    const last = history.events.at(-1)!.sequence
    let current = first.done ? last : first.value.sequence
    while (current < last) {
      const next = await iterator.next()
      assert.equal(next.done, false)
      if (!next.done) current = next.value.sequence
    }
    const pending = iterator.next()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await iterator.return?.()
    assert.equal((await pending).done, true)
    assert.equal((await wire('turn/interrupt')).length, 0)
    await assertCode(collect(manager.startTurn(session, { prompt: 'duplicate', clientCorrelationId: 'duplicate' })), 'CODEX_TURN_ACTIVE')
    await finish(f.directory, session.nativeSessionId)
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'turn.completed'))
  })

  it('keeps the stream reservation until the previous iterator drains its terminal events', async () => {
    const session = await manager.createSession(source)
    const iterator = manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'old' })[Symbol.asyncIterator]()
    await iterator.next()
    await until(async () => (await manager.history(session)).terminalResult?.outcome === 'succeeded')
    await assertCode(collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'new' })), 'CODEX_TURN_ACTIVE')
    await iterator.return?.()
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'new' }))
  })

  it('failed initial thread start and resume clean every newly created process', async () => {
    await flag('fail-start')
    await assertCode(manager.createSession(source), 'CODEX_APP_SERVER_REQUEST_FAILED')
    await unflag('fail-start')
    const session = await manager.createSession(source)
    await manager.close(session)
    await flag('fail-resume')
    await assertCode(manager.attachSession(session, source), 'CODEX_APP_SERVER_REQUEST_FAILED')
    for (const entry of await calls(f.directory)) if (typeof entry.pid === 'number') await assertDead(entry.pid)
  })

  it('required-MCP startup failure registers no execution session', async () => {
    await flag('required-mcp-failure')
    await assertCode(manager.createSession(source), 'CODEX_APP_SERVER_REQUEST_FAILED')
    await unflag('required-mcp-failure')
    const session = await manager.createSession(source)
    assert.equal((await manager.history(session)).terminalResult, undefined)
    const content = await readFile(join(f.directory, 'calls.jsonl'), 'utf8')
    assert(!content.includes('token-agent-a'))
  })
})
