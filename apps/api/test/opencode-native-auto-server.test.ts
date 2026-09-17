import assert from 'node:assert/strict'

import { it } from 'vitest'

import { nativePolicy } from '../src/modules/harnesses/opencodeProtocol.js'
import { advanced, configuration, errorCode, FixtureServer, manager, permission, sessionFor } from './opencode-fixtures.js'

function automatic() {
  return { ...configuration(), autoApprove: true,
    advanced: { ...advanced(), permissionHandling: 'native_auto' as const } }
}
function replies(server: FixtureServer) {
  return server.calls.filter((call) => /\/permission\/[^/?]+\/reply(?:\?|$)/.test(call.path))
}

it('native auto answers exact owned asks once, including descendants but not foreign sessions', async () => {
  const server = new FixtureServer(), native = manager(server), harness = automatic()
  try {
    const session = await sessionFor(native, harness)
    server.addSession('child', session.nativeSessionId, harness)
    server.addSession('foreign', undefined, harness)
    server.permissions = [permission('root', session.nativeSessionId), permission('child-ask', 'child'), permission('foreign-ask', 'foreign')]
    assert.deepEqual(await native.pendingAll(session), [])
    assert.deepEqual(replies(server).map((call) => call.body), [{ reply: 'once' }, { reply: 'once' }])
    assert.ok(replies(server).some((call) => call.path.includes('/permission/root/reply')))
    assert.ok(replies(server).some((call) => call.path.includes('/permission/child-ask/reply')))
    assert.deepEqual(server.permissions.map((item) => item.id), ['foreign-ask'])
    await native.pendingAll(session)
    assert.equal(replies(server).length, 2)
  } finally { await native.dispose() }
})

it('retains the exact native deny policy and never invents an ask for it', async () => {
  const server = new FixtureServer(), native = manager(server), harness = automatic()
  harness.advanced.permissionRules = [{ permission: 'bash', pattern: '*', effect: 'deny' }]
  const before = structuredClone(harness)
  try {
    const session = await sessionFor(native, harness)
    assert.deepEqual(server.sessionInfos.get(session.nativeSessionId)?.permission, nativePolicy(harness))
    // The provider remains responsible for enforcing deny. A denied operation
    // that emits no permission.asked must not produce a client-side approval.
    assert.deepEqual(await native.pendingAll(session), [])
    assert.deepEqual(replies(server), [])
    assert.deepEqual(harness, before)
  } finally { await native.dispose() }
})

it('routed mode still returns the exact pending request for durable coordination', async () => {
  const server = new FixtureServer(), native = manager(server)
  try {
    const session = await sessionFor(native)
    server.permissions = [permission('routed', session.nativeSessionId)]
    const [pending] = await native.pendingAll(session)
    assert.equal(pending?.turn.nativeRequestId, 'routed')
    assert.deepEqual(replies(server), [])
    const option = pending?.responseOptions.find((entry) => entry.semantic === 'approve_once')
    assert.ok(option)
    await native.respond(session, 'routed', option)
    assert.deepEqual(replies(server).map((call) => call.body), [{ reply: 'once' }])
  } finally { await native.dispose() }
})

it('refuses manual routed responses on an automatic session', async () => {
  const server = new FixtureServer(), native = manager(server)
  try {
    const routed = await sessionFor(native)
    server.permissions = [permission('option', routed.nativeSessionId)]
    const [pending] = await native.pendingAll(routed)
    assert.ok(pending)
    await native.cancel(routed)
    await native.close(routed)
    const session = await sessionFor(native, automatic())
    server.permissions = [permission('auto', session.nativeSessionId)]
    const before = replies(server).length
    await assert.rejects(native.respond(session, 'auto', pending.responseOptions[0]!), errorCode('OPENCODE_NATIVE_AUTO_RESPONSE_CONFLICT'))
    assert.equal(replies(server).length, before)
  } finally { await native.dispose() }
})

it('native Stop aborts owned work and rejects asks without automatically approving during cleanup', async () => {
  const server = new FixtureServer(), native = manager(server), harness = automatic()
  try {
    const session = await sessionFor(native, harness)
    server.addSession('child', session.nativeSessionId, harness)
    server.permissions = [permission('root', session.nativeSessionId), permission('child', 'child')]
    server.statuses.set(session.nativeSessionId, { type: 'busy' })
    server.statuses.set('child', { type: 'busy' })
    assert.equal(await native.cancel(session), true)
    assert.deepEqual(replies(server).map((call) => call.body), [{ reply: 'reject' }, { reply: 'reject' }])
    assert.equal(server.calls.filter((call) => /\/abort(?:\?|$)/.test(call.path)).length, 2)
    assert.deepEqual((await native.history(session)).pendingInteractions, [])
    assert.ok(replies(server).every((call) => call.body?.reply === 'reject'))
  } finally { await native.dispose() }
})

it('streams an automatic ask through server mode and reconciles the same turn without replaying the prompt', async () => {
  const server = new FixtureServer(), native = manager(server), correlation = 'native-auto-turn'
  try {
    const session = await sessionFor(native, automatic())
    server.onPrompt = (sessionID) => {
      server.permissions = [permission('auto-sse', sessionID)]
      server.emit('permission.asked', permission('auto-sse', sessionID))
    }
    server.beforeRequest = (path, init) => {
      if (path.includes('/permission/auto-sse/reply') && JSON.parse(String(init.body)).reply === 'once') {
        queueMicrotask(() => { server.complete(correlation, 'automatic completion', session.nativeSessionId) })
      }
      return undefined
    }
    const events = []
    for await (const event of native.startTurn(session, { prompt: 'test', clientCorrelationId: correlation }, AbortSignal.timeout(5_000))) events.push(event)
    assert.ok(events.length > 0)
    const history = await native.reconcile(session, correlation)
    assert.equal(history.terminalTurn?.correlationId, correlation)
    assert.equal(history.terminalTurn?.result.outcome, 'succeeded')
    assert.deepEqual(history.pendingInteractions, [])
    await native.reconcile(session, correlation)
    assert.equal(server.calls.filter((call) => call.path.includes('/prompt_async')).length, 1)
    assert.deepEqual(replies(server).map((call) => call.body), [{ reply: 'once' }])
  } finally { await native.dispose() }
})

it('qualifies server settings and connected credentials without starting a native session', async () => {
  const server = new FixtureServer(), native = manager(server)
  server.providers = { ...(server.providers as Record<string, unknown>), connected: ['opencode-go'] }
  try {
    const qualified = await native.qualifyConfiguration(automatic(), '/workspace/project')
    assert.equal(qualified.ready, true)
    assert.equal(qualified.authenticated, true)
    assert.ok(qualified.supportedSettings.includes('advanced.permissionHandling'))
    assert.equal(server.calls.filter((call) => call.method === 'POST').length, 0)
  } finally { await native.dispose() }
})
