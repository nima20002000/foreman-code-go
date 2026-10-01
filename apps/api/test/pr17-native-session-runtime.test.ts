import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'vitest'
import type { ApprovalResponseOption, CodexHarnessConfiguration, NativeSessionReference } from '@graphql/contracts'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { CodexStdioTransport } from '../src/modules/harnesses/codexStdioTransport.js'
import { normalizedHistory } from '../src/modules/harnesses/opencodeProtocol.js'
import type { NativeSessionStart } from '../src/modules/harnesses/port.js'
import { bounded, openCodeFixture, session as openCodeSession, start } from './fixtures/pr17-native-runtime.js'
import { fixtureProtocol } from './fixtures/codex-test-helpers.js'

function nativeCode(code: string) {
  return (error: unknown) => error instanceof HarnessExecutionError && error.result.error?.code === code
}

type Runtime = ReturnType<CodexAppServerSessionManager['requireRuntime']>
type Waiting = Runtime['interactions'] extends Map<string, infer T> ? T : never
const codexSession: NativeSessionReference = { harness: 'codex', providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'thread-test' }
const option: ApprovalResponseOption = {
  optionId: 'accept', semantic: 'approve_once', label: 'Approve', persistence: 'request',
  affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false,
}
function codexFixture() {
  let responses = 0
  const transport = {
    request: async () => ({ turn: { id: 'turn-test', status: 'inProgress', items: [] } }),
    respond: async () => { responses += 1 },
    close: async () => undefined,
  } as unknown as CodexStdioTransport
  const runtime: Runtime = {
    connectionId: randomUUID(), schemaIdentity: 'fixture-schema', arrivalOrdinal: 0, attached: false, binding: '', ownerId: 'agent', configurationIdentity: '',
    input: {} as NativeSessionStart, workingDirectory: '/workspace',
    configuration: { serviceTier: 'standard' } as CodexHarnessConfiguration,
    scopedCredentialVariable: undefined, strippedCredentialVariable: undefined, transport, session: codexSession, generation: 0,
    qualified: { binary: 'fixture-only', identity: 'fixture-identity', providerVersion: codexSession.providerVersion,
      protocol: fixtureProtocol, schemaManifestSha256: 'fixture-schema', stableSchemaGitBlob: 'fixture-stable', referenceSchemaManifestSha256: 'fixture-reference' },
    phase: 'idle', streamActive: false, starting: undefined, cancellation: undefined,
    files: undefined, fileCleanup: undefined, fileRequests: new Map(),
    activeTurnId: undefined, activeCorrelationId: undefined, terminalResult: undefined,
    finalAnswer: undefined, lastAgentMessage: undefined, finalAnswerId: undefined, lastAgentMessageId: undefined,
    interactions: new Map(), resolvedRequests: new Map(), events: [], eventSizes: [], eventBytes: 0, sequence: 0,
    seenNotifications: new Set(), wake: new Set(), closed: false, disposed: false,
  }
  const manager = new CodexAppServerSessionManager('fixture-only', codexSession.providerVersion)
  const seam = manager as unknown as {
    runtimes: Map<string, Runtime>
    record(runtime: Runtime, type: string, payload: Record<string, unknown>): void
    loginControl: { transport: CodexStdioTransport } | undefined
  }
  seam.runtimes.set(codexSession.nativeSessionId, runtime)
  return { manager, runtime, seam, responses: () => responses }
}
function waiting(id: string, delivery: Waiting['delivery']): Waiting {
  return {
    pending: { session: codexSession, turn: { nativeTurnId: 'turn-test', nativeRequestId: id },
      nativeRequestType: 'item/commandExecution/requestApproval', request: {}, responseOptions: [option] },
    requestId: id, method: 'item/commandExecution/requestApproval', generation: 0, signature: id,
    responses: new Map([[option.optionId, { option, nativeResponse: { decision: 'accept' } }]]),
    delivery, resolution: new Promise(() => undefined), resolve: () => undefined,
  }
}

describe('PR17 native session runtime regressions', () => {
  it('F9: exposes a later pending approval without mutating or replaying an earlier uncertain response', async () => {
    const { manager, runtime, responses } = codexFixture()
    const first = waiting('first', 'uncertain')
    const second = waiting('second', 'pending')
    runtime.interactions.set('first', first)
    runtime.interactions.set('second', second)
    assert.equal((await manager.pending(codexSession))?.turn.nativeRequestId, 'second')
    const history = await manager.history(codexSession)
    assert.equal(history.pendingInteraction?.turn.nativeRequestId, 'second')
    assert.deepEqual(history.interactionDeliveries?.map((entry) => entry.state), ['uncertain', 'pending'])
    await assert.rejects(manager.respond(codexSession, 'first', option), nativeCode('NATIVE_RESPONSE_RECONCILIATION_REQUIRED'))
    assert.equal(first.delivery, 'uncertain')
    assert.equal(runtime.interactions.get('first'), first)
    assert.equal(responses(), 0)
  })

  for (const terminal of [false, true]) it(`F16: drains an event queued while suspended at yield (terminal=${terminal})`, async () => {
    const { manager, runtime, seam } = codexFixture()
    const controller = new AbortController()
    const iterator = manager.startTurn(codexSession, { prompt: 'test', clientCorrelationId: 'correlation' }, controller.signal)[Symbol.asyncIterator]()
    let next: ReturnType<typeof iterator.next> | undefined
    try {
      assert.equal((await iterator.next()).value?.type, 'turn.started')
      if (terminal) runtime.terminalResult = { outcome: 'succeeded', output: { text: '' } }
      seam.record(runtime, terminal ? 'turn.completed' : 'event.B', { marker: 'B' })
      next = iterator.next()
      const result = await bounded(next)
      assert.equal(result.done, false)
      assert.equal(result.value?.payload.marker, 'B')
      assert.equal(runtime.wake.size, 0)
    } finally {
      controller.abort()
      await next?.catch(() => undefined)
      await iterator.return?.()
    }
  })

  it('F14: retries transport cleanup, coalesces in-flight calls and keeps native requests fenced', async () => {
    let calls = 0
    let reject!: (error: Error) => void
    const transport = new CodexStdioTransport('fixture', '/workspace', {}, {
      request: () => undefined, notification: () => undefined, serverRequest: () => undefined,
      response: () => undefined, serverResponse: () => undefined,
    }, async () => undefined, () => undefined, () => undefined)
    Object.assign(transport, { owned: { child: { stdin: { destroyed: false } }, close: () => {
      calls += 1
      return calls === 1 ? new Promise<void>((_resolve, fail) => { reject = fail }) : Promise.resolve()
    } } })
    const first = transport.close()
    assert.equal(transport.close(), first)
    const failure = assert.rejects(first, /fixture cleanup failure/)
    reject(new Error('fixture cleanup failure'))
    await failure
    await assert.rejects(transport.request('turn/start', {}), nativeCode('CODEX_APP_SERVER_DISCONNECTED'))
    const second = transport.close()
    assert.notEqual(second, first)
    await second
    assert.equal(calls, 2)
    assert.equal(transport.close(), second)
    await assert.rejects(transport.start(), nativeCode('CODEX_TRANSPORT_REUSED'))
  })

  it('F14: retains a failed Codex login cleanup and prevents reattaching a disposed runtime', async () => {
    const { manager, runtime, seam } = codexFixture()
    let calls = 0
    const control = { transport: { close: async () => { if (++calls === 1) throw new Error('cleanup') } } as unknown as CodexStdioTransport }
    seam.loginControl = control
    await assert.rejects(manager.closeLoginControl(), /cleanup/)
    assert.equal(seam.loginControl, control)
    await manager.closeLoginControl()
    assert.equal(calls, 2)
    assert.equal(seam.loginControl, undefined)
    runtime.closed = true
    runtime.disposed = true
    await assert.rejects(manager.attachSession(codexSession, {} as NativeSessionStart), nativeCode('CODEX_SESSION_UNAVAILABLE'))
  })

  it('F10: returns the exact session ID when abort fires after the successful native POST response', async () => {
    const { manager, controller, seam, posts } = openCodeFixture()
    const abort = new AbortController()
    const request = controller.request
    controller.request = async (...args) => {
      const response = await request(...args)
      // Native creation succeeded; no unread/incomplete response is simulated.
      abort.abort(new Error('late abort'))
      return response
    }
    const session = await manager.createSession(start, abort.signal)
    assert.deepEqual(session, openCodeSession)
    assert.ok(seam.sessions.has(session.nativeSessionId))
    assert.equal(posts(), 1)
    await manager.close(session)
    assert.equal(posts(), 1)
  })

  it('F1: attaches with a fresh local counter/identity while authoritative history stays stable', async () => {
    const first = openCodeFixture()
    const session = await first.manager.createSession(start)
    const oldState = first.seam.sessions.get(session.nativeSessionId)!
    const a = first.seam.recordSynthetic(oldState, 'native.output', { text: 'before' })
    const b = first.seam.recordSynthetic(oldState, 'interaction.pending', { nativeRequestId: 'permission' })
    const second = openCodeFixture()
    await second.manager.attachSession(session, start)
    const newState = second.seam.sessions.get(session.nativeSessionId)!
    const c = second.seam.recordSynthetic(newState, 'native.output', { text: 'after' })
    assert.equal(a.sequence, 0)
    assert.equal(b.sequence, 1)
    assert.equal(c.sequence, 0)
    assert.ok(a.connectionId)
    assert.equal(a.connectionId, b.connectionId)
    assert.notEqual(a.connectionId, c.connectionId)
    const messages = [{ info: { id: 'message', sessionID: session.nativeSessionId, role: 'user', time: { created: 1 } }, parts: [] }]
    assert.deepEqual(normalizedHistory(messages, false), normalizedHistory(structuredClone(messages), false))
    const authoritative = normalizedHistory(messages, false)
    Object.assign(second.manager, {
      message: async () => messages[0],
      reconcileReady: async () => ({ events: authoritative, pendingInteractions: [], terminalResult: { outcome: 'succeeded' } }),
    })
    const iterator = second.manager.observeTurn(session, 'durable-correlation')[Symbol.asyncIterator]()
    try { assert.deepEqual((await iterator.next()).value, authoritative[0]) }
    finally { await iterator.return?.() }
  })

  it('F14: retains OpenCode session and credential ownership across failed close/dispose attempts', async () => {
    const { manager, controller, seam } = openCodeFixture()
    const session = await manager.createSession(start)
    seam.knownSecrets.add('fixture-secret')
    seam.boundEnvironmentFingerprint = 'owned-context'
    let calls = 0
    controller.dispose = async () => { if (++calls < 3) throw new Error('cleanup unconfirmed') }
    await assert.rejects(manager.close(session), /cleanup unconfirmed/)
    assert.ok(seam.sessions.has(session.nativeSessionId))
    assert.equal(seam.boundEnvironmentFingerprint, 'owned-context')
    const first = manager.dispose()
    assert.equal(manager.dispose(), first)
    await assert.rejects(first, /cleanup unconfirmed/)
    assert.ok(seam.sessions.has(session.nativeSessionId))
    assert.ok(seam.knownSecrets.has('fixture-secret'))
    await manager.dispose()
    assert.equal(calls, 3)
    assert.equal(seam.sessions.size, 0)
    assert.equal(seam.knownSecrets.size, 0)
    await manager.dispose()
    assert.equal(calls, 3)
  })
})
