import assert from 'node:assert/strict'
import { it } from 'vitest'
import { nativeMessageId } from '../src/modules/harnesses/opencodeProtocol.js'
import { advanced, configuration, errorCode, FixtureServer, json, manager, sessionFor } from './opencode-fixtures.js'

it('ignores pre-submission idle with ACK and persisted root before later completion', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.onConnection = count => {
    if (count === 1) {
      server.emit('session.status', { sessionID: session.nativeSessionId, status: { type: 'busy' } })
      server.emit('session.idle', { sessionID: session.nativeSessionId })
    } else server.complete('admission', 'later completion')
  }
  server.onPrompt = () => { server.statuses.delete(session.nativeSessionId) }
  try {
    for await (const _event of native.startTurn(session, { clientCorrelationId: 'admission', prompt: 'hello' })) { void _event }
    assert.deepEqual((await native.reconcile(session, 'admission')).terminalResult, { outcome: 'succeeded', output: { text: 'later completion' } })
    assert.equal(server.calls.filter(call => call.path.includes('/prompt_async')).length, 1)
  } finally { await native.dispose() }
})

it('does not settle a turn from status returned after process replacement', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.onPrompt = () => { throw new Error('lost ACK') }
  try {
    await assert.rejects(async () => {
      for await (const _event of native.startTurn(session, { clientCorrelationId: 'stale', prompt: 'hello' })) { void _event }
    })
    server.beforeRequest = path => {
      if (path.startsWith('/session/status')) {
        server.generation++
        return json({})
      }
      return undefined
    }
    await assert.rejects(native.reconcile(session, 'stale'), /generation.*changed/i)
    assert.equal(server.calls.filter(call => call.path.includes('/prompt_async')).length, 1)
  } finally { await native.dispose() }
})

it('cancellation interrupts pending prompt admission before serialized native abort', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  const request = server.request.bind(server)
  let started!: () => void
  const dispatch = new Promise<void>(resolve => { started = resolve })
  let posts = 0
  server.request = async (path, init, signal, generation) => {
    if (path.includes('/prompt_async')) {
      posts++
      started()
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
    }
    return request(path, init, signal, generation)
  }
  const turn = native.startTurn(session, { clientCorrelationId: 'cancel-admission', prompt: 'hello' })[Symbol.asyncIterator]()
  try {
    const next = turn.next()
    // Register rejection before requesting cancellation to avoid an unhandled observer rejection.
    const detached = assert.rejects(next)
    await dispatch
    const canceled = native.cancel(session)
    await detached
    assert.equal(await canceled, true)
    assert.equal(posts, 1)
    assert.equal(server.calls.filter(call => call.path.includes('/abort')).length, 1)
  } finally { await native.dispose() }
})

it('cancellation during readiness prevents queued prompt dispatch', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  const ensure = server.ensure.bind(server)
  let started!: () => void
  const readiness = new Promise<void>(resolve => { started = resolve })
  let block = true
  server.ensure = async signal => {
    if (!block) return ensure(signal)
    block = false
    started()
    await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
  }
  try {
    const next = native.startTurn(session, { clientCorrelationId: 'cancel-readiness', prompt: 'hello' })[Symbol.asyncIterator]().next()
    const detached = assert.rejects(next)
    await readiness
    const canceled = native.cancel(session)
    await detached
    assert.equal(await canceled, true)
    assert.equal(server.calls.filter(call => call.path.includes('/prompt_async')).length, 0)
  } finally { await native.dispose() }
})

it('keeps exact-turn steering and interactive questions unsupported with zero native POSTs', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  try {
    const capabilities = await native.capabilities()
    assert.deepEqual(capabilities.supportedInteractionKinds, ['approval'])
    assert.equal(Reflect.get(native, 'steerTurn'), undefined)
    assert.equal(server.calls.filter(call => call.method === 'POST').length, 0)
  } finally { await native.dispose() }
})

it('rejects different permission lifetimes despite identical directory MCP switches', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  try {
    await sessionFor(native)
    await assert.rejects(sessionFor(native, { ...configuration(), advanced: { ...advanced(),
      permissionRules: [{ permission: 'shell', pattern: '*', effect: 'deny' }],
    } }), errorCode('OPENCODE_PERMISSION_CONTEXT_CONFLICT'))
    assert.equal(server.calls.filter(call => call.path.startsWith('/session?') && call.method === 'POST').length, 1)
  } finally { await native.dispose() }
})

it('drops old-generation stream error before it can settle a recovered turn', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  const turn = native.startTurn(session, { clientCorrelationId: 'stale-stream', prompt: 'hello' })[Symbol.asyncIterator]()
  try {
    assert.equal((await turn.next()).done, false)
    server.generation++
    server.statuses.delete(session.nativeSessionId)
    server.emit('session.error', { sessionID: session.nativeSessionId, error: { name: 'STALE_STREAM_ERROR', data: { message: 'old generation' } } })
    while (!(await turn.next()).done) { /* consume reconciliation */ }
    const history = await native.reconcile(session, 'stale-stream')
    assert.equal(history.terminalResult?.error?.code, 'OPENCODE_TURN_INTERRUPTED')
    assert.equal(server.calls.filter(call => call.path.includes('/prompt_async')).length, 1)
  } finally { await native.dispose() }
})

it('persists a proven prompt ACK identity before honoring observer detachment', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  const observer = new AbortController()
  const submitted: string[] = []
  server.onPrompt = () => observer.abort(new Error('observer detached before ACK'))
  try {
    await assert.rejects(async () => {
      for await (const event of native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'accepted-detach',
        onSubmitted: async id => { submitted.push(id) },
      }, observer.signal)) void event
    })
    assert.deepEqual(submitted, [nativeMessageId('accepted-detach')])
    assert.equal(server.calls.filter(call => call.path.includes('/prompt_async')).length, 1)
    assert.equal(server.calls.filter(call => call.path.includes('/abort')).length, 0)
  } finally { await native.dispose() }
})
