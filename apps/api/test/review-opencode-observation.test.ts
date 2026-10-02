import assert from 'node:assert/strict'
import { it } from 'vitest'
import { FixtureServer, errorCode, manager, sessionFor } from './opencode-fixtures.js'
import { nativeMessageId } from '../src/modules/harnesses/opencodeProtocol.js'

it('F-11 recovers the exact root after a lost ACK and observes a later idle interruption without replay', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.onPrompt = () => { throw new Error('lost prompt ACK') }
  let resumed: AsyncIterator<unknown> | undefined
  try {
    await assert.rejects(async () => {
      for await (const event of native.startTurn(session, { clientCorrelationId: 'lost-ack', prompt: 'hello' })) void event
    })
    assert.equal(server.generation, 1)
    server.onConnection = () => {
      server.statuses.delete(session.nativeSessionId)
      server.emit('session.idle', { sessionID: session.nativeSessionId })
    }
    resumed = native.observeTurn(session, 'lost-ack')[Symbol.asyncIterator]()
    // Rooted history is returned before the new event subscription.
    const root = await resumed.next()
    assert.equal(root.done, false)
    while (true) {
      const event = await resumed.next()
      if (event.done || (event.value as { type: string }).type === 'session.idle') break
    }
    const result = await native.reconcile(session, 'lost-ack')
    assert.equal(result.terminalResult?.error?.code, 'OPENCODE_TURN_INTERRUPTED')
    await resumed.return?.()
    resumed = undefined
    server.onPrompt = () => { server.complete('successor') }
    server.onConnection = undefined
    for await (const event of native.startTurn(session, { clientCorrelationId: 'successor', prompt: 'next' })) void event
    assert.equal((await native.reconcile(session, 'successor')).terminalResult?.outcome, 'succeeded')
    const prompts = server.calls.filter(call => call.path.includes('/prompt_async'))
    assert.equal(prompts.filter(call => call.body?.messageID === nativeMessageId('lost-ack')).length, 1)
    assert.equal(prompts.filter(call => call.body?.messageID === nativeMessageId('successor')).length, 1)
    assert.equal(server.generation, 1)
  } finally { await resumed?.return?.(); await native.dispose() }
})

it('F-11 keeps a buffered pre-submission idle fenced even when history confirms the root', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.onConnection = () => { server.emit('session.idle', { sessionID: session.nativeSessionId }) }
  server.onPrompt = () => { server.statuses.delete(session.nativeSessionId) }
  const turn = native.startTurn(session, { clientCorrelationId: 'buffered-idle', prompt: 'hello' })[Symbol.asyncIterator]()
  try {
    const buffered = await turn.next()
    assert.equal(buffered.done, false)
    assert.equal(buffered.value.type, 'session.idle')
    assert.equal((await native.reconcile(session, 'buffered-idle')).terminalResult, undefined)
    await assert.rejects(native.startTurn(session, { clientCorrelationId: 'too-early', prompt: 'next' })[Symbol.asyncIterator]().next(),
      errorCode('OPENCODE_SESSION_BUSY'))
    server.onConnection = undefined
    server.complete('buffered-idle', 'completed after buffered idle')
    while (!(await turn.next()).done) { /* Drain the genuine completion. */ }
    assert.equal((await native.reconcile(session, 'buffered-idle')).terminalResult?.outcome, 'succeeded')
    assert.equal(server.calls.filter(call => call.path.includes('/prompt_async')).length, 1)
  } finally { await turn.return?.(); await native.dispose() }
})
