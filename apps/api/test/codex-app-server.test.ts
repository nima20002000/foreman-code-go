import { appLauncherConnection } from '../src/modules/harnesses/appMcpLauncher.js'
import { nativeConnection } from '../src/modules/harnesses/nativeMcpCommon.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { CodexHarnessConfiguration, NativeSessionReference, PendingNativeInteraction } from '@graphql/contracts'
import { canonicalGraphJson } from '@graphql/contracts/wave25'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'

import type { NativeResponseAvailabilityQuery } from '../src/modules/harnesses/responseAvailability.js'
import { DomainError } from '../src/modules/errors.js'
import { assertOriginalWorkflowTerminal } from '../src/modules/interactions/workflowTerminalSource.js'
import type { WorkflowNativeSessionStart } from '../src/modules/harnesses/port.js'
import type { JsonObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { isObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { codexResponseSurfaceFixtures } from './fixtures/codex-response-surfaces.js'
import { calls, collect, emit, errorCode, finish, fixture, fixtureQualification, input, state, until, type Fixture } from './fixtures/codex-test-helpers.js'

// Only qualification is replaced here. Every lifecycle/translation/transport path
// below runs the repository implementation. The real schema gate has its own tests.
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
  await emit(f.directory, { id, method, params: { threadId: session.nativeSessionId, turnId: current.turns.at(-1)!.id, ...extra } })
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

// Executable fixtures use a POSIX shebang. Pure protocol tests cover portable shapes.
describe.skipIf(process.platform === 'win32')('Codex app-server regressions against the real manager', () => {
  beforeEach(async () => { f = await fixture(); manager = makeManager(); source = input(f.directory) })
  afterEach(async () => {
    const results = await Promise.allSettled(managers.splice(0).map((value) => value.shutdown()))
    await rm(f.directory, { recursive: true, force: true })
    const failure = results.find((value) => value.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
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
    const launched = (await calls(f.directory)).find((entry) => typeof entry.pid === 'number')
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
    const launched = (await calls(f.directory)).find((entry) => typeof entry.pid === 'number')
    assert(launched && typeof launched.pid === 'number')
    process.kill(launched.pid, 'SIGTERM')
    await assert.rejects(read)
    assert.equal(manager.originalSessionLifetime(session, source), undefined)
    assert.throws(lifetime.assertCurrent)
    assert.equal((await wire('thread/resume')).length, 0)
  })

  it('recognizes the managed worker launcher and permits only its scoped execution credential', async () => {
    const entry = nativeConnection('codex', appLauncherConnection())
    await json('mcp.json', { enabled: true, transport: { ...entry, type: 'stdio' } })
    const inspected = await manager.inspectMcpConfiguration(f.directory)
    assert.equal(inspected.configured.automaticEndpoint, true)
    assert.equal(inspected.configured.bearerTokenEnvironmentVariable, 'GRAPHQL_MCP_TOKEN')
    assert.equal((await manager.inspectMcp()).endpointMatches, true)
    const session = await manager.createSession(source)
    assert.equal(session.harness, 'codex')
    assert(session.nativeSessionId)
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

  it('F05: foreign, old-turn and malformed notifications cannot clear approval or replace the answer', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'old' }))
    const { result } = await start(session, 'approval', 'new')
    const interaction = await pending(session)
    const current = (await state(f.directory, session.nativeSessionId)).turns.at(-1)!
    await emit(f.directory, { method: 'turn/completed', params: { threadId: 'foreign', turn: { ...current, status: 'completed' } } })
    await emit(f.directory, { method: 'item/completed', params: { threadId: session.nativeSessionId, turnId: 'turn-1', item: { id: 'stale', type: 'agentMessage', phase: 'final_answer', text: 'WRONG' } } })
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

  it('F06/F12: uncertain start is reconciled by its own correlation, without replay', async () => {
    const session = await manager.createSession(source)
    await assert.rejects(collect(manager.startTurn(session, { prompt: 'lost-start', clientCorrelationId: 'lost' })))
    await assertCode(manager.reconcile(session, 'wrong-correlation'), 'CODEX_CORRELATION_MISMATCH')
    await assertCode(collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'unsafe-retry' })), 'CODEX_TURN_ACTIVE')
    const history = await manager.reconcile(session, 'lost')
    assert.deepEqual(history.terminalResult?.output, { text: 'recovered-answer' })
    assert.equal((await wire('turn/start')).length, 1)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'next' }))
  })

  it('F07: failed restart cleans the candidate process and retains the original session', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'recover' }))
    await flag('fail-resume')
    await assertCode(manager.reconcile(session, 'recover'), 'CODEX_APP_SERVER_REQUEST_FAILED')
    const pids = (await calls(f.directory)).flatMap((entry) => typeof entry.pid === 'number' ? [entry.pid] : [])
    assert.equal(pids.length, 2)
    await assertDead(pids[1]!)
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

  it('F14: retention is bounded with monotonic cursors, without truncating a delivered large event', async () => {
    const session = await manager.createSession(source)
    const large = 'x'.repeat(1_100_000)
    await emit(f.directory, { method: 'test/notification', params: { threadId: session.nativeSessionId, large } })
    await until(async () => (await manager.history(session)).events.some((event) => event.payload.large === large))
    const batch = Array.from({ length: 1_100 }, (_, value) => JSON.stringify({ method: 'test/notification', params: { threadId: session.nativeSessionId, value } })).join('\n') + '\n'
    await appendFile(join(f.directory, 'inbox-agent-a.jsonl'), batch)
    await until(async () => (await manager.history(session)).events.some((event) => event.payload.value === 1099))
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
    const launched = (await calls(f.directory)).find((entry) => typeof entry.pid === 'number')
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

  it('F19: generic tool input is explicitly unsupported, never invented as permission grants', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    await inject(session, 'item/tool/requestUserInput', { itemId: 'tool', isBlocking: true, autoResolutionMs: null, questions: [{
      id: 'generic', header: 'Question', question: 'Choose', isOther: false, isSecret: false,
      options: ['Decline', 'Cancel'].map((label) => ({ label, description: '' })),
    }] })
    await until(async () => (await wire()).some((message) => message.id === 4000 && isObject(message.error)))
    assert.equal(await manager.pending(session), undefined)
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

  it('F20/F21: data-entry and standalone elicitations are explicitly rejected, never attached to an old turn', async () => {
    const session = await manager.createSession(source)
    for (const afterTurn of [false, true]) {
      if (afterTurn) await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'old' }))
      const id = afterTurn ? 4001 : 4000
      await emit(f.directory, { id, method: 'mcpServer/elicitation/request', params: { threadId: session.nativeSessionId, turnId: null,
        mode: 'url', url: 'https://example.invalid/', elicitationId: 'standalone', serverName: 'app', message: 'Authorize', _meta: null } })
      await until(async () => (await wire()).some((entry) => entry.id === id && isObject(entry.error)))
      assert.equal(await manager.pending(session), undefined)
    }
    const { result } = await start(session)
    await inject(session, 'mcpServer/elicitation/request', { mode: 'form', serverName: 'app', message: 'Enter email', _meta: null,
      requestedSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] } }, 4002)
    await until(async () => (await wire()).some((entry) => entry.id === 4002 && isObject(entry.error)))
    assert.equal(await manager.pending(session), undefined)
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
      permissions: ['item/permissions/requestApproval', { itemId: 'permission', permissions: {} }],
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

  it('F27: rechecks version and authentication for later sessions and replacements', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'recover' }))
    await json('version.json', 'codex-cli 0.155.0')
    await assertCode(manager.createSession(input(f.directory, 'agent-b')), 'CODEX_APP_SERVER_VERSION_UNQUALIFIED')
    await assertCode(manager.reconcile(session, 'recover'), 'CODEX_APP_SERVER_VERSION_UNQUALIFIED')
    await unflag('version.json'); await flag('logged-out')
    await assertCode(manager.createSession(input(f.directory, 'agent-b')), 'CODEX_APP_SERVER_AUTH_UNQUALIFIED')
    await assertCode(manager.reconcile(session, 'recover'), 'CODEX_APP_SERVER_AUTH_UNQUALIFIED')
    await unflag('logged-out')
    await manager.reconcile(session, 'recover')
  })

  it('does not resume a saved thread across two separately qualified Codex releases', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'recover' }))
    await json('version.json', 'codex-cli 0.156.1')
    await assertCode(manager.reconcile(session, 'recover'), 'CODEX_SESSION_VERSION_MISMATCH')
    assert.equal((await wire('thread/resume')).length, 0)
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
