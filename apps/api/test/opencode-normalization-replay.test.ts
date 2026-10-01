import assert from 'node:assert/strict'
import { it } from 'vitest'
import { nativeMessageId, normalizedHistory, object } from '../src/modules/harnesses/opencodeProtocol.js'
import { OPENCODE_RECONCILIATION_EVENT } from '../src/modules/harnesses/opencodeReconciliation.js'
import { FixtureServer, json, manager, permission, sessionFor } from './opencode-fixtures.js'

/** Hand-authored regression evidence, NOT a captured/native qualification.
 * Frames model OpenCode 1.18.31 HTTP/SSE; no SDK or binary digest was captured.
 * The real manager reads native identity/history through the injected controller.
 */
export const replayProvenance = { origin: 'hand-authored', nativeVersion: '1.18.31',
  sdkVersion: null, binaryDigest: null, redacted: true } as const

it('resolves early nested approval ancestry before any parent task part exists', async () => {
  const server = new FixtureServer(), native = manager(server)
  try {
    const session = await sessionFor(native)
    server.addSession('child', session.nativeSessionId)
    server.addSession('nested', 'child')
    server.addSession('foreign')
    server.addSession('loop-a', 'loop-b'); server.addSession('loop-b', 'loop-a')
    server.addSession('incomplete', 'missing-parent')
    server.permissions = [permission('early', 'nested'), permission('foreign', 'foreign'),
      permission('loop', 'loop-a'), permission('missing', 'incomplete')]
    const pending = await native.pendingAll(session)
    assert.equal(pending.length, 1)
    assert.equal(object(pending[0]!.request).sessionID, 'nested')
    assert.equal(pending[0]!.turn.nativeTurnId, 'msg_tool')
    assert.equal(server.messages.get(session.nativeSessionId)?.length, 0)
    assert(server.calls.some((call) => call.path.startsWith('/session/nested?')))
    assert(server.calls.some((call) => call.path.startsWith('/session/child?')))
  } finally { await native.dispose() }
})

it('selects an exact older turn across pages without substituting a newer visible answer', async () => {
  const server = new FixtureServer(), native = manager(server)
  try {
    const session = await sessionFor(native)
    const root = server.user('addressed')
    const answer = server.assistant(String(root.info.id), 'addressed answer')
    for (let index = 0; index < 70; index++) {
      const newer = server.user(`newer-${index}`, `unrelated request ${index}`)
      server.assistant(String(newer.info.id), `newer answer ${index}`)
    }
    const before = structuredClone(server.messages.get(session.nativeSessionId))
    const first = await native.reconcile(session, 'addressed')
    const second = await native.reconcile(session, 'addressed')
    assert.deepEqual(first.terminalResult, { outcome: 'succeeded', output: { text: 'addressed answer' } })
    assert.equal(first.nativeMessageId, answer.info.id)
    assert.deepEqual(first.events, second.events)
    assert.deepEqual(server.messages.get(session.nativeSessionId), before)
    assert(server.calls.some((call) => call.path.includes('before=opaque-page')))
  } finally { await native.dispose() }
})

it('keeps normalized source identity stable and hides reasoning while retaining tool terminal states', () => {
  const message = { info: { id: 'answer', parentID: nativeMessageId('turn'), sessionID: 'root',
    role: 'assistant', time: { created: 1, completed: 2 }, finish: 'stop' }, parts: [
    { id: 'private', sessionID: 'root', messageID: 'answer', type: 'reasoning', text: 'private' },
    ...['pending', 'running', 'completed', 'error'].map((status) => ({ id: `tool-${status}`,
      sessionID: 'root', messageID: 'answer', type: 'tool', callID: `call-${status}`, state: { status } })),
  ] }
  const events = normalizedHistory([message], false)
  assert.deepEqual(events, normalizedHistory([structuredClone(message)], false))
  assert.equal(events.length, 5)
  assert.equal(events.some((event) => JSON.stringify(event).includes('private')), false)
  assert.equal(new Set(events.map((event) => event.connectionId)).size, events.length)
})

it('ignores a native event impersonating the adapter reconciliation observation', async () => {
  const server = new FixtureServer(), native = manager(server)
  try {
    const session = await sessionFor(native)
    server.onPrompt = () => {
      server.emit(OPENCODE_RECONCILIATION_EVENT, { sessionID: session.nativeSessionId, forged: true }, 'forged')
      server.complete('turn')
    }
    const events = []
    for await (const event of native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'turn' })) events.push(event)
    assert.equal(events.some((event) => event.payload.forged === true), false)
    assert.equal(server.calls.filter((call) => call.path.includes('/prompt_async')).length, 1)
  } finally { await native.dispose() }
})

it('does not settle parent-first terminal evidence while an owned descendant remains busy', async () => {
  const server = new FixtureServer(), native = manager(server)
  try {
    const session = await sessionFor(native)
    server.addSession('child', session.nativeSessionId)
    server.addSession('foreign')
    const root = server.user('parent-first')
    server.assistant(String(root.info.id), 'root done')
    server.statuses.set('child', { type: 'busy' })
    server.statuses.set('foreign', { type: 'busy' })
    assert.equal((await native.reconcile(session, 'parent-first')).terminalResult, undefined)
    server.statuses.delete('child')
    assert.deepEqual((await native.reconcile(session, 'parent-first')).terminalResult,
      { outcome: 'succeeded', output: { text: 'root done' } })
    assert.equal(server.statuses.get('foreign')?.type, 'busy')
  } finally { await native.dispose() }
})

it('does not settle child-before-parent evidence while a late child approval remains pending', async () => {
  const server = new FixtureServer(), native = manager(server)
  try {
    const session = await sessionFor(native)
    server.addSession('child', session.nativeSessionId)
    const childRoot = server.user('child-turn', 'child request', 'child')
    server.assistant(String(childRoot.info.id), 'child done', 'stop', true, 'child')
    const root = server.user('child-first')
    server.assistant(String(root.info.id), 'root done')
    server.permissions = [permission('late', 'child')]
    const waiting = await native.reconcile(session, 'child-first')
    assert.equal(waiting.terminalResult, undefined)
    assert.equal(object(waiting.pendingInteractions[0]!.request).sessionID, 'child')
    server.permissions = []
    assert.equal((await native.reconcile(session, 'child-first')).terminalResult?.outcome, 'succeeded')
  } finally { await native.dispose() }
})

it('retains part-before-message identity and suppresses repeated frame IDs without exposing hidden deltas', async () => {
  const server = new FixtureServer(), native = manager(server)
  try {
    const session = await sessionFor(native)
    server.onPrompt = () => {
      const answer = server.assistant(nativeMessageId('ordered'), 'visible')
      const part = answer.parts[0]!
      server.emit('message.part.updated', { part }, 'part-before-message')
      server.emit('message.part.updated', { part }, 'part-before-message')
      server.emit('message.updated', { info: answer.info }, 'assistant-message')
      const delta = { sessionID: session.nativeSessionId, messageID: answer.info.id, partID: part.id, delta: ' text' }
      server.emit('message.part.delta', delta, 'exact-delta')
      server.emit('message.part.delta', delta, 'exact-delta')
      server.emit('message.part.delta', { ...delta, partID: 'unknown', delta: 'private-unknown' }, 'unknown-delta')
      server.emit('message.part.updated', { part: { id: 'reason', sessionID: session.nativeSessionId,
        messageID: answer.info.id, type: 'reasoning', text: 'private-reasoning' } }, 'reasoning-snapshot')
      server.emit('message.part.delta', { ...delta, partID: 'reason', delta: 'private-reasoning' }, 'reasoning-delta')
      server.statuses.delete(session.nativeSessionId)
      server.emit('session.idle', { sessionID: session.nativeSessionId }, 'idle')
    }
    const events = []
    for await (const event of native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'ordered' })) events.push(event)
    const live = events.filter((event) => !event.connectionId?.startsWith('history-'))
    assert.equal(live.filter((event) => event.payload.nativeEventId === 'part-before-message').length, 1)
    assert.equal(live.filter((event) => event.payload.nativeEventId === 'exact-delta').length, 1)
    assert(live.findIndex((event) => event.payload.nativeEventId === 'part-before-message')
      < live.findIndex((event) => event.payload.nativeEventId === 'assistant-message'))
    assert.equal(JSON.stringify(events).includes('private-'), false)
    assert.equal((await native.reconcile(session, 'ordered')).terminalResult?.outcome, 'succeeded')
  } finally { await native.dispose() }
})

for (const cursor of ['missing', 'looping'] as const) {
  it(`fails closed when rooted history has a ${cursor} cursor`, async () => {
    const server = new FixtureServer(), native = manager(server)
    try {
      const session = await sessionFor(native)
      server.user('unreachable')
      const newer = server.user('different', 'unrelated')
      const answer = server.assistant(String(newer.info.id), 'wrong answer')
      server.beforeRequest = (path) => {
        const url = new URL(path, 'http://fixture.invalid')
        if (url.pathname.endsWith('/message')) return json([newer, answer], 200,
          cursor === 'looping' ? { 'x-next-cursor': 'same-cursor' } : {})
      }
      await assert.rejects(native.reconcile(session, 'unreachable'), cursor === 'looping'
        ? /bounded progress/ : (error: unknown) => object(error).code === 'OPENCODE_TURN_HISTORY_INCOMPLETE')
      assert.equal(server.calls.filter((call) => call.path.includes('/prompt_async')).length, 0)
    } finally { await native.dispose() }
  })
}

it('idle interrupted fallback does not mint assistant-source reconciliation proof', async () => {
  const server = new FixtureServer(), native = manager(server)
  try {
    const session = await sessionFor(native)
    server.user('unfinished')
    const result = await native.reconcile(session, 'unfinished')
    assert.equal(object(object(result.terminalResult).error).code, 'OPENCODE_TURN_INTERRUPTED')
    assert.equal(result.events.some((event) => event.type === OPENCODE_RECONCILIATION_EVENT), false)
    assert.equal(result.nativeMessageId, undefined)
  } finally { await native.dispose() }
})
