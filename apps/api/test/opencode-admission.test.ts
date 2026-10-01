import assert from 'node:assert/strict'
import { it } from 'vitest'
import { FixtureServer, json, manager, sessionFor } from './opencode-fixtures.js'

it('ignores pre-submission idle with ACK and persisted root before later completion', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.onConnection = count => {
    if (count === 1) server.emit('session.idle', { sessionID: session.nativeSessionId })
    else server.complete('admission', 'later completion')
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
    await assert.rejects(native.reconcile(session, 'stale'), /generation changed/i)
    assert.equal(server.calls.filter(call => call.path.includes('/prompt_async')).length, 1)
  } finally { await native.dispose() }
})
