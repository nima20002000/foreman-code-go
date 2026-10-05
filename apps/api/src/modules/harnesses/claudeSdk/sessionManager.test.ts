import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionPreferencesSchema } from '@foreman-code/contracts'
import { describe, expect, it, vi } from 'vitest'
import type { NativeSessionStart } from '../port.js'
import { ClaudeBoundedQueue } from './queue.js'
import { createClaudeSdkRunner } from './runner.js'
import { claudePromptUuid, createClaudeNativeSessionManager, type ClaudeMessageTurnInput } from './sessionManager.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from './port.js'

const scope = { deviceId: 'device-a', profilePath: '/profile-a', configRevision: 'revision-a', cwd: '/work' }
const qualification = { sdkVersion: '0.3.284', cliVersion: '2.1.284', basicTurns: true, resume: true, fork: true, history: true }
const start = { kind: 'operator', correlationId: 'operator:one', configuration: {}, workingDirectory: '/work' } as NativeSessionStart
function fixture(decodeFactory?: Parameters<typeof createClaudeNativeSessionManager>[0]['decodeFactory'], extra: Partial<Pick<Parameters<typeof createClaudeNativeSessionManager>[0], 'liveCallbacks' | 'interactionPort' | 'qualification' | 'pendingInteractions' | 'inspectionStart' | 'expectedMcp' | 'credentialEnvironmentVariables' | 'appMcpAccess' | 'sdkOptions' | 'initializationTimeoutMs' | 'scope'>> = {}) {
  const frames = new ClaudeBoundedQueue<unknown>(32)
  let messages: AsyncIterator<ClaudeSdkUserMessage>
  let ready!: () => void
  const started = new Promise<void>((resolve) => { ready = resolve })
  const close = vi.fn(() => frames.close())
  const statuses = vi.fn(async () => [{ name: 'graphql', status: 'connected', source: 'dynamic', config: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app', headers: { Authorization: 'secret-token' } }, tools: [{ name: 'interaction_get' }] }])
  const queries = vi.fn()
  const interrupt = vi.fn(async () => ({ still_queued: [] }))
  const setServers = vi.fn(async (servers: Readonly<Record<string, unknown>>) => { void servers; return { added: ['graphql'], removed: [], errors: {} } })
  const client: ClaudeSdkClient = {
    sdkVersion: '0.3.284', query: (input) => {
      queries(input)
      messages = input.prompt[Symbol.asyncIterator](); ready()
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), interrupt, initializationResult: async () => ({ models: [], account: {} }), mcpServerStatus: statuses, setMcpServers: setServers, close }
    }, getSessionInfo: async (sessionId) => ({ sessionId }), getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'fork' }),
  }
  const runner = createClaudeSdkRunner({ loadClient: async () => client })
  const offers = vi.fn()
  const open = runner.open
  runner.open = async (input) => {
    const session = await open(input)
    const offer = session.offer
    session.offer = (message, signal) => { offers(message); return offer(message, signal) }
    return session
  }
  const manager = createClaudeNativeSessionManager({ runner, scope, sdkOptions: {}, qualification, ...extra, ...(decodeFactory ? { decodeFactory } : {}) })
  return { frames, close, interrupt, manager, runner, client, statuses, queries, setServers, offers, nextMessage: async () => {
    await started
    const value = (await messages.next()).value
    if (value) void frames.offer({ type: 'system', subtype: 'init', session_id: 'native-session', claude_code_version: '2.1.284', cwd: '/work' })
    return value!
  } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function drain<T>(input: AsyncIterable<T>) { const values: T[] = []; for await (const value of input) values.push(value); return values }

describe('Claude native session manager admission', () => {
  it.each(['DATABASE_URL', 'TEST_DATABASE_URL', 'PGPASSWORD', 'GRAPHQL_PRODUCTION_DB_PASSWORD',
    'FOREMAN_CODE_PRODUCTION_DB_PASSWORD'])(
    'rejects scoped %s before SDK inspection or resume', async key => {
      const selected = { ...start, environment: { agentId: 'operator', variables: { [key]: 'test-only-credential' } } }
      for (const operation of ['inspection', 'resume']) {
        const f = fixture()
        try {
          const opening = operation === 'inspection' ? f.manager.prepareInspection(selected)
            : f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
              nativeSessionId: 'native-session' }, selected)
          await expect(opening).rejects.toMatchObject({ result: {
            outcome: 'failed', error: { code: 'CLAUDE_ENVIRONMENT_INVALID', retryable: false },
          } })
          expect(f.queries).not.toHaveBeenCalled()
          expect(f.offers).not.toHaveBeenCalled()
          const session = { harness: 'claude' as const, providerVersion: '2.1.284', nativeSessionId: 'native-session' }
          expect(await f.manager.attachSession(session, start)).toEqual(session)
          expect(f.queries).toHaveBeenCalledOnce()
          expect(f.offers).not.toHaveBeenCalled()
        } finally { await f.manager.dispose?.() }
      }
    },
  )

  it('freezes the accepted terminal message identity while persistence is retried after delayed replies', async () => {
    const f = fixture()
    try {
      const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
        nativeSessionId: 'native-session' }, start)
      const saved = vi.fn<NonNullable<ClaudeMessageTurnInput['onTerminal']>>(async () => {
        throw new Error('Terminal save interrupted')
      })
      const output = drain(f.manager.startTurn(session, { prompt: 'first', clientCorrelationId: 'frozen-result',
        onTerminal: saved }))
      const failure = expect(output).rejects.toThrow('Terminal save interrupted')
      const message = await f.nextMessage()
      await f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'accepted-answer',
        user_message_uuid: message.uuid, message: { id: 'accepted-message' } })
      await f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'accepted-result',
        user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'accepted output' })
      await failure
      await f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'delayed-answer',
        user_message_uuid: message.uuid, message: { id: 'delayed-message' } })
      await new Promise<void>(resolve => setImmediate(resolve))
      const recovered = await f.manager.reconcile(session, 'frozen-result')
      expect(recovered.nativeMessageId).toBe('accepted-message')
      expect(recovered.terminalResult).toEqual(saved.mock.calls[0]![0].result)
      expect(saved).toHaveBeenCalledTimes(1)
    } finally { await f.manager.dispose?.() }
  })

  it('keeps factory allocation I/O-free and blocks unqualified capabilities before native effects', async () => {
    const runner = { open: vi.fn(), history: vi.fn(), fork: vi.fn(), dispose: vi.fn(async () => undefined) }
    const manager = createClaudeNativeSessionManager({ runner, scope, sdkOptions: {}, qualification: { ...qualification, basicTurns: false } })
    expect(runner.open).not.toHaveBeenCalled()
    await expect(manager.createSession(start)).rejects.toThrow('atomic initial-turn')
    expect(() => manager.startInitialTurn(start, { prompt: 'first', clientCorrelationId: 'operator:one', onSessionObserved: async () => undefined })).toThrow('not been qualified')
    expect((await manager.capabilities()).cancellation).toBe(false)
    expect(manager.steerTurn).toBeUndefined()
    await manager.dispose?.()
  })
  it('persists exact echoed native message receipt before submitted events, then reuses the session', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const submit = vi.fn(async () => undefined)
    const turn: ClaudeMessageTurnInput = { prompt: 'first', clientCorrelationId: 'request-1', onMessageSubmitted: submit }
    const output = drain(f.manager.startTurn(session, turn))
    const first = await f.nextMessage()
    expect(submit).not.toHaveBeenCalled()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'assistant-1', user_message_uuid: first.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-1', user_message_uuid: first.uuid, subtype: 'success', is_error: false, result: 'done' })
    const events = await output
    expect(submit).toHaveBeenCalledWith({ kind: 'message', nativeSessionId: 'native-session', nativeMessageId: first.uuid, clientCorrelationId: 'request-1' })
    expect(events.map((event) => event.type)).toEqual(['message.submitted', 'turn.completed'])
    const history = await f.manager.reconcile(session, 'request-1')
    expect(history.nativeTurnId).toBeUndefined()
    expect(history.nativeMessageId).toBe('assistant-1')
    expect(history.terminalTurn?.providerId).toBe(first.uuid)
    expect(f.close).not.toHaveBeenCalled()
    const second = drain(f.manager.startTurn(session, { prompt: 'second', clientCorrelationId: 'request-2' }))
    const secondMessage = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply-2', user_message_uuid: secondMessage.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-2', user_message_uuid: secondMessage.uuid, subtype: 'success', is_error: false, result: 'again' })
    await second
    expect((await f.manager.reconcile(session, 'request-2')).terminalResult?.output).toBe('again')
    await f.manager.close(session); await f.manager.close(session); await f.manager.dispose?.()
  })
  it.each(['settings persistence', 'mode control'])(
    'reports %s failure before offer as definite and accepts a later task', async stage => {
      const f = fixture()
      const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
        nativeSessionId: 'native-session' }, start)
      const input: ClaudeMessageTurnInput = { prompt: 'unoffered task', clientCorrelationId: 'before-offer',
        ...(stage === 'mode control' ? { sessionMode: 'plan' } : {}),
        onSettingsApplied: async () => { if (stage === 'settings persistence') throw new Error('Storage failed') },
      }
      await expect(drain(f.manager.startTurn(session, input))).rejects.toMatchObject({
        certainty: 'definite', deliveryState: 'not-delivered',
      })
      expect(f.offers).not.toHaveBeenCalled()
      const output = drain(f.manager.startTurn(session, { prompt: 'next task', clientCorrelationId: 'next-offer',
        sessionPreferences: SessionPreferencesSchema.parse({}) }))
      const message = await f.nextMessage()
      f.frames.offer({ type: 'result', session_id: session.nativeSessionId, user_message_uuid: message.uuid,
        subtype: 'success', is_error: false, result: 'done' })
      await output
      expect(f.offers).toHaveBeenCalledTimes(1)
      await f.manager.dispose?.()
    })

  it('recovers safe-resume failure before offer and accepts the next task on the saved session', async () => {
    const f = fixture()
    const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
      nativeSessionId: 'native-session' }, start)
    const open = f.runner.open.bind(f.runner)
    vi.spyOn(f.runner, 'open').mockRejectedValueOnce(new Error('Resume failed')).mockImplementation(open)
    await expect(drain(f.manager.startTurn(session, { prompt: 'unoffered', clientCorrelationId: 'resume-failure',
      sessionPreferences: SessionPreferencesSchema.parse({ autoCompact: 'off' }) }))).rejects.toMatchObject({
      certainty: 'definite', deliveryState: 'not-delivered',
    })
    expect(f.offers).not.toHaveBeenCalled()
    const frames = new ClaudeBoundedQueue<unknown>(8)
    let messages!: AsyncIterator<ClaudeSdkUserMessage>
    f.client.query = input => {
      messages = input.prompt[Symbol.asyncIterator]()
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), interrupt: async () => {},
        initializationResult: async () => ({ models: [], account: {} }), close: () => frames.close() }
    }
    const output = drain(f.manager.startTurn(session, { prompt: 'follow-up', clientCorrelationId: 'resume-follow-up',
      sessionPreferences: SessionPreferencesSchema.parse({}) }))
    await vi.waitFor(() => expect(messages).toBeDefined())
    const message = (await messages.next()).value!
    frames.offer({ type: 'result', session_id: session.nativeSessionId, user_message_uuid: message.uuid,
      subtype: 'success', is_error: false, result: 'done' })
    await output
    expect(f.offers).toHaveBeenCalledTimes(1)
    await f.manager.dispose?.()
  })

  it('interrupts only the exact active message and settles its aborted result as canceled', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    expect((await f.manager.capabilities()).cancellation).toBe(true)
    expect(await f.manager.cancel(session)).toBe(false)
    const output = drain(f.manager.startTurn(session, { prompt: 'long task', clientCorrelationId: 'request-stop' }))
    const message = await f.nextMessage()
    expect(await f.manager.cancel(session, undefined, message.uuid)).toBe(false) // Not yet natively echoed.
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply-stop', user_message_uuid: message.uuid })
    await vi.waitFor(async () => expect((await f.manager.reconcile(session, 'request-stop')).nativeSubmission).toBeDefined())
    expect(await f.manager.cancel(session, undefined, 'another-message')).toBe(false)
    expect(f.interrupt).not.toHaveBeenCalled()
    expect(await f.manager.cancel(session, undefined, message.uuid)).toBe(true)
    expect(await f.manager.cancel(session, undefined, message.uuid)).toBe(true)
    expect(f.interrupt).toHaveBeenCalledTimes(1)
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-stop', user_message_uuid: message.uuid, subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', errors: [] })
    expect((await output).at(-1)?.type).toBe('turn.completed')
    const history = await f.manager.reconcile(session, 'request-stop')
    expect(history.terminalResult).toEqual({ outcome: 'canceled' })
    expect(history.terminalTurn?.providerId).toBe(message.uuid)
    const next = drain(f.manager.startTurn(session, { prompt: 'next', clientCorrelationId: 'request-next' }))
    const nextMessage = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply-next', user_message_uuid: nextMessage.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-next', user_message_uuid: nextMessage.uuid, subtype: 'success', is_error: false, result: 'ok' })
    await next
    expect((await f.manager.reconcile(session, 'request-next')).terminalResult).toEqual({ outcome: 'succeeded', output: 'ok' })
    await f.manager.dispose?.()
  })
  it('keeps a success that raced the interrupt succeeded', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const output = drain(f.manager.startTurn(session, { prompt: 'quick', clientCorrelationId: 'request-race' }))
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply-race', user_message_uuid: message.uuid })
    await vi.waitFor(async () => expect((await f.manager.reconcile(session, 'request-race')).nativeSubmission).toBeDefined())
    expect(await f.manager.cancel(session, undefined, message.uuid)).toBe(true)
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-race', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'done first' })
    await output
    expect((await f.manager.reconcile(session, 'request-race')).terminalResult).toEqual({ outcome: 'succeeded', output: 'done first' })
    await f.manager.dispose?.()
  })
  it('does not correlate a queued native wake result with the new message', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const output = f.manager.startTurn(session, { prompt: 'new', clientCorrelationId: 'request-new' })[Symbol.asyncIterator]()
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'wake-result', subtype: 'success', is_error: false, result: 'wake' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await f.manager.reconcile(session, 'request-new')).terminalResult).toBeUndefined()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'new-reply', user_message_uuid: message.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'new-result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'new' })
    expect((await output.next()).value?.type).toBe('message.submitted')
    expect((await output.next()).value?.type).toBe('turn.completed')
    await f.manager.dispose?.()
  })
  it('never replays uncertain correlations, and result then throw preserves failure', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const result = drain(f.manager.startTurn(session, { prompt: 'one', clientCorrelationId: 'request-one' }))
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'failure-result', user_message_uuid: message.uuid, subtype: 'error_during_execution', is_error: true, errors: ['native refusal'] })
    f.frames.close(new Error('throw after result'))
    await result
    expect((await f.manager.reconcile(session, 'request-one')).terminalResult?.error?.message).toBe('native refusal')
    expect(() => f.manager.startTurn(session, { prompt: 'retry', clientCorrelationId: 'request-one' })).toThrow()
    await f.manager.dispose?.()
  })
  it('subscriber return and abort detach observation without closing accepted native work', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const abort = new AbortController()
    const subscriber = f.manager.startTurn(session, { prompt: 'one', clientCorrelationId: 'request-one' }, abort.signal)[Symbol.asyncIterator]()
    const message = await f.nextMessage()
    const read = subscriber.next()
    abort.abort(new Error('subscriber gone'))
    await expect(read).rejects.toThrow('subscriber gone')
    expect(f.close).not.toHaveBeenCalled()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply', user_message_uuid: message.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'done' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await f.manager.reconcile(session, 'request-one')).terminalResult?.output).toBe('done')
    await f.manager.dispose?.()
  })
  it('does not complete a parent result while unsupported native background work lives', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const result = drain(f.manager.startTurn(session, { prompt: 'one', clientCorrelationId: 'request-one' }))
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'system', subtype: 'task_started', session_id: session.nativeSessionId, task_id: 'background-native', is_backgrounded: true })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'parent-result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'parent' })
    await expect(result).rejects.toThrow('background work')
    expect((await f.manager.reconcile(session, 'request-one')).terminalResult).toBeUndefined()
    expect(f.close).toHaveBeenCalled()
    await f.manager.dispose?.()
  })

  it('retains result-only consumption as uncertain instead of attributing a wake result to the offered message', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const submit = vi.fn(async () => undefined)
    const subscriber = f.manager.startTurn(session, { prompt: 'new', clientCorrelationId: 'request-new', onMessageSubmitted: submit } as ClaudeMessageTurnInput)[Symbol.asyncIterator]()
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'wake-folded-result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'wake' })
    expect((await subscriber.next()).value?.type).toBe('message.submitted')
    expect((await subscriber.next()).value?.type).toBe('claude.result.unattributed')
    expect(submit).toHaveBeenCalledTimes(1)
    expect((await f.manager.reconcile(session, 'request-new')).terminalResult).toBeUndefined()
    expect(() => f.manager.startTurn(session, { prompt: 'again', clientCorrelationId: 'another-request' })).toThrow('still active or uncertain')
    await subscriber.return?.()
    await f.manager.dispose?.()
  })

  it('retains malformed or future result variants as uncertain', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const subscriber = f.manager.startTurn(session, { prompt: 'new', clientCorrelationId: 'request-new' })[Symbol.asyncIterator]()
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply', user_message_uuid: message.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'unknown-result', user_message_uuid: message.uuid, subtype: 'future_variant', is_error: false, result: 'unknown' })
    expect((await subscriber.next()).value?.type).toBe('message.submitted')
    expect((await subscriber.next()).value?.type).toBe('claude.result.unattributed')
    expect((await f.manager.reconcile(session, 'request-new')).terminalResult).toBeUndefined()
    await subscriber.return?.(); await f.manager.dispose?.()
  })

  it('stamps only proven root/child/tool correlations, retaining late A without assigning it to B', async () => {
    const f = fixture(() => (raw) => {
      const frame = raw as Record<string, unknown>
      if (frame.type === 'result' || frame.type === 'system') return []
      const message = frame.message as { id?: string }
      return [{ type: frame.tool_use_id ? 'claude.tool' : 'claude.text', payload: {
        nativeSessionId: frame.session_id, messageId: message?.id,
        ...(frame.parent_tool_use_id ? { parentToolUseId: frame.parent_tool_use_id } : {}),
        ...(frame.tool_use_id ? { toolUseId: frame.tool_use_id } : {}), text: frame.text,
      } }]
    })
    const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const a = drain(f.manager.startTurn(session, { prompt: 'A', clientCorrelationId: 'request-A' }))
    const messageA = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'frame-A', message: { id: 'api-A' }, user_message_uuid: messageA.uuid, tool_use_id: 'tool-A', text: 'A tool' })
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'frame-A-2', message: { id: 'api-A' }, text: 'A canonical block' })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-A', user_message_uuid: messageA.uuid, subtype: 'success', is_error: false, result: 'A done' })
    await a
    const b = drain(f.manager.startTurn(session, { prompt: 'B', clientCorrelationId: 'request-B' }))
    const messageB = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'frame-B', message: { id: 'api-B' }, user_message_uuid: messageB.uuid, text: 'B' })
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'child-A', parent_tool_use_id: 'tool-A', message: { id: 'child-api-A' }, text: 'late A child' })
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'unowned-child', parent_tool_use_id: 'unknown-tool', message: { id: 'unknown-child' }, text: 'unowned' })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-B', user_message_uuid: messageB.uuid, subtype: 'success', is_error: false, result: 'B done' })
    const eventsB = await b
    expect(eventsB.some((event) => event.payload.text === 'late A child' || event.payload.text === 'unowned')).toBe(false)
    const historyA = await f.manager.reconcile(session, 'request-A')
    expect(historyA.events.filter((event) => event.type.startsWith('claude.')).map((event) => event.payload.text)).toEqual(['A tool', 'A canonical block', 'late A child'])
    expect(historyA.events.every((event) => event.payload.clientCorrelationId === 'request-A')).toBe(true)
    await f.manager.dispose?.()
  })
  it.each(['tool_deferred', 'background_requested'])('does not settle native continuation reason %s as successful work', async (reason) => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const result = drain(f.manager.startTurn(session, { prompt: 'one', clientCorrelationId: 'request-one' }))
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply', message: { id: 'api-reply' }, user_message_uuid: message.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'deferred-result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'parent', terminal_reason: reason })
    await expect(result).rejects.toThrow('background work')
    expect((await f.manager.reconcile(session, 'request-one')).terminalResult).toBeUndefined()
    await f.manager.dispose?.()
  })
  it('recovers exact lost-ACK input identity from native history without replaying a prompt or inferring terminal outcome', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const expected = claudePromptUuid('request-lost-ack')
    f.client.getSessionMessages = vi.fn(async () => [
      { type: 'user', uuid: expected, session_id: session.nativeSessionId, parent_tool_use_id: null, message: { role: 'user', content: 'already sent' } },
      { type: 'assistant', uuid: 'old-reply', session_id: session.nativeSessionId, parent_tool_use_id: null, message: { role: 'assistant', stop_reason: 'end_turn', content: 'reply without native result evidence' } },
    ])
    const history = await f.manager.reconcile(session, 'request-lost-ack')
    expect((history as typeof history & { nativeSubmission?: unknown }).nativeSubmission).toEqual({ kind: 'message', nativeSessionId: session.nativeSessionId, nativeMessageId: expected, clientCorrelationId: 'request-lost-ack' })
    expect(history.nativeTurnId).toBeUndefined(); expect(history.terminalResult).toBeUndefined()
    expect(f.client.getSessionMessages).toHaveBeenCalledWith('native-session', { dir: '/work', limit: 256, offset: 0 })
    expect(() => f.manager.startTurn(session, { prompt: 'retry', clientCorrelationId: 'request-lost-ack' })).toThrow('already offered')
    const input = f.nextMessage()
    expect(await Promise.race([input.then(() => 'offered'), new Promise<string>((resolve) => setTimeout(() => resolve('idle'), 0))])).toBe('idle')
    await f.manager.dispose?.(); await input
  })
  it('does not acknowledge missing or foreign history, and validates actual native init version', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const expected = claudePromptUuid('unknown-request')
    f.client.getSessionMessages = vi.fn(async () => [{ type: 'user', uuid: expected, session_id: 'foreign-session', parent_tool_use_id: null }])
    const history = await f.manager.reconcile(session, 'unknown-request')
    expect(history.correlationId).toBeUndefined(); expect(history.terminalResult).toBeUndefined()
    await f.manager.dispose?.()
    const changed = fixture()
    changed.client.query = () => {
      void changed.frames.offer({ type: 'system', subtype: 'init', session_id: 'wrong', claude_code_version: '2.1.286', cwd: '/work' })
      return { [Symbol.asyncIterator]: () => changed.frames[Symbol.asyncIterator](), close: () => changed.frames.close(), interrupt: async () => undefined }
    }
    const changedResult = drain(changed.manager.startInitialTurn(start, { prompt: 'one', clientCorrelationId: 'operator:one', onSessionObserved: async () => undefined }))
    await expect(changedResult).rejects.toThrow('qualified CLI version')
    await changed.manager.dispose?.()
  })

  it('inspects only the exact live callback generation/message and performs no SDK response or pending-row lookup', async () => {
    const inspect = vi.fn(async (query: import('./callbackAvailability.js').ClaudeLiveCallbackQuery) => ({
      nativeSessionId: query.nativeSessionId, nativeRequestId: query.nativeRequestId, nativeRequestType: query.nativeRequestType,
      nativeMessageId: query.nativeMessageId, generation: query.generation, qualified: true, state: 'available' as const, path: 'live_callback' as const, reason: 'live_callback' as const,
    }))
    const pending = vi.fn(async () => undefined); const respond = vi.fn(async () => undefined)
    const f = fixture(() => (raw) => {
      const frame = raw as { type: string; session_id?: string; message?: { id: string; content: { id: string }[] } }
      return frame.type === 'assistant' ? [{ type: 'claude.tool', payload: { nativeSessionId: frame.session_id,
        messageId: frame.message?.id, toolUseId: frame.message?.content[0]?.id } }] : []
    }, { qualification: { ...qualification, interactions: true }, liveCallbacks: { inspectCallbackAvailability: inspect }, interactionPort: { pending, respond } })
    const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const subscriber = f.manager.startTurn(session, { prompt: 'one', clientCorrelationId: 'request-one' })[Symbol.asyncIterator]()
    const message = await f.nextMessage()
    const query: import('./callbackAvailability.js').ClaudeResponseAvailabilityQuery = { nativeRequestId: 'native-request-one', nativeRequestType: 'can_use_tool' }
    expect((await f.manager.inspectResponseAvailability!(session, query)).reason).toBe('callback_lost')
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'root-frame', user_message_uuid: message.uuid,
      message: { id: 'api-one', content: [{ type: 'tool_use', id: 'root-tool-one', name: 'Bash', input: {} }] } })
    await subscriber.next(); await subscriber.next()
    const context = f.manager.nativeCallbackContext(session.nativeSessionId, 'root-tool-one')!
    expect(context.nativeMessageId).toBe(message.uuid); expect(context.generation).toBeTruthy()
    const result = await f.manager.inspectResponseAvailability!(session, query)
    expect(result.state).toBe('available'); expect(result.generation).toBe(context.generation); expect(result.nativeTurnId).toBeUndefined()
    expect(inspect).toHaveBeenCalledWith({ ...query, nativeSessionId: session.nativeSessionId, nativeMessageId: message.uuid, generation: context.generation })
    expect(pending).not.toHaveBeenCalled(); expect(respond).not.toHaveBeenCalled()
    expect((await f.manager.inspectResponseAvailability!(session, { ...query, expectedNativeTurnId: 'not-a-native-turn' })).reason).toBe('identity_mismatch')
    query.expectedNativeMessageId = message.uuid
    query.expectedGeneration = context.generation
    expect((await f.manager.inspectResponseAvailability!(session, query)).state).toBe('available')
    const beforeMismatch = inspect.mock.calls.length
    query.expectedNativeMessageId = 'older-native-message'
    expect((await f.manager.inspectResponseAvailability!(session, query)).reason).toBe('identity_mismatch')
    query.expectedNativeMessageId = message.uuid
    query.expectedGeneration = 'older-runtime-generation'
    expect((await f.manager.inspectResponseAvailability!(session, query)).reason).toBe('identity_mismatch')
    expect(inspect.mock.calls.length).toBe(beforeMismatch)
    query.expectedGeneration = context.generation
    inspect.mockImplementationOnce(async q => ({ nativeSessionId: q.nativeSessionId, nativeRequestId: q.nativeRequestId,
      nativeRequestType: q.nativeRequestType, nativeMessageId: 'wrong-resident-message', generation: q.generation,
      qualified: true, state: 'available', path: 'live_callback', reason: 'live_callback' }))
    expect((await f.manager.inspectResponseAvailability!(session, query)).reason).toBe('identity_mismatch')

    inspect.mockImplementation(async (q) => ({ nativeSessionId: q.nativeSessionId, nativeRequestId: q.nativeRequestId,
      nativeRequestType: q.nativeRequestType, nativeMessageId: q.nativeMessageId, generation: 'old-generation', qualified: true, state: 'available', path: 'live_callback', reason: 'live_callback' }))
    expect((await f.manager.inspectResponseAvailability!(session, query)).reason).toBe('identity_mismatch')
    await subscriber.return?.(); await f.manager.close(session)
    expect((await f.manager.inspectResponseAvailability!(session, query)).reason).toBe('session_closed')
    await f.manager.dispose?.()
  })
  it('does not recreate callback availability from a persisted accepted receipt after restart', async () => {
    const inspect = vi.fn()
    const f = fixture(undefined, { qualification: { ...qualification, interactions: true }, liveCallbacks: { inspectCallbackAvailability: inspect } })
    const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    f.client.getSessionMessages = async () => [{ type: 'user', uuid: claudePromptUuid('request-old'), session_id: session.nativeSessionId, parent_tool_use_id: null }]
    await f.manager.reconcile(session, 'request-old')
    const result = await f.manager.inspectResponseAvailability!(session, { nativeRequestId: 'persisted-question', nativeRequestType: 'can_use_tool' })
    expect(result.reason).toBe('callback_lost'); expect(result.state).toBe('unavailable'); expect(inspect).not.toHaveBeenCalled()
    await f.manager.dispose?.()
  })

  it('offers exactly one initial input before observed SID, then persists SID before its native input receipt', async () => {
    const f = fixture(); const order: string[] = []
    let boundSession: import('@foreman-code/contracts').NativeSessionReference | undefined
    const result = drain(f.manager.startInitialTurn(start, { prompt: 'first accepted prompt', clientCorrelationId: 'operator:one',
      onSessionObserved: async (session) => { order.push('session'); boundSession = session },
      onMessageSubmitted: async (receipt) => { expect(boundSession?.nativeSessionId).toBe(receipt.nativeSessionId); order.push('message') },
    }))
    expect(boundSession).toBeUndefined()
    const input = await f.nextMessage()
    expect(input.uuid).toBe(claudePromptUuid('operator:one'))
    void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply', user_message_uuid: input.uuid, message: { id: 'api-first', content: [] } })
    void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result', user_message_uuid: input.uuid, subtype: 'success', is_error: false, result: 'done' })
    await result
    expect(order).toEqual(['session', 'message'])
    expect((await f.manager.reconcile(boundSession!, 'operator:one')).terminalResult?.output).toBe('done')
    // A retry returns the existing attempt; it cannot start another SDK process or offer another input.
    const retry = f.manager.startInitialTurn(start, { prompt: 'first accepted prompt', clientCorrelationId: 'operator:one', onSessionObserved: async () => undefined })
    expect(await drain(retry)).toEqual([])
    await f.manager.dispose?.()
  })
  it('does not publish ACK/body before observed native SID persistence completes', async () => {
    const f = fixture(); let release!: () => void
    const saving = new Promise<void>((resolve) => { release = resolve })
    const submitted = vi.fn(async () => undefined)
    const result = drain(f.manager.startInitialTurn(start, { prompt: 'first', clientCorrelationId: 'operator:one', onSessionObserved: async () => saving, onMessageSubmitted: submitted }))
    const input = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply', user_message_uuid: input.uuid })
    void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result', user_message_uuid: input.uuid, subtype: 'success', is_error: false, result: 'done' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(submitted).not.toHaveBeenCalled()
    release(); await result
    expect(submitted).toHaveBeenCalledTimes(1)
    await f.manager.dispose?.()
  })

  it('inspects real SDK control health before input and retains exactly the same query for the first turn', async () => {
    const f = fixture(undefined, { expectedMcp: { serverName: 'graphql', url: 'http://127.0.0.1:3000/mcp/app' } })
    const inspection = await f.manager.prepareInspection(start)
    expect(inspection.initializationAnswered).toBe(true)
    expect(inspection.servers[0]?.status).toBe('connected')
    expect(JSON.stringify(inspection)).not.toContain('secret-token')
    expect((await f.manager.inspectMcp()).state).toBe('connected')
    expect(f.queries).toHaveBeenCalledTimes(1)
    let observed: import('@foreman-code/contracts').NativeSessionReference | undefined
    const result = drain(f.manager.startInitialTurn(start, { prompt: 'first', clientCorrelationId: 'operator:one', onSessionObserved: async (session) => { observed = session } }))
    const input = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply', user_message_uuid: input.uuid })
    void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result', user_message_uuid: input.uuid, subtype: 'success', is_error: false, result: 'done' })
    await result
    expect(observed?.nativeSessionId).toBe('native-session'); expect(f.queries).toHaveBeenCalledTimes(1)
    await f.manager.dispose?.()
  })
  it('does not treat saved MCP config as live connected or replace a prepared owner/query', async () => {
    const f = fixture(undefined, { expectedMcp: { serverName: 'graphql', url: 'http://127.0.0.1:3000/mcp/app' } })
    f.statuses.mockResolvedValueOnce([{ name: 'graphql', status: 'pending', source: 'dynamic', config: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app', headers: { Authorization: 'secret-token' } }, tools: [] }])
    const snapshot = await f.manager.prepareInspection(start)
    expect(snapshot.servers[0]?.status).toBe('pending')
    await expect(f.manager.prepareInspection({ ...start, workingDirectory: '/foreign' } as NativeSessionStart)).rejects.toThrow('working directory')
    await expect(f.manager.prepareInspection({ ...start, correlationId: 'other-owner' } as NativeSessionStart)).rejects.toThrow('immutable inspection context')
    expect(f.queries).toHaveBeenCalledTimes(1)
    await f.manager.dispose?.()
  })

  it.each([
    ['GRAPHQL_MCP_TOKEN', 'GRAPHQL_MCP_TOKEN'],
    ['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN'],
    ['FOREMAN_CODE_MCP_TOKEN', 'GRAPHQL_MCP_TOKEN'],
    ['FOREMAN_CODE_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN'],
  ])('delivers scoped %s credentials and starts with %s on the same inspected query', async (refreshName, startName) => {
    const baseServers = { graphql: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app' } }
    const f = fixture(undefined, { sdkOptions: { mcpServers: baseServers }, appMcpAccess: 'management', credentialEnvironmentVariables: ['GRAPHQL_MCP_TOKEN'] })
    const tokenFree = { ...start, environment: { agentId: 'operator', variables: {} } }
    const credentialed = { ...start, environment: { agentId: 'operator', variables: { [refreshName]: 'scoped-token' } } }
    await f.manager.prepareInspection(tokenFree)
    const servers = { graphql: { ...baseServers.graphql, headers: { Authorization: 'Bearer scoped-token' } } }
    const health = await f.manager.refreshInspectionCredentials(credentialed, servers)
    expect(health.servers[0]?.status).toBe('connected')
    expect(f.setServers).toHaveBeenCalledWith(servers); expect(f.queries).toHaveBeenCalledTimes(1)
    const admitted = { ...start, environment: { agentId: 'operator', variables: { [startName]: 'scoped-token' } } }
    expect(await f.manager.prepareInspection(admitted)).toMatchObject({
      generation: health.generation, currentAuthorizationScope: health.currentAuthorizationScope,
      httpCredentialAcknowledgement: health.httpCredentialAcknowledgement,
    })
    await expect(f.manager.prepareInspection({ ...admitted, environment: {
      agentId: 'operator', variables: { [startName]: 'another-token' },
    } })).rejects.toThrow('immutable inspection context')
    expect(f.offers).not.toHaveBeenCalled()
    const result = drain(f.manager.startInitialTurn(admitted, { prompt: 'one', clientCorrelationId: 'operator:one', onSessionObserved: async () => undefined }))
    const input = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply', user_message_uuid: input.uuid })
    void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result', user_message_uuid: input.uuid, subtype: 'success', is_error: false, result: 'done' })
    await result
    const session = { harness: 'claude' as const, providerVersion: '2.1.284', nativeSessionId: 'native-session' }
    expect(await f.manager.attachSession(session, credentialed)).toEqual(session)
    expect(f.offers).toHaveBeenCalledOnce()
    expect(f.queries).toHaveBeenCalledTimes(1)
    await f.manager.dispose?.()
  })
  it('does not turn static configured headers, environment or connected health into an HTTP credential ACK', async () => {
    const servers = { graphql: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app', headers: { Authorization: 'Bearer static-secret' } } }
    const f = fixture(undefined, { sdkOptions: { mcpServers: servers }, appMcpAccess: 'management', expectedMcp: { serverName: 'graphql', url: servers.graphql.url } })
    const credentialed = { ...start, environment: { agentId: 'operator', variables: { GRAPHQL_MCP_TOKEN: 'static-secret' } } }
    const snapshot = await f.manager.prepareInspection(credentialed)
    expect(snapshot.httpCredentialAcknowledgement).toBeUndefined()
    expect((await f.manager.inspectMcp()).credentialArrangement).toEqual({ kind: 'unknown' })
    expect(JSON.stringify(snapshot)).not.toContain('static-secret')
    expect(f.setServers).not.toHaveBeenCalled()
    await f.manager.dispose?.()
  })

  it('retains only the actual managed HTTP update ACK across readback and rotates its opaque credential scope', async () => {
    const servers = { graphql: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app' } }
    const f = fixture(undefined, { sdkOptions: { mcpServers: servers }, appMcpAccess: 'management', expectedMcp: { serverName: 'graphql', url: servers.graphql.url } })
    const admitted = (token: string) => ({ ...start, environment: { agentId: 'operator', variables: { GRAPHQL_MCP_TOKEN: token } } })
    const configured = (token: string) => ({ graphql: { ...servers.graphql, headers: { Authorization: `Bearer ${token}` } } })
    const initial = await f.manager.prepareInspection({ ...start, environment: { agentId: 'operator', variables: {} } })
    const update = deferred<Awaited<ReturnType<typeof f.setServers>>>()
    const health = deferred<Awaited<ReturnType<typeof f.statuses>>>()
    const entered = deferred<void>(); const healthEntered = deferred<void>()
    f.statuses.mockImplementationOnce(() => { healthEntered.resolve(); return health.promise })
    f.setServers.mockImplementationOnce(() => { entered.resolve(); return update.promise })
    const refreshing = f.manager.refreshInspectionCredentials(admitted('private-first-token'), configured('private-first-token'))
    await entered.promise
    expect(initial.httpCredentialAcknowledgement).toBeUndefined()
    expect(f.offers).not.toHaveBeenCalled()
    await expect(f.manager.inspectMcp()).rejects.toThrow('another control operation')
    update.resolve({ added: ['graphql'], removed: [], errors: {} })
    await healthEntered.promise
    await expect(f.manager.refreshInspectionCredentials(admitted('private-first-token'), configured('private-first-token'))).rejects.toThrow('another owned SDK control operation')
    health.resolve(await f.statuses.mock.results[0]!.value)
    const first = await refreshing
    expect(first.httpCredentialAcknowledgement).toEqual({ source: 'sdk_set_mcp_servers', serverName: 'graphql', endpoint: servers.graphql.url,
      generation: first.generation, authorizationScope: first.currentAuthorizationScope })
    expect(first.currentAuthorizationScope).toMatch(/^[a-f0-9]{64}$/)
    expect((await f.manager.prepareInspection(admitted('private-first-token'))).httpCredentialAcknowledgement).toEqual(first.httpCredentialAcknowledgement)
    expect((await f.manager.inspectMcp()).credentialArrangement).toEqual({ kind: 'scoped_http_header' })
    const second = await f.manager.refreshInspectionCredentials(admitted('private-second-token'), configured('private-second-token'))
    expect(second.currentAuthorizationScope).not.toBe(first.currentAuthorizationScope)
    expect(second.httpCredentialAcknowledgement?.authorizationScope).toBe(second.currentAuthorizationScope)
    expect(second.generation).toBe(first.generation)
    const connected: Awaited<ReturnType<typeof f.statuses>> = await f.statuses.mock.results[0]!.value
    f.statuses.mockResolvedValueOnce(connected.map((row) => ({ ...row, status: 'pending' })))
    expect((await f.manager.inspectMcp()).credentialArrangement).toEqual({ kind: 'unknown' })
    expect((await f.manager.prepareInspection(admitted('private-second-token'))).httpCredentialAcknowledgement).toEqual(second.httpCredentialAcknowledgement)
    expect(JSON.stringify([first, second, await f.manager.inspectMcp()])).not.toMatch(/private-(first|second)-token/)
    expect(f.queries).toHaveBeenCalledTimes(1)
    expect(f.close).not.toHaveBeenCalled()
    await f.manager.dispose?.()
    await expect(f.manager.prepareInspection(admitted('private-second-token'))).rejects.toThrow('disposed')
    const fresh = fixture(undefined, { sdkOptions: { mcpServers: configured('private-second-token') }, appMcpAccess: 'management', expectedMcp: { serverName: 'graphql', url: servers.graphql.url } })
    const freshSnapshot = await fresh.manager.prepareInspection(admitted('private-second-token'))
    expect(freshSnapshot.generation).not.toBe(second.generation)
    expect(freshSnapshot.httpCredentialAcknowledgement).toBeUndefined()
    expect((await fresh.manager.inspectMcp()).credentialArrangement).toEqual({ kind: 'unknown' })
    await fresh.manager.dispose?.()
  })

  it.each(['server-error', 'rejected-ack', 'foreign-ack', 'wrong-token', 'wrong-owner'] as const)('clears an older HTTP credential receipt on %s refresh failure', async (failure) => {
    const servers = { graphql: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app' } }
    const f = fixture(undefined, { sdkOptions: { mcpServers: servers }, appMcpAccess: 'management', expectedMcp: { serverName: 'graphql', url: servers.graphql.url } })
    const credentialed = { ...start, environment: { agentId: 'operator', variables: { GRAPHQL_MCP_TOKEN: 'private-accepted-token' } } }
    const configured = { graphql: { ...servers.graphql, headers: { Authorization: 'Bearer private-accepted-token' } } }
    await f.manager.prepareInspection({ ...start, environment: { agentId: 'operator', variables: {} } })
    const accepted = await f.manager.refreshInspectionCredentials(credentialed, configured)
    expect(accepted.httpCredentialAcknowledgement).toBeDefined()
    if (failure === 'server-error') f.setServers.mockResolvedValueOnce({ added: [], removed: [], errors: { graphql: 'native refusal with private data' } })
    if (failure === 'rejected-ack') f.setServers.mockRejectedValueOnce(new Error('native refusal private-accepted-token'))
    if (failure === 'foreign-ack') f.setServers.mockResolvedValueOnce({ added: ['foreign'], removed: [], errors: {} })
    const nextStart = failure === 'wrong-owner' ? { ...credentialed, correlationId: 'foreign-owner' } : credentialed
    const nextServers = failure === 'wrong-token' ? { graphql: { ...servers.graphql, headers: { Authorization: 'Bearer private-foreign-token' } } } : configured
    const error = await f.manager.refreshInspectionCredentials(nextStart, nextServers).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    expect(JSON.stringify(error)).not.toMatch(/private-|native refusal/)
    const readback = await f.manager.prepareInspection(credentialed)
    expect(readback.httpCredentialAcknowledgement).toBeUndefined()
    expect((await f.manager.inspectMcp()).credentialArrangement).toEqual({ kind: 'unknown' })
    expect(f.queries).toHaveBeenCalledTimes(1)
    await f.manager.dispose?.()
  })

  it('denies management credential refresh for forbidden roles or changed endpoints/noncredential environment', async () => {
    const f = fixture()
    await f.manager.prepareInspection(start)
    await expect(f.manager.refreshInspectionCredentials(start, {})).rejects.toThrow('no management MCP')
    expect(f.setServers).not.toHaveBeenCalled(); await f.manager.dispose?.()
    const g = fixture(undefined, { appMcpAccess: 'management', sdkOptions: { mcpServers: { graphql: { type: 'http', url: 'http://local/mcp' } } } })
    await g.manager.prepareInspection(start)
    await expect(g.manager.refreshInspectionCredentials(start, { graphql: { type: 'http', url: 'http://foreign/mcp' } })).rejects.toThrow('server names')
    expect(g.setServers).not.toHaveBeenCalled(); await g.manager.dispose?.()
  })

  it('settles an owned pre-input control timeout by closing/joining the same SDK query', async () => {
    const f = fixture(undefined, { initializationTimeoutMs: 10 })
    let rejectControl!: (reason: unknown) => void
    const waiting = new Promise<readonly unknown[]>((_resolve, reject) => { rejectControl = reject })
    f.client.query = (input) => {
      f.queries(input)
      return { [Symbol.asyncIterator]: () => f.frames[Symbol.asyncIterator](), initializationResult: async () => ({}),
        mcpServerStatus: () => waiting, interrupt: async () => undefined,
        close: () => { rejectControl(new Error('owned SDK control closed')); f.frames.close(); f.close() } }
    }
    await expect(f.manager.prepareInspection(start)).rejects.toThrow('owned SDK control closed')
    expect(f.queries).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalled()
    await f.manager.dispose?.()
  })
  const controlRaces = (['prepare', 'inspect', 'refresh-update', 'refresh-health'] as const).flatMap((controlKind) =>
    (controlKind.startsWith('refresh') ? ['initial'] as const : ['initial', 'later'] as const).flatMap((inputKind) =>
      (['abort', 'timeout'] as const).map((ending) => ({ controlKind, inputKind, ending }))))
  it.each(controlRaces)('$controlKind fences $inputKind input through $ending cleanup', async ({ controlKind, inputKind, ending }) => {
    const refresh = controlKind.startsWith('refresh')
    const servers = { graphql: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app' } }
    const f = fixture(undefined, { initializationTimeoutMs: 50, appMcpAccess: 'management', sdkOptions: { mcpServers: servers } })
    const joined = deferred<void>(); const closed = deferred<void>(); const entered = deferred<void>()
    const waiting = deferred<Awaited<ReturnType<typeof f.statuses>>>()
    const update = deferred<Awaited<ReturnType<typeof f.setServers>>>()
    const query = f.client.query
    f.client.query = async (input) => ({ ...await query(input), joinClosed: () => joined.promise })
    await f.manager.prepareInspection(start)
    let session: import('@foreman-code/contracts').NativeSessionReference | undefined
    if (inputKind === 'later') {
      const result = drain(f.manager.startInitialTurn(start, { prompt: 'first', clientCorrelationId: 'operator:one', onSessionObserved: async (value) => { session = value } }))
      const message = await f.nextMessage()
      void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply', user_message_uuid: message.uuid })
      void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'done' })
      await result
    }
    if (controlKind === 'refresh-update') f.setServers.mockImplementationOnce(() => { entered.resolve(); return update.promise })
    else f.statuses.mockImplementationOnce(() => { entered.resolve(); return waiting.promise })
    f.close.mockImplementation(() => {
      const error = new Error('owned delayed control closed')
      if (controlKind === 'refresh-update') update.reject(error); else waiting.reject(error)
      f.frames.close(); closed.resolve()
    })
    const abort = new AbortController()
    const control = refresh ? f.manager.refreshInspectionCredentials(start, servers, abort.signal)
      : controlKind === 'prepare' ? f.manager.prepareInspection(start, abort.signal) : f.manager.inspectMcp(abort.signal)
    let settled = false
    const outcome = control.then(() => { settled = true; return undefined }, (error: unknown) => { settled = true; return error })
    await entered.promise
    const baseline = f.offers.mock.calls.length
    let initialError: unknown
    if (inputKind === 'initial') {
      const observer = drain(f.manager.startInitialTurn(start, { prompt: 'blocked', clientCorrelationId: 'operator:one', onSessionObserved: async () => undefined }))
      void observer.catch((error: unknown) => { initialError = error })
      await new Promise<void>((resolve) => setImmediate(resolve))
    } else {
      try { f.manager.startTurn(session!, { prompt: 'blocked', clientCorrelationId: 'request-blocked' }) } catch (error) { initialError = error }
    }
    const offersWhileControlPending = f.offers.mock.calls.length
    if (ending === 'abort') abort.abort(new Error('inspection cancelled'))
    await closed.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    const settledBeforeJoin = settled
    joined.resolve()
    expect(await outcome).toBeInstanceOf(Error)
    expect(initialError).toMatchObject({ result: { error: { code: 'CLAUDE_INSPECTION_BUSY' } } })
    expect(offersWhileControlPending).toBe(baseline)
    expect(settledBeforeJoin).toBe(false)
    expect(f.offers).toHaveBeenCalledTimes(baseline)
    expect(f.queries).toHaveBeenCalledTimes(1)
    expect(f.close).toHaveBeenCalledTimes(1)
    await f.manager.dispose?.()
  })

  it('releases a successful control reservation before accepting a fenced reusable correlation', async () => {
    const f = fixture()
    await f.manager.prepareInspection(start)
    void f.frames.offer({ type: 'system', subtype: 'init', session_id: 'native-session', claude_code_version: '2.1.284', cwd: '/work' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const entered = deferred<void>(); const status = deferred<Awaited<ReturnType<typeof f.statuses>>>()
    f.statuses.mockImplementationOnce(() => { entered.resolve(); return status.promise })
    const inspecting = f.manager.inspectMcp()
    await entered.promise
    expect(() => f.manager.startTurn(session, { prompt: 'later', clientCorrelationId: 'fenced-correlation' })).toThrow('control operation is pending')
    await expect(f.manager.inspectMcp()).rejects.toThrow('another control operation')
    status.resolve(await f.statuses.mock.results[0]!.value)
    await inspecting
    const result = drain(f.manager.startTurn(session, { prompt: 'later', clientCorrelationId: 'fenced-correlation' }))
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'later-reply', user_message_uuid: message.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'later-result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'done' })
    await result
    expect(f.offers).toHaveBeenCalledTimes(1)
    expect(f.close).not.toHaveBeenCalled()
    await f.manager.dispose?.()
  })

  it.each(['update', 'health'] as const)('holds credential refresh reservation through delayed %s and its ACK-to-health handoff', async (phase) => {
    const baseServers = { graphql: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app' } }
    const f = fixture(undefined, { sdkOptions: { mcpServers: baseServers }, appMcpAccess: 'management' })
    await f.manager.prepareInspection(start)
    const entered = deferred<void>(); const update = deferred<Awaited<ReturnType<typeof f.setServers>>>()
    const health = deferred<Awaited<ReturnType<typeof f.statuses>>>()
    if (phase === 'update') f.setServers.mockImplementationOnce(() => { entered.resolve(); return update.promise })
    else f.statuses.mockImplementationOnce(() => { entered.resolve(); return health.promise })
    const refreshing = f.manager.refreshInspectionCredentials(start, baseServers)
    await entered.promise
    const observer = drain(f.manager.startInitialTurn(start, { prompt: 'blocked', clientCorrelationId: 'operator:one', onSessionObserved: async () => undefined }))
    let inputError: unknown
    void observer.catch((error: unknown) => { inputError = error })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const offersWhilePending = f.offers.mock.calls.length
    if (phase === 'update') update.resolve({ added: ['graphql'], removed: [], errors: {} })
    else health.resolve(await f.statuses.mock.results[0]!.value)
    const result = await refreshing
    expect(inputError).toMatchObject({ result: { error: { code: 'CLAUDE_INSPECTION_BUSY' } } })
    expect(offersWhilePending).toBe(0)
    expect(result.servers[0]?.status).toBe('connected')
    expect(f.setServers).toHaveBeenCalledTimes(1)
    expect(f.statuses).toHaveBeenCalledTimes(2)
    expect(f.queries).toHaveBeenCalledTimes(1)
    expect(f.close).not.toHaveBeenCalled()
    await f.manager.dispose?.()
  })

  it('wakes the owned iterator from exact actual callback notification and returns complete pending state', async () => {
    let pending: import('@foreman-code/contracts').PendingNativeInteraction[] = []
    const f = fixture(() => (raw) => {
      const frame = raw as { type: string; session_id?: string; message?: { id: string; content: { id: string }[] } }
      return frame.type === 'assistant' ? [{ type: 'claude.tool', payload: { nativeSessionId: frame.session_id, messageId: frame.message?.id, toolUseId: frame.message?.content[0]?.id } }] : []
    }, { pendingInteractions: () => pending })
    const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const output = f.manager.startTurn(session, { prompt: 'permission', clientCorrelationId: 'request-A', callbackAuthority: { ownerPrincipalId: 'sender-A', attemptId: 'attempt-A' } } as ClaudeMessageTurnInput)[Symbol.asyncIterator]()
    const input = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'tool-frame', user_message_uuid: input.uuid, message: { id: 'api-A', content: [{ type: 'tool_use', id: 'tool-A', name: 'Read', input: {} }] } })
    await output.next(); await output.next()
    const context = f.manager.nativeCallbackContext(session.nativeSessionId, 'tool-A')!
    expect(f.manager.callbackAuthority(context)).toEqual({ ownerPrincipalId: 'sender-A', attemptId: 'attempt-A' })
    expect(f.manager.callbackAuthority({ ...context, nativeMessageId: 'foreign-input' })).toBeUndefined()
    pending = [{ session, turn: { nativeMessageId: input.uuid, nativeRequestId: 'rpc-A' }, nativeRequestType: 'can_use_tool', request: {}, responseOptions: [{ id: 'allow', label: 'Allow', semantic: 'approve_once' }] }] as unknown as import('@foreman-code/contracts').PendingNativeInteraction[]
    const wake = output.next()
    f.manager.notifyPendingChanged({ ...context, nativeRequestId: 'rpc-A', nativeRequestType: 'can_use_tool' })
    expect((await wake).value?.type).toBe('interaction.pending')
    expect((await f.manager.history(session)).pendingInteractions).toEqual(pending)
    expect((await f.manager.reconcile(session, 'request-A')).pendingInteractions).toEqual(pending)
    expect((await f.manager.reconcile(session, 'foreign-correlation')).pendingInteractions).toEqual([])
    await output.return?.(); await f.manager.dispose?.()
  })

})

it('applies preferences by idle exact-session resume and retains the admitted security configuration', async () => {
  const security = { model: 'sonnet', permissionMode: 'default', tools: ['Read'],
    sandbox: { enabled: true, allowUnsandboxedCommands: false }, settingSources: [], strictMcpConfig: true }
  const f = fixture(undefined, { sdkOptions: security })
  let frames = f.frames
  f.client.query = input => {
    f.queries(input)
    frames = new ClaudeBoundedQueue(32)
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
      initializationResult: async () => ({ models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet' },
        { value: 'sonnet[1m]', resolvedModel: 'claude-sonnet', displayName: 'Sonnet (1M)' }] }),
      getContextUsage: async () => ({ rawMaxTokens: input.options.model === 'sonnet[1m]' ? 1000000 : 200000,
        maxTokens: 200000, totalTokens: 10,
        model: input.options.model === 'sonnet[1m]' ? 'Sonnet (1M)' : String(input.options.model),
        isAutoCompactEnabled: (input.options.env as Record<string, string>)?.DISABLE_AUTO_COMPACT !== '1' }),
      interrupt: f.interrupt, close: () => frames.close(), setPermissionMode: async () => {},
    }
  }
  const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
    nativeSessionId: 'native-session' }, start)
  const desired = SessionPreferencesSchema.parse({ autoCompact: 'off', autoCompactTokens: 150000 })
  await f.manager.applySessionPreferences!(session, desired)
  expect(f.manager.appliedSessionPreferences!(session)).toEqual(desired)
  const resumed = f.queries.mock.calls.at(-1)![0]
  expect(resumed.options).toMatchObject({ ...security, resume: 'native-session',
    env: { DISABLE_AUTO_COMPACT: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' } })
  await f.manager.applySessionPreferences!(session, SessionPreferencesSchema.parse({
    autoCompact: 'on', contextProfile: 'sonnet[1m]', autoCompactTokens: 500000,
  }))
  expect(f.manager.appliedSessionPreferences!(session)?.contextProfile).toBe('sonnet[1m]')
  expect((await f.manager.sessionControlCapabilities!(session)).modelCapacity).toBe(1000000)
  expect(f.queries.mock.calls.at(-1)![0].options).toMatchObject({ ...security, model: 'sonnet[1m]', resume: 'native-session' })
  await f.manager.dispose!()
})

it('rejects an oversized fresh budget before the first model input', async () => {
  const f = fixture(undefined, { sdkOptions: { model: 'sonnet' } })
  const query = f.client.query
  f.client.query = input => ({ ...query(input), getContextUsage: async () => ({ rawMaxTokens: 200000,
    maxTokens: 200000, totalTokens: 0, model: 'sonnet', isAutoCompactEnabled: true }) })
  await f.manager.configureSessionPreferences!(SessionPreferencesSchema.parse({ autoCompactTokens: 1000000 }))
  const events = drain(f.manager.startInitialTurn(start, { prompt: 'task', clientCorrelationId: 'operator:one',
    onSessionObserved: async () => {} }))
  await expect(events).rejects.toThrow('context capacity')
  await expect(events).rejects.toMatchObject({ certainty: 'definite', deliveryState: 'not-delivered' })
  expect(f.offers).not.toHaveBeenCalled()
  await f.manager.dispose!()
})

for (const result of ['no-op', 'failed'] as const) it(`recovers a lost ${result} compaction result while resident and after restart`, async () => {
  const profilePath = await mkdtemp(join(tmpdir(), 'claude-controls-'))
  const localScope = { ...scope, profilePath }
  const f = fixture(undefined, { scope: localScope })
  const open = f.runner.open
  f.runner.open = async input => {
    const sdk = await open(input)
    return { ...sdk, output: { async *[Symbol.asyncIterator]() {
      for await (const output of sdk.output) {
        if ((output.raw as { type?: string }).type !== 'result') yield output
      }
    } } }
  }
  f.runner.compactionHistory = async () => ({ cursor: { scope: 'scope', identity: 'identity', offset: 0 }, boundaries: [] })
  const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
  f.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId,
    cwd: '/work', claude_code_version: '2.1.284', slash_commands: ['compact'] })
  await vi.waitFor(async () => expect((await f.manager.sessionControlCapabilities!(session)).compact.supported).toBe(true))
  const abort = new AbortController()
  let state: import('@foreman-code/contracts').CompactionState | undefined
  const compact = f.manager.compactSession!(session, { requestId: 'compact-request', clientCorrelationId: 'compact-correlation',
    onProgress: async value => { state = value } }, abort.signal)
  const message = await f.nextMessage()
  f.frames.offer({ type: 'result', session_id: session.nativeSessionId, user_message_uuid: message.uuid,
    is_error: result === 'failed', subtype: result === 'failed' ? 'error_during_execution' : 'success', result: 'Nothing to compact' })
  await vi.waitFor(async () => expect(await f.runner.compactionOutcome!({ ...localScope, nativeSessionId: session.nativeSessionId },
    localScope, message.uuid)).toMatchObject({ status: result }))
  abort.abort(new Error('Native notification was lost'))
  await expect(compact).rejects.toThrow('lost')
  const pending = { ...state!, status: 'uncertain' as const }
  expect((await f.manager.reconcileCompaction!(session, pending)).status).toBe(result)
  await f.manager.dispose!()
  const restarted = fixture(undefined, { scope: localScope })
  const rebound = await restarted.manager.attachSession(session, start)
  expect((await restarted.manager.reconcileCompaction!(rebound, pending)).status).toBe(result)
  await restarted.manager.dispose!()
  await rm(profilePath, { recursive: true, force: true })
})

it('releases its runtime fence after a failed pre-dispatch save without offering compact', async () => {
  const f = fixture()
  f.runner.compactionHistory = async () => ({ cursor: { scope: 'scope', identity: 'identity', offset: 0 }, boundaries: [] })
  const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
  f.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId, cwd: '/work',
    claude_code_version: '2.1.284', slash_commands: ['compact'] })
  await vi.waitFor(async () => expect((await f.manager.sessionControlCapabilities!(session)).compact.supported).toBe(true))
  await expect(f.manager.compactSession!(session, { requestId: 'compact-request', clientCorrelationId: 'control-request',
    onProgress: async () => {}, onDispatch: async () => { throw new Error('Dispatch storage failed') } }))
    .rejects.toThrow('Dispatch storage failed')
  expect(f.offers).not.toHaveBeenCalled()
  const output = drain(f.manager.startTurn(session, { prompt: 'follow-up', clientCorrelationId: 'next-task' }))
  const message = await f.nextMessage()
  f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply', user_message_uuid: message.uuid })
  f.frames.offer({ type: 'result', session_id: session.nativeSessionId, user_message_uuid: message.uuid,
    subtype: 'success', is_error: false, result: 'done' })
  await output
  await f.manager.dispose!()
})
