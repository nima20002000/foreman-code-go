import assert from 'node:assert/strict'

import { it } from 'vitest'

import { OpenCodeNativeDeliveryError } from '../src/modules/harnesses/opencodeServer.js'
import { nativeMessageId, nativePolicy, normalizedHistory, object, OPENCODE_EVENT_LIMIT, OPENCODE_ID_LIMIT } from '../src/modules/harnesses/opencodeProtocol.js'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import { OPENCODE_RECONCILIATION_EVENT, readOpenCodeReconciliation,
  matchesOpenCodeHistorySource } from '../src/modules/harnesses/opencodeReconciliation.js'
import { forgetQualifiedProfile, rememberQualifiedProfile } from '../src/modules/harnesses/qualification/profiles.js'

import { advanced, brokenBody, configuration, environment, errorCode, FixtureServer, json, manager, permission, request, sessionFor } from './opencode-fixtures.js'

async function collect(events: AsyncIterable<NativeHarnessEvent>) {
  const result: NativeHarnessEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

it('reads the server version during ensure before checking its profile', async () => {
  const server = new FixtureServer()
  server.expectedVersion = ''
  const ensure = server.ensure.bind(server)
  server.ensure = async (signal) => { await ensure(signal); server.expectedVersion = '1.18.31' }
  const native = manager(server)
  try { assert.equal((await sessionFor(native)).providerVersion, '1.18.31') }
  finally { await native.dispose() }
})

it('qualifies the pinned live API and submits one prompt after opening its event stream', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.onPrompt = () => { server.complete('turn-1') }
  const events = await collect(native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'turn-1' }))
  assert(events.some((event) => event.type === 'message.part.updated'))
  const reconciled = await native.reconcile(session, 'turn-1')
  assert.deepEqual(reconciled.terminalResult, { outcome: 'succeeded', output: { text: 'done' } })
  assert.deepEqual(reconciled.terminalTurn, {
    correlationId: 'turn-1', providerId: nativeMessageId('turn-1'),
    result: { outcome: 'succeeded', output: { text: 'done' } },
  })
  // Raw provider history is unchanged; the completed scan has a separate,
  // adapter-owned observation, never a relabeled history/Codex event.
  const raw = reconciled.events.filter((event) => event.type !== OPENCODE_RECONCILIATION_EVENT)
  assert.deepEqual(raw, normalizedHistory(server.messages.get(session.nativeSessionId)!, false))
  assert(raw.length > 0)
  assert(raw.every((event) => event.sequence === 0 && event.connectionId?.startsWith('history-')))
  assert.equal(new Set(raw.map((event) => event.connectionId)).size, raw.length)
  const observations = reconciled.events.filter((event) => event.type === OPENCODE_RECONCILIATION_EVENT)
  assert.equal(observations.length, 1)
  const observation = observations[0]!
  assert.equal(observation.connectionId, events[0]!.connectionId)
  const proof = readOpenCodeReconciliation(observation, { ownerAgentId: 'agent-1',
    nativeSessionId: session.nativeSessionId, providerVersion: session.providerVersion,
    correlationId: 'turn-1', nativeTurnId: nativeMessageId('turn-1') })
  assert(proof)
  assert(raw.some((event) => matchesOpenCodeHistorySource(proof, event)))
  assert.equal(new Set(reconciled.events.map((event) => JSON.stringify([event.connectionId, event.sequence]))).size,
    reconciled.events.length)
  const prompt = server.calls.find((call) => call.path.includes('/prompt_async'))!
  assert.deepEqual(prompt.body?.parts, [{ type: 'text', text: 'hello' }])
  assert.equal(prompt.body?.messageID, nativeMessageId('turn-1'))
  assert(server.calls.findIndex((call) => call.path.startsWith('/event')) < server.calls.indexOf(prompt))
  assert.equal((await native.capabilities()).sameRequestResponses, true)
  await native.close(session)
})

it('reports the live health version for a qualified non-baseline server', async () => {
  const version = '1.18.33'
  rememberQualifiedProfile('opencode', version, 'opencode-1.18.31')
  const server = new FixtureServer()
  server.expectedVersion = version
  server.providers = { ...server.providers as object, connected: ['opencode-go'] }
  server.beforeRequest = (path) => path === '/global/health' ? json({ healthy: true, version }) : undefined
  const native = manager(server)
  try {
    const session = await sessionFor(native)
    assert.equal(session.providerVersion, version)
    assert.equal((await native.capabilities()).providerVersion, version)
    assert.equal((await native.discoverOptions('/workspace/project')).providerVersion, version)
    assert.equal((await native.inspectNativeMcp('/workspace/project', undefined, 'configuration')).providerVersion, version)
    await native.close(session)
  } finally {
    await native.dispose()
    forgetQualifiedProfile('opencode', version)
  }
})

it('[F04] never promotes tool-call narration while a later assistant is unfinished', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  const root = server.user('tools')
  server.assistant(String(root.info.id), 'I will run the tests', 'tool-calls')
  server.assistant(String(root.info.id), '', undefined, false)
  server.statuses.set(session.nativeSessionId, { type: 'busy' })
  assert.equal((await native.reconcile(session, 'tools')).terminalResult, undefined)
  server.complete('tools', 'Tests passed')
  assert.deepEqual((await native.reconcile(session, 'tools')).terminalResult?.output, { text: 'Tests passed' })
})

it('[F04] pending tool work and incomplete newest responses cannot use older completed text', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  const root = server.user('pending-tool')
  const message = server.assistant(String(root.info.id), 'Not a final answer', 'stop')
  message.parts.push({ id: 'prt_tool', type: 'tool', state: { status: 'running' } })
  const result = (await native.reconcile(session, 'pending-tool')).terminalResult
  assert.notEqual(result?.outcome, 'succeeded')
})

it('[F05] reattachment recovers exact native correlation and cannot substitute an older answer', async () => {
  const server = new FixtureServer()
  const original = manager(server)
  const session = await sessionFor(original)
  server.user('old'); server.complete('old', 'old answer')
  server.user('new'); server.assistant(nativeMessageId('new'), 'unfinished', undefined, false)
  server.statuses.set(session.nativeSessionId, { type: 'busy' })
  const restarted = manager(server)
  await restarted.attachSession(session, { request: request(), environment: environment() })
  assert.equal((await restarted.reconcile(session, 'new')).terminalResult, undefined)
  await assert.rejects(restarted.reconcile(session, 'missing'), errorCode('OPENCODE_TURN_IDENTITY_MISSING'))
  assert.equal(server.calls.filter((call) => call.method === 'POST' && call.path.startsWith('/session?')).length, 1)
})

it('[F06] recovers automatic compaction continuations across native user IDs', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  const root = server.user('compact')
  const old = server.assistant(String(root.info.id), 'stale narration', 'tool-calls')
  old.info.error = { name: 'ContextOverflowError', data: { message: 'overflow before recovery' } }
  server.append({ info: { id: 'msg_compact', role: 'user', sessionID: session.nativeSessionId }, parts: [{ type: 'compaction', auto: true }] })
  server.assistant('msg_compact', 'summary').info.summary = true
  server.append({ info: { id: 'msg_continue', role: 'user', sessionID: session.nativeSessionId },
    parts: [{ type: 'text', text: 'Continue if you have next steps', synthetic: true, metadata: { compaction_continue: true } }] })
  server.assistant('msg_continue', 'actual final answer')
  assert.deepEqual((await native.reconcile(session, 'compact')).terminalResult?.output, { text: 'actual final answer' })
})

it('[F06] recovers pinned overflow replay shapes, but does not cross an unrelated real turn', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  const root = server.user('replay', 'original prompt')
  server.assistant(String(root.info.id), 'original', 'tool-calls')
  server.append({ info: { id: 'msg_overflow', role: 'user', sessionID: session.nativeSessionId }, parts: [{ type: 'compaction', auto: true, overflow: true }] })
  server.assistant('msg_overflow', 'summary').info.summary = true
  server.append({ info: { ...root.info, id: 'msg_replay' }, parts: root.parts.map((part) => ({ ...part, id: 'prt_replay', messageID: 'msg_replay' })) })
  server.assistant('msg_replay', 'replay final')
  server.user('unrelated', 'different request'); server.complete('unrelated', 'not this answer')
  assert.deepEqual((await native.reconcile(session, 'replay')).terminalResult?.output, { text: 'replay final' })
})

it('[F07] a scoped failure before assistant creation produces an explicit failed result', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.onPrompt = (id) => {
    server.statuses.delete(id)
    server.emit('session.error', { sessionID: id, error: { name: 'ProviderAuthError', data: { message: 'fixture authentication failed' } } })
  }
  await collect(native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'error-before-assistant' }))
  assert.equal((await native.reconcile(session, 'error-before-assistant')).terminalResult?.error?.code, 'ProviderAuthError')
})

it('[F07] idle persisted incomplete turns are interrupted, while empty final text is successful', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.user('interrupted'); server.assistant(nativeMessageId('interrupted'), 'partial', undefined, false)
  assert.equal((await native.reconcile(session, 'interrupted')).terminalResult?.error?.code, 'OPENCODE_TURN_INTERRUPTED')
  server.user('empty'); server.complete('empty', '')
  assert.deepEqual((await native.reconcile(session, 'empty')).terminalResult, { outcome: 'succeeded', output: { text: '' } })
})

it('[F08] descendant approvals retain exact child identities and reply to the same native request', async () => {
  for (const semantic of ['approve_once', 'provider_scoped_allow', 'reject'] as const) {
    const server = new FixtureServer()
    const native = manager(server)
    const session = await sessionFor(native)
    server.addSession('ses_child', session.nativeSessionId)
    server.addSession('ses_grandchild', 'ses_child')
    server.addSession('ses_foreign')
    server.permissions = [permission('per_child', 'ses_grandchild'), permission('per_foreign', 'ses_foreign')]
    const pending = await native.pendingAll(session)
    assert.equal(pending.length, 1)
    assert.equal(object(pending[0]!.request).sessionID, 'ses_grandchild')
    await native.respond(session, 'per_child', pending[0]!.responseOptions.find((option) => option.semantic === semantic)!)
    assert.deepEqual(server.permissions.map((item) => item.id), ['per_foreign'])
    const reply = server.calls.find((call) => call.path.startsWith('/permission/per_child/reply'))!
    assert.equal(reply.body?.reply, semantic === 'approve_once' ? 'once' : semantic === 'reject' ? 'reject' : 'always')
  }
})

it('[F08] rejection cascades only within the actual child; cancellation stops owned descendants', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.addSession('ses_child', session.nativeSessionId)
  server.addSession('ses_foreign')
  server.permissions = [permission('per_one', 'ses_child'), permission('per_two', 'ses_child'), permission('per_root'), permission('per_foreign', 'ses_foreign')]
  const pending = await native.pendingAll(session)
  await native.respond(session, 'per_one', pending[0]!.responseOptions.find((option) => option.semantic === 'reject')!)
  assert.deepEqual(server.permissions.map((item) => item.id), ['per_root', 'per_foreign'])
  server.statuses.set('ses_child', { type: 'busy' })
  server.statuses.set('ses_foreign', { type: 'busy' })
  assert.equal(await native.cancel(session), true)
  assert(server.calls.some((call) => call.path.startsWith('/session/ses_child/abort')))
  assert.equal(server.statuses.get('ses_foreign')?.type, 'busy')
  assert.deepEqual(server.permissions.map((item) => item.id), ['per_foreign'])
})

it('[F09,F19] detaching cancels the subscription, not native work or writer ownership', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  const first = native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'owned' })[Symbol.asyncIterator]()
  assert.equal((await first.next()).done, false)
  await first.return?.()
  assert(server.cancelledSubscriptions > 0)
  assert.equal(server.calls.filter((call) => call.path.includes('/abort')).length, 0)
  const competing = native.startTurn(session, { prompt: 'other', clientCorrelationId: 'other' })[Symbol.asyncIterator]()
  await assert.rejects(competing.next(), errorCode('OPENCODE_SESSION_BUSY'))
  const again = native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'owned' })[Symbol.asyncIterator]()
  assert.equal((await again.next()).done, false)
  await again.return?.()
  assert.equal(server.calls.filter((call) => call.path.includes('/prompt_async')).length, 1)
  assert.equal(await native.cancel(session), true)
  await native.close(session)
})

it('[F09] observer abort keeps native ownership and conflicting same-correlation payloads are rejected', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  const abort = new AbortController()
  const iterator = native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'abort-observer' }, abort.signal)[Symbol.asyncIterator]()
  await iterator.next()
  const blocked = iterator.next()
  abort.abort(new Error('observer detached'))
  await assert.rejects(blocked, /observer detached/)
  const forged = native.startTurn(session, { prompt: 'different', clientCorrelationId: 'abort-observer' })[Symbol.asyncIterator]()
  await assert.rejects(forged.next(), errorCode('OPENCODE_CORRELATION_CONFLICT'))
  assert.equal(server.calls.filter((call) => call.path.includes('/abort')).length, 0)
  await native.cancel(session)
})

it('[F09] restart detaches an unresolved turn without canceling or approving it', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  const iterator = native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'restart-wait' })[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).done, false)
  await iterator.return?.()
  await assert.rejects(native.close(session), errorCode('OPENCODE_SESSION_BUSY'))
  await native.closeForRestart(session)
  await native.closeForRestart(session)
  assert.equal(server.calls.filter((call) => call.path.includes('/abort')).length, 0)
  assert.equal(server.calls.filter((call) => call.path.includes('/permission/') && call.path.endsWith('/reply')).length, 0)
  assert.equal(server.disposals, 1)
})

it('[F09] explicit re-observation of a completed persisted turn never submits another prompt', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.user('persisted'); server.complete('persisted', 'persisted answer')
  await collect(native.observeTurn(session, 'persisted'))
  assert.equal(server.calls.filter((call) => call.path.includes('/prompt_async')).length, 0)
  assert.deepEqual((await native.reconcile(session, 'persisted')).terminalResult?.output, { text: 'persisted answer' })
})

it('[F11] concurrent first credential bindings are serialized and the second token cannot replace the first', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  server.beforeRestart = () => barrier
  const first = native.createSession({ request: request(), environment: environment('first') })
  const second = native.createSession({ request: request(), environment: environment('second') })
  const checkedSecond = assert.rejects(second, errorCode('OPENCODE_CREDENTIAL_CONTEXT_MISMATCH'))
  release()
  await first
  await checkedSecond
  assert.equal(server.restartEnvironments.length, 1)
  assert.equal(server.environment?.variables.GRAPHQL_MCP_TOKEN, 'first')
})

it('[F11] failed setup cleanup cannot dispose a concurrent valid creation', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const invalid = configuration(); invalid.model = 'opencode-go/missing'
  const failed = assert.rejects(native.createSession({ request: request(invalid), environment: environment() }), errorCode('OPENCODE_MODEL_UNAVAILABLE'))
  const valid = native.createSession({ request: request(), environment: environment() })
  await failed
  const session = await valid
  assert(server.sessionInfos.has(session.nativeSessionId))
  assert.equal(server.disposals, 1)
  assert.equal(server.environment?.variables.GRAPHQL_MCP_TOKEN, 'fixture-owner-token')
})

it('[F11] disposal invalidates queued setup instead of publishing a late session', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  let release!: () => void
  server.beforeRestart = () => new Promise<void>((resolve) => { release = resolve })
  const starting = native.createSession({ request: request(), environment: environment() })
  const checked = assert.rejects(starting)
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
  const disposing = native.dispose()
  release()
  await checked
  await disposing
  assert.equal(server.calls.filter((call) => call.method === 'POST' && call.path.startsWith('/session?')).length, 0)
})

it('[F14] reattachment verifies the complete ordered policy before any prompt', async () => {
  const server = new FixtureServer()
  const harness = configuration()
  harness.advanced = { ...advanced(), permissionRules: [
    { permission: 'shell', pattern: '*', effect: 'deny' }, { permission: 'shell', pattern: 'git status', effect: 'allow' },
  ] }
  const session = await sessionFor(manager(server), harness)
  const info = server.sessionInfos.get(session.nativeSessionId)!
  info.permission = [...nativePolicy(harness)].reverse()
  await assert.rejects(manager(server).attachSession(session, { request: request(harness), environment: environment() }), errorCode('OPENCODE_SESSION_PERMISSION_MISMATCH'))
  assert.equal(server.calls.filter((call) => call.path.includes('/prompt_async')).length, 0)
})

it('[F14] vanished sessions fail attachment without creating a replacement', async () => {
  const server = new FixtureServer()
  const session = await sessionFor(manager(server))
  server.sessionInfos.delete(session.nativeSessionId)
  await assert.rejects(manager(server).attachSession(session, { request: request(), environment: environment() }), errorCode('OPENCODE_SESSION_NOT_FOUND'))
  assert.equal(server.calls.filter((call) => call.method === 'POST' && call.path.startsWith('/session?')).length, 1)
})

it('[F16] restores and verifies MCP disable choices after credential and automatic restarts', async () => {
  const server = new FixtureServer()
  server.config = { mcp: { 'graphql': { type: 'remote', enabled: true } } }
  const harness = configuration(); harness.advanced = { ...advanced(), mcp: { serverEnabled: { 'graphql': false } } }
  const native = manager(server)
  const session = await sessionFor(native, harness)
  assert.equal(object(server.mcp['graphql']).status, 'disabled')
  await native.restartForCredential(environment('renewed'))
  assert.equal(object(server.mcp['graphql']).status, 'disabled')
  server.crashed = true
  await native.history(session)
  assert.equal(object(server.mcp['graphql']).status, 'disabled')
  assert.equal(server.calls.filter((call) => call.path.startsWith('/mcp/graphql/disconnect')).length, 3)
})

it('[F16] refuses conflicting instance-scoped MCP choices and unverified native control changes', async () => {
  const server = new FixtureServer()
  server.config = { mcp: { 'graphql': { type: 'remote', enabled: true } } }
  const first = configuration(); first.advanced = { ...advanced(), mcp: { serverEnabled: { 'graphql': false } } }
  const native = manager(server)
  await sessionFor(native, first)
  const conflicting = configuration(); conflicting.advanced = { ...advanced(), mcp: { serverEnabled: { 'graphql': true } } }
  await assert.rejects(sessionFor(native, conflicting), errorCode('OPENCODE_MCP_CONTEXT_CONFLICT'))
  const unverified = new FixtureServer(); unverified.config = server.config
  unverified.beforeRequest = (path) => path.startsWith('/mcp/graphql/disconnect') ? json(true) : undefined
  await assert.rejects(sessionFor(manager(unverified), first), errorCode('OPENCODE_MCP_CONTROL_NOT_APPLIED'))
})

it('[F07,F16] process replacement interrupts unfinished native work without replaying it', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  const iterator = native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'restart-work' })[Symbol.asyncIterator]()
  await iterator.next(); await iterator.return?.()
  server.crashed = true
  assert.equal((await native.reconcile(session, 'restart-work')).terminalResult?.error?.code, 'OPENCODE_TURN_INTERRUPTED')
  assert.equal(server.calls.filter((call) => call.path.includes('/prompt_async')).length, 1)
})

it('[F17] accepted mutations with broken bodies retain uncertain delivery', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.permissions = [permission('per_body')]
  const pending = await native.pending(session)
  server.beforeRequest = (path) => path.startsWith('/permission/per_body/reply') ? brokenBody() : undefined
  await assert.rejects(native.respond(session, 'per_body', pending!.responseOptions[0]!), (error: unknown) => {
    assert(error instanceof OpenCodeNativeDeliveryError); assert.equal(error.certainty, 'uncertain'); return true
  })
}, 10_000)

it('[F17] session creation uses mutation certainty for accepted-body failures and possible commits before 500', async () => {
  for (const status of [200, 500]) {
    const server = new FixtureServer()
    server.beforeRequest = (path, init) => {
      if (path.startsWith('/session?') && init.method === 'POST') {
        server.addSession('ses_committed')
        return brokenBody(status)
      }
      return undefined
    }
    await assert.rejects(sessionFor(manager(server)), (error: unknown) => {
      assert(error instanceof OpenCodeNativeDeliveryError); assert.equal(error.certainty, 'uncertain'); return true
    })
    assert(server.sessionInfos.has('ses_committed'))
    assert.equal(server.calls.filter((call) => call.method === 'POST' && call.path.startsWith('/session?')).length, 1)
  }
})

it('[F17,F19] submission failure closes a genuinely open stream and uncertain retries do not repost', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.beforeRequest = (path) => { if (path.includes('/prompt_async')) throw new Error('disconnected during POST'); return undefined }
  const first = native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'uncertain' })[Symbol.asyncIterator]()
  await assert.rejects(first.next(), (error: unknown) => error instanceof OpenCodeNativeDeliveryError && error.certainty === 'uncertain')
  assert.equal(server.cancelledSubscriptions, 1)
  server.beforeRequest = undefined
  server.user('uncertain'); server.complete('uncertain')
  await collect(native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'uncertain' }))
  assert.equal(server.calls.filter((call) => call.path.includes('/prompt_async')).length, 1)
})

it('[F18] reconnect establishment failure is retried without replaying prompt_async', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.onPrompt = () => { server.closeStreams(); server.failConnections = 1 }
  server.onConnection = (number) => { if (number >= 3) server.complete('reconnect', 'recovered') }
  await collect(native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'reconnect' }))
  assert(server.connections >= 3)
  assert.equal(server.calls.filter((call) => call.path.includes('/prompt_async')).length, 1)
  assert.deepEqual((await native.reconcile(session, 'reconnect')).terminalResult?.output, { text: 'recovered' })
})

it('[F20] hides actual reasoning updates and deltas before retention, reconnect and history', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.onPrompt = () => {
    const message = server.assistant(nativeMessageId('reasoning'), 'visible final')
    message.parts.unshift({ id: 'prt_reason', messageID: message.info.id, sessionID: session.nativeSessionId, type: 'reasoning', text: 'PRIVATE_REASONING_CANARY' })
    server.emit('message.part.updated', { part: message.parts[0] })
    server.emit('message.part.delta', { sessionID: session.nativeSessionId, partID: 'prt_reason', field: 'text', delta: 'PRIVATE_REASONING_DELTA' })
    server.statuses.delete(session.nativeSessionId)
    server.emit('session.idle', { sessionID: session.nativeSessionId })
  }
  const events = await collect(native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'reasoning' }))
  assert(!JSON.stringify(events).includes('PRIVATE_REASONING'))
  assert(!JSON.stringify(await native.history(session)).includes('PRIVATE_REASONING'))
  const states = (native as unknown as { sessions: Map<string, { events: NativeHarnessEvent[] }> }).sessions
  assert(!JSON.stringify(states.get(session.nativeSessionId)?.events).includes('PRIVATE_REASONING'))
})

it('[F21] authoritative history reconstructs missed tool completion and final output after replacement', async () => {
  const server = new FixtureServer()
  const session = await sessionFor(manager(server))
  server.user('recover-history')
  const answer = server.complete('recover-history', 'recovered output')
  answer.parts.unshift({ id: 'prt_tool', messageID: answer.info.id, sessionID: session.nativeSessionId, type: 'tool', tool: 'bash', state: { status: 'completed', input: {}, output: 'tests passed' } })
  const restarted = manager(server)
  await restarted.attachSession(session, { request: request(), environment: environment() })
  const first = await restarted.history(session)
  const second = await restarted.history(session)
  assert.deepEqual(first.events.map((event) => event.payload.nativeEventId), second.events.map((event) => event.payload.nativeEventId))
  assert(first.events.some((event) => object(event.payload.part).type === 'tool'))
  assert(JSON.stringify(first.events).includes('recovered output'))
})

it('[F22] inspects ordered native config objects and trusted unresolved provenance without exposing secrets', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  await sessionFor(native)
  server.config = { mcp: { 'graphql': { type: 'remote', url: 'http://127.0.0.1:4100/mcp/app', oauth: false, headers: { authorization: 'Bearer RESOLVED_SECRET_CANARY' } } },
    permission: { '*': 'ask', bash: { '*': 'deny', 'git status': 'allow' } } }
  server.mcp = { 'graphql': { status: 'connected' } }
  server.mcpCredentialReferences = { 'graphql': 'GRAPHQL_MCP_TOKEN' }
  const inspection = await native.inspectNativeMcp('/workspace/project')
  assert.equal(inspection.credentialEnvironmentVariable, 'GRAPHQL_MCP_TOKEN')
  assert.equal(inspection.policyScope, 'base_configuration_only')
  assert.deepEqual(inspection.baseConfigurationFilters, [
    { permission: '*', pattern: '*', effect: 'ask' }, { permission: 'bash', pattern: '*', effect: 'deny' }, { permission: 'bash', pattern: 'git status', effect: 'allow' },
  ])
  assert(!JSON.stringify(inspection).includes('RESOLVED_SECRET_CANARY'))
  server.mcpCredentialReferences = {}
  assert.equal((await native.inspectNativeMcp('/workspace/project')).credentialEnvironmentVariable, null)
})

it('[F23] qualifies out questions in the ordered native policy and explicitly rejects descendant question waits', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  assert.deepEqual((server.sessionInfos.get(session.nativeSessionId)!.permission as unknown[]).at(-1), { permission: 'question', pattern: '*', action: 'deny' })
  server.onPrompt = (id) => {
    server.addSession('ses_question_child', id)
    server.statuses.set('ses_question_child', { type: 'busy' })
    server.questions = [{ id: 'que_one', sessionID: 'ses_question_child', questions: [] }]
    server.emit('question.asked', { id: 'que_one', sessionID: 'ses_question_child', questions: [] })
  }
  await collect(native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'question' }))
  assert.equal((await native.reconcile(session, 'question')).terminalResult?.error?.code, 'OPENCODE_QUESTION_UNSUPPORTED')
  assert(server.calls.some((call) => call.path.startsWith('/question/que_one/reject')))
  assert(server.calls.some((call) => call.path.startsWith('/session/ses_question_child/abort')))
})

it('[F23] keeps an unsupported-question turn fenced until its owned busy child is quiescent', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.onPrompt = id => {
    server.addSession('ses_question_child', id)
    server.statuses.set('ses_question_child', { type: 'busy' })
    server.questions = [{ id: 'que_one', sessionID: 'ses_question_child' }]
    throw new Error('lost ACK after persisting the root')
  }
  server.beforeRequest = path => path.startsWith('/session/ses_question_child/abort') ? json(false) : undefined
  try {
    await assert.rejects(collect(native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'question-incomplete' })))
    const history = await native.reconcile(session, 'question-incomplete')
    assert.equal(history.terminalResult, undefined)
    assert.equal(server.questions.length, 0)
    assert.deepEqual(server.statuses.get('ses_question_child'), { type: 'busy' })
    await assert.rejects(collect(native.startTurn(session, { prompt: 'next', clientCorrelationId: 'next-turn' })), errorCode('OPENCODE_SESSION_BUSY'))
    assert.equal(server.calls.filter(call => call.path.includes('/prompt_async')).length, 1)
    server.statuses.delete('ses_question_child')
    assert.equal((await native.reconcile(session, 'question-incomplete')).terminalResult?.error?.code, 'OPENCODE_QUESTION_UNSUPPORTED')
  } finally { await native.dispose() }
})

it('[F26] requires evidence for every named variant and represents no selection with an empty string', async () => {
  const server = new FixtureServer()
  server.providers = { all: [{ id: 'opencode-go', models: { 'deepseek-v4.1-flash': { variants: {} } } }] }
  await assert.rejects(sessionFor(manager(server)), errorCode('OPENCODE_MODEL_UNAVAILABLE'))
  const noVariant = configuration(); noVariant.variant = ''
  const native = manager(server)
  const session = await sessionFor(native, noVariant)
  server.onPrompt = () => { server.complete('no-variant') }
  await collect(native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'no-variant' }))
  assert(!Object.hasOwn(server.calls.find((call) => call.path.includes('/prompt_async'))!.body!, 'variant'))
})

it('[F27] bounds transient event and identity state while older authoritative history stays pageable', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.onPrompt = () => {
    for (let index = 0; index < 800; index += 1) server.emit('message.part.updated', { part: {
      id: `prt_event_${index}`, type: 'text', sessionID: session.nativeSessionId, text: 'x'.repeat(1_024),
    } }, `evt_${index}`)
    server.complete('long')
  }
  await collect(native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'long' }))
  const state = (native as unknown as { sessions: Map<string, { events: unknown[]; eventIds: Set<string>; historyIds: Set<string>; partTypes: Map<string, string>; pendingIds: Set<string>; eventBytes: number }> }).sessions.get(session.nativeSessionId)!
  assert(state.events.length <= OPENCODE_EVENT_LIMIT)
  for (const collection of [state.eventIds, state.historyIds, state.partTypes, state.pendingIds]) assert(collection.size <= OPENCODE_ID_LIMIT)
  assert(state.eventBytes <= 512_000)
  for (let index = 0; index < 100; index += 1) { server.user(`old-${index}`); server.complete(`old-${index}`) }
  const page = await native.history(session)
  assert(page.nextCursor)
  const older = await native.historyPage(session, page.nextCursor)
  assert(older.events.length > 0)
  assert.notEqual(older.events[0]?.payload.nativeEventId, page.events[0]?.payload.nativeEventId)
  assert.equal((await native.reconcile(session, 'long')).terminalResult?.outcome, 'succeeded')
})

it('validates exact native approval option identity and rejects forged semantics before dispatch', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.permissions = [permission('per_exact')]
  const option = (await native.pending(session))!.responseOptions[0]!
  await assert.rejects(native.respond(session, 'per_exact', { ...option, label: 'forged' }), errorCode('OPENCODE_PERMISSION_OPTION_INVALID'))
  assert.equal(server.calls.filter((call) => call.path.includes('/reply')).length, 0)
})

it('uses the explicit application Operator directory without process.cwd fallback', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  await native.createSession({ kind: 'operator', correlationId: 'conversation-1', workingDirectory: '/runtime/operator',
    configuration: { id: 'operator-config-1', operatorId: 'agent-1', version: 1, harness: configuration(), contentHash: 'sha256:operator', createdAt: '2026-09-16T00:00:00.000Z' },
    environment: { agentId: 'agent-1', variables: {} },
  })
  assert(server.calls.some((call) => call.path === '/session?directory=%2Fruntime%2Foperator'))
  assert(!server.calls.some((call) => new URL(call.path, 'http://fixture.invalid').searchParams.get('directory') === process.cwd()))
})

it('keeps a multi-session server until the final idle session closes', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const first = await sessionFor(native)
  const second = await sessionFor(native)
  await native.close(first)
  assert.equal(server.disposals, 0)
  await native.close(second)
  assert.equal(server.disposals, 1)
})

it('supports explicit native auto but still refuses unsupported live API versions', async () => {
  const server = new FixtureServer(), native = manager(server)
  try {
    const auto = configuration(); auto.autoApprove = true
    const session = await sessionFor(native, auto)
    server.permissions = [permission('automatic', session.nativeSessionId)]
    assert.deepEqual(await native.pendingAll(session), [])
    assert.deepEqual(server.calls.find((call) => call.path.startsWith('/permission/automatic/reply'))?.body, { reply: 'once' })
  } finally { await native.dispose() }
  server.expectedVersion = '1.18.30'
  await assert.rejects(sessionFor(manager(server)), errorCode('OPENCODE_SERVER_VERSION_UNQUALIFIED'))
})

it('rejects wrong-owner credentials before native launch and unsupported scoped binding', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  await assert.rejects(native.createSession({ request: request(), environment: { agentId: 'other-owner', variables: {} } }), errorCode('OPENCODE_SESSION_OWNER_MISMATCH'))
  assert.equal(server.restartEnvironments.length, 0)
  const unsupported = new FixtureServer()
  Object.defineProperty(unsupported, 'restart', { value: undefined })
  await assert.rejects(sessionFor(manager(unsupported)), errorCode('OPENCODE_SERVER_RESTART_UNSUPPORTED'))
  assert.equal(unsupported.calls.length, 0)
})

it('[F04] a later completed message cannot conceal earlier running tool work in the same turn', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  const root = server.user('earlier-tool')
  server.assistant(String(root.info.id), 'starting', 'tool-calls').parts.push({ type: 'tool', state: { status: 'running' } })
  server.assistant(String(root.info.id), 'not authoritative while tool remains active')
  assert.notEqual((await native.reconcile(session, 'earlier-tool')).terminalResult?.outcome, 'succeeded')
})

it('[F06] native overflow media replay retains correlation after file-to-text replacement', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  const root = server.user('media-replay')
  root.parts.push({ type: 'file', mime: 'image/png', filename: 'diagram.png', url: 'data:image/png;base64,fixture' })
  server.assistant(String(root.info.id), 'will continue', 'tool-calls')
  server.append({ info: { id: 'msg_media_compact', role: 'user', sessionID: session.nativeSessionId }, parts: [{ type: 'compaction', auto: true, overflow: true }] })
  server.assistant('msg_media_compact', 'summary').info.summary = true
  server.append({ info: { ...root.info, id: 'msg_media_replay' }, parts: [
    { ...root.parts[0], messageID: 'msg_media_replay' }, { type: 'text', text: '[Attached image/png: diagram.png]' },
  ] })
  server.assistant('msg_media_replay', 'recovered after media compaction')
  assert.deepEqual((await native.reconcile(session, 'media-replay')).terminalResult?.output, { text: 'recovered after media compaction' })
})

it('[F10,F11] a pre-bound controller cannot be reused under another logical owner', () => {
  const server = new FixtureServer()
  Object.defineProperty(server, 'ownerAgentId', { value: 'different-agent' })
  assert.throws(() => manager(server), errorCode('OPENCODE_CREDENTIAL_OWNER_MISMATCH'))
})

it('[F07,F08] explicit native cancellation returns the shared canceled outcome', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await sessionFor(native)
  server.onPrompt = (id) => { server.emit('message.updated', { sessionID: id }) }
  const iterator = native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'cancel-outcome' })[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.return?.()
  assert.equal(await native.cancel(session), true)
  assert.deepEqual((await native.reconcile(session, 'cancel-outcome')).terminalResult, { outcome: 'canceled' })
})
