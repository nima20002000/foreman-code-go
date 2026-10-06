import assert from 'node:assert/strict'
import { it } from 'vitest'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import { nativeMessageId, object, OPENCODE_HISTORY_PAGE_SIZE } from '../src/modules/harnesses/opencodeProtocol.js'
import { OPENCODE_RECONCILIATION_EVENT, readOpenCodeReconciliation,
  matchesOpenCodeHistorySource } from '../src/modules/harnesses/opencodeReconciliation.js'
import { FixtureServer, manager, sessionFor, permission, request, environment } from './opencode-fixtures.js'

// Actual OpenCode manager + HTTP/SSE-shaped port. No Codex events, direct native
// evidence insertion, model response synthesis, or implicit retry is used here.
function marker(events: readonly NativeHarnessEvent[]) {
  const eventsOfType = events.filter((event) => event.type === OPENCODE_RECONCILIATION_EVENT)
  assert.equal(eventsOfType.length, 1)
  return eventsOfType[0]!
}
const prompts = (server: FixtureServer) => server.calls.filter((call) => call.path.includes('/prompt_async'))
const replies = (server: FixtureServer) => server.calls.filter((call) => /^\/permission\/[^/]+\/reply/.test(call.path))
async function startAndDetach(native: ReturnType<typeof manager>, session: Awaited<ReturnType<typeof sessionFor>>, correlationId: string) {
  for await (const event of native.startTurn(session, { prompt: 'hello', clientCorrelationId: correlationId }, AbortSignal.timeout(3_000))) return event
  throw new Error('Expected a real user-message event after submission')
}

it('BR1-002: real OpenCode permission -> exact response -> lost-terminal history yields one stable observation', async () => {
  const server = new FixtureServer(), native = manager(server), correlationId = 'execution:br1-002-worker'
  const session = await sessionFor(native)
  const live: NativeHarnessEvent[] = []
  server.onPrompt = (sessionID, body) => {
    const assistant = server.assistant(String(body.messageID), 'Calling a tool', 'tool-calls', true, sessionID)
    const ask = { ...permission('per_exact', sessionID), tool: { messageID: String(assistant.info.id), callID: 'call_exact' } }
    server.permissions = [ask]
    server.emit('permission.asked', ask)
  }
  try {
    for await (const event of native.startTurn(session, { prompt: 'hello', clientCorrelationId: correlationId }, AbortSignal.timeout(3_000))) {
      live.push(event)
      if (event.type === 'interaction.pending') break
    }
    const pending = (await native.pendingAll(session))[0]!
    assert(pending)
    assert.equal(pending.turn.nativeTurnId, nativeMessageId(correlationId))
    assert.notEqual(object(object(pending.request).tool).messageID, pending.turn.nativeTurnId)
    assert.equal(pending.turn.nativeRequestId, 'per_exact')
    const option = pending.responseOptions.find((entry) => entry.semantic === 'approve_once')!
    await native.respond(session, pending.turn.nativeRequestId!, option)
    // Persisted provider completion with NO live terminal notification.
    const completed = server.assistant(nativeMessageId(correlationId), 'done', 'stop', true, session.nativeSessionId)
    server.statuses.delete(session.nativeSessionId)
    const [history, concurrent] = await Promise.all([native.reconcile(session, correlationId), native.reconcile(session, correlationId)])
    assert.deepEqual(marker(concurrent.events), marker(history.events))
    assert.equal(history.terminalTurn?.providerId, nativeMessageId(correlationId))
    assert.equal(history.terminalTurn?.result.outcome, 'succeeded')
    assert.equal(history.pendingInteractions.length, 0)
    assert.equal(history.responseDeliveries?.length, 1)
    const receipt = marker(history.events)
    assert.equal(receipt.connectionId, live[0]!.connectionId)
    assert(receipt.sequence > live.at(-1)!.sequence)
    const proof = readOpenCodeReconciliation(receipt, { ownerAgentId: 'agent-1', correlationId,
      nativeSessionId: session.nativeSessionId, nativeTurnId: nativeMessageId(correlationId), providerVersion: session.providerVersion })!
    assert(proof)
    assert.equal(proof.terminalMessageId, completed.info.id)
    const raw = history.events.find((event) => event.connectionId === proof.historySource.connectionId)!
    assert(matchesOpenCodeHistorySource(proof, raw))
    assert(raw.connectionId!.startsWith('history-'))
    assert.notEqual(raw.connectionId, receipt.connectionId)
    assert(history.events.every((event) => !['turn.completed', 'turn/completed'].includes(event.type)))
    for (let repeat = 0; repeat < 3; repeat++) assert.deepEqual(marker((await native.reconcile(session, correlationId)).events), receipt)
    assert.equal(prompts(server).length, 1)
    assert.equal(replies(server).length, 1)
  } finally { await native.dispose() }
})

it('BR1-002: a lost review terminal notification uses the original adapter stream, not a rewritten raw source', async () => {
  const server = new FixtureServer(), native = manager(server), correlationId = 'review:br1-002'
  const session = await sessionFor(native)
  let first: NativeHarnessEvent | undefined
  try {
    for await (const event of native.startTurn(session, { prompt: 'review the exact request', clientCorrelationId: correlationId }, AbortSignal.timeout(3_000))) {
      first = event
      break
    }
    assert(first)
    server.assistant(nativeMessageId(correlationId), 'decision recorded', 'stop', true, session.nativeSessionId)
    server.statuses.delete(session.nativeSessionId)
    const history = await native.reconcile(session, correlationId)
    const receipt = marker(history.events)
    assert.equal(receipt.connectionId, first.connectionId)
    assert.equal(history.terminalTurn?.result.outcome, 'succeeded')
    assert.equal(prompts(server).length, 1)
    assert.equal(replies(server).length, 0)
  } finally { await native.dispose() }
})

it('BR1-002: an older answer is not promoted past unrelated newer turns', async () => {
  const server = new FixtureServer(), native = manager(server), correlationId = 'paged-target'
  const session = await sessionFor(native)
  try {
    await startAndDetach(native, session, correlationId)
    server.statuses.delete(session.nativeSessionId)
    server.assistant(nativeMessageId(correlationId), 'older answer')
    for (let index = 0; index < OPENCODE_HISTORY_PAGE_SIZE; index++) {
      const other = `other-${index}`
      server.user(other)
      server.assistant(nativeMessageId(other), 'not the requested turn')
    }
    const history = await native.reconcile(session, correlationId)
    assert.equal(history.terminalTurn, undefined)
    assert(!history.events.some((event) => event.type === OPENCODE_RECONCILIATION_EVENT))
    const tuples = history.events.map((event) => JSON.stringify([event.connectionId, event.sequence]))
    assert.equal(new Set(tuples).size, tuples.length)
    assert.equal(prompts(server).length, 1)
  } finally { await native.dispose() }
})

it('BR1-002: the full compaction scan, not a page-local assistant parent guess, selects terminal provenance', async () => {
  const server = new FixtureServer(), native = manager(server), correlationId = 'compaction-target'
  const session = await sessionFor(native)
  try {
    await startAndDetach(native, session, correlationId)
    server.statuses.delete(session.nativeSessionId)
    server.assistant(nativeMessageId(correlationId), 'tool narration', 'tool-calls')
    server.append({ info: { id: 'msg_compact', role: 'user', sessionID: session.nativeSessionId }, parts: [{ type: 'compaction', auto: true }] })
    server.assistant('msg_compact', 'summary').info.summary = true
    server.append({ info: { id: 'msg_continue', role: 'user', sessionID: session.nativeSessionId },
      parts: [{ type: 'text', text: 'Continue', synthetic: true, metadata: { compaction_continue: true } }] })
    const selected = server.assistant('msg_continue', 'finished')
    const receipt = marker((await native.reconcile(session, correlationId)).events)
    const proof = readOpenCodeReconciliation(receipt, { ownerAgentId: 'agent-1', correlationId,
      nativeSessionId: session.nativeSessionId, nativeTurnId: nativeMessageId(correlationId) })!
    assert(proof)
    assert.equal(proof.terminalMessageId, selected.info.id)
    assert.notEqual(selected.info.parentID, proof.nativeTurnId)
  } finally { await native.dispose() }
})

for (const cut of ['busy', 'pending', 'unfinished', 'tool-call'] as const) it(`BR1-002: ${cut} cannot create a reconciliation acknowledgement`, async () => {
  const server = new FixtureServer(), native = manager(server), correlationId = `incomplete-${cut}`
  const session = await sessionFor(native)
  try {
    await startAndDetach(native, session, correlationId)
    server.statuses.delete(session.nativeSessionId)
    server.assistant(nativeMessageId(correlationId), 'text', cut === 'tool-call' ? 'tool-calls' : 'stop', cut !== 'unfinished')
    if (cut === 'busy') server.statuses.set(session.nativeSessionId, { type: 'busy' })
    if (cut === 'pending') server.permissions = [permission('per_pending', session.nativeSessionId)]
    const history = await native.reconcile(session, correlationId)
    assert.equal(history.events.some((event) => event.type === OPENCODE_RECONCILIATION_EVENT), false)
    assert.equal(replies(server).length, 0)
    assert.equal(prompts(server).length, 1)
  } finally { await native.dispose() }
})

it('BR1-002: replacement manager reconciles on a fresh connection without replaying the previous producer', async () => {
  const server = new FixtureServer(), original = manager(server), correlationId = 'generation-hold'
  const session = await sessionFor(original)
  let first: NativeHarnessEvent | undefined
  let replacement: ReturnType<typeof manager> | undefined
  try {
    for await (const event of original.startTurn(session, { prompt: 'hello', clientCorrelationId: correlationId }, AbortSignal.timeout(3_000))) {
      first = event
      break
    }
    assert(first)
    server.assistant(nativeMessageId(correlationId), 'finished')
    server.statuses.delete(session.nativeSessionId)
    replacement = manager(server)
    await replacement.attachSession(session, { request: request(), environment: environment(), correlationId })
    const history = await replacement.reconcile(session, correlationId)
    assert.equal(history.events.some((event) => event.type === OPENCODE_RECONCILIATION_EVENT), true)
    assert(history.events.every((event) => event.connectionId !== first!.connectionId))
    assert.equal(prompts(server).length, 1)
    // This is provider-side provenance evidence, NOT successful graph generation
    // takeover: the unchanged graph correlation fence must reject this stream.
  } finally { await replacement?.dispose(); await original.dispose() }
})

it('BR1-002: upstream SSE cannot impersonate the reserved adapter reconciliation observation', async () => {
  const server = new FixtureServer(), native = manager(server), correlationId = 'reserved-type'
  const session = await sessionFor(native)
  server.onPrompt = (sessionID) => {
    server.emit(OPENCODE_RECONCILIATION_EVENT, { sessionID, reconciliation: { version: 1, historyComplete: true } })
    server.statuses.delete(sessionID)
    server.emit('session.idle', { sessionID })
  }
  try {
    const events: NativeHarnessEvent[] = []
    for await (const event of native.startTurn(session, { prompt: 'hello', clientCorrelationId: correlationId }, AbortSignal.timeout(3_000))) events.push(event)
    assert(events.every((event) => event.type !== OPENCODE_RECONCILIATION_EVENT))
    assert.equal((await native.reconcile(session, correlationId)).terminalResult?.error?.code, 'OPENCODE_TURN_INTERRUPTED')
    assert.equal(prompts(server).length, 1)
  } finally { await native.dispose() }
})

it('BR1-002: unknown permission ancestry does not acquire the current user turn by inference', async () => {
  const server = new FixtureServer(), native = manager(server), correlationId = 'unknown-parent'
  const session = await sessionFor(native)
  server.onPrompt = (sessionID) => { server.permissions = [permission('per_unknown', sessionID)] }
  try {
    await startAndDetach(native, session, correlationId)
    const pending = (await native.pendingAll(session))[0]!
    assert.equal(pending.turn.nativeTurnId, 'msg_tool')
    assert.notEqual(pending.turn.nativeTurnId, nativeMessageId(correlationId))
    assert.equal(object(object(pending.request).tool).messageID, 'msg_tool')
    assert.equal(replies(server).length, 0)
  } finally { await native.dispose() }
})
