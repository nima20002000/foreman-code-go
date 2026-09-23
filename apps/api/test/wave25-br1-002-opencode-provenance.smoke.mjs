/* global structuredClone */
// Run from apps/api: node --experimental-transform-types --test test/wave25-br1-002-opencode-provenance.smoke.mjs
// Dependency-free checks of the actual adapter provenance decoder, not SQL or a provider run.
import assert from 'node:assert/strict'
import { normalizedHistory, nativeMessageId, OpenCodeTurnHistory } from '../src/modules/harnesses/opencodeProtocol.ts'
import { test } from 'node:test'
import { OPENCODE_RECONCILIATION_EVENT, openCodeReconciliationPayload,
  readOpenCodeReconciliation, matchesOpenCodeHistorySource } from '../src/modules/harnesses/opencodeReconciliation.ts'

function fixture() {
  const session = { harness: 'opencode', providerVersion: '1.18.31', nativeSessionId: 'ses_worker' }
  const expected = { ownerAgentId: 'worker', correlationId: 'execution:execution-one',
    nativeTurnId: 'msg_submitted_user', nativeSessionId: session.nativeSessionId, providerVersion: session.providerVersion }
  const info = { id: 'msg_terminal_assistant', parentID: expected.nativeTurnId, sessionID: session.nativeSessionId,
    role: 'assistant', time: { created: 10, completed: 30 }, finish: 'stop' }
  const raw = normalizedHistory([{ info, parts: [] }], false)[0]
  const payload = openCodeReconciliationPayload(session, expected.ownerAgentId, expected.correlationId,
    expected.nativeTurnId, raw, 'succeeded')
  assert(payload)
  const marker = { type: OPENCODE_RECONCILIATION_EVENT, connectionId: 'actual-adapter-stream', sequence: 9,
    occurredAt: new Date(40).toISOString(), payload }
  return { session, expected, raw, marker }
}

test('BR1-002: a distinct adapter observation references unchanged OpenCode history, not a Codex terminal', () => {
  const { expected, raw, marker } = fixture(), before = structuredClone(raw)
  const proof = readOpenCodeReconciliation(marker, expected)
  assert(proof)
  assert(matchesOpenCodeHistorySource(proof, raw))
  assert.deepEqual(raw, before)
  assert.notEqual(raw.connectionId, marker.connectionId)
  assert.equal(marker.payload.turnId, undefined)
  assert(!['turn.completed', 'turn/completed'].includes(marker.type))
  assert.equal(readOpenCodeReconciliation(raw, expected), undefined)
})
for (const field of ['ownerAgentId', 'correlationId', 'nativeTurnId', 'nativeSessionId', 'providerVersion']) {
  test(`BR1-002: wrong ${field} cannot qualify the terminal`, () => {
    const { expected, marker } = fixture()
    assert.equal(readOpenCodeReconciliation(marker, { ...expected, [field]: 'another' }), undefined)
  })
}
for (const [name, edit] of [
  ['incomplete history', (p) => { p.historyComplete = false }],
  ['busy before', (p) => { p.statusBefore = 'busy' }],
  ['busy after', (p) => { p.statusAfter = 'busy' }],
  ['pending approval', (p) => { p.pendingInteractions = 1 }],
  ['wrong provider', (p) => { p.provider = 'codex' }],
  ['unknown outcome', (p) => { p.outcome = 'unknown' }],
  ['wrong raw source position', (p) => { p.historySource.sequence = 1 }],
  ['wrong raw event ID', (p) => { p.historySource.nativeEventId = 'part:a:b' }],
]) test(`BR1-002: ${name} stays unqualified`, () => {
  const { expected, marker } = fixture()
  edit(marker.payload.reconciliation)
  assert.equal(readOpenCodeReconciliation(marker, expected), undefined)
})
for (const type of ['permission.replied', 'interaction.pending', 'session.idle', 'server.connected', 'message.part.updated', 'turn.completed']) {
  test(`BR1-002: ${type} is not an OpenCode reconciliation receipt`, () => {
    const { expected, marker } = fixture()
    assert.equal(readOpenCodeReconciliation({ ...marker, type }, expected), undefined)
  })
}
for (const [name, edit] of [
  ['omitted source', (e) => { e.payload.payloadOmitted = true }],
  ['wrong session', (e) => { e.payload.info.sessionID = 'ses_foreign' }],
  ['wrong message', (e) => { e.payload.info.id = 'msg_other' }],
  ['unfinished assistant', (e) => { delete e.payload.info.time.completed }],
  ['tool call', (e) => { e.payload.info.finish = 'tool-calls' }],
  ['summary', (e) => { e.payload.info.summary = true }],
  ['error is not success', (e) => { e.payload.info.error = { name: 'ProviderError' } }],
  ['relabelled source', (e) => { e.connectionId = 'actual-adapter-stream' }],
  ['different content ID', (e) => { e.payload.nativeEventId += '-different' }],
]) test(`BR1-002: ${name} cannot back a successful observation`, () => {
  const { expected, marker, raw } = fixture()
  const proof = readOpenCodeReconciliation(marker, expected)
  edit(raw)
  assert.equal(matchesOpenCodeHistorySource(proof, raw), false)
})
test('BR1-002: failed evidence needs a real native assistant error, not a missing answer', () => {
  const { session, expected, raw } = fixture()
  assert.equal(openCodeReconciliationPayload(session, expected.ownerAgentId, expected.correlationId,
    expected.nativeTurnId, raw, 'failed'), undefined)
  raw.payload.info.error = { name: 'ProviderError', data: { message: 'failed' } }
  const payload = openCodeReconciliationPayload(session, expected.ownerAgentId, expected.correlationId,
    expected.nativeTurnId, raw, 'failed')
  assert(payload)
})
test('BR1-002: history source cannot be disguised as the observation stream', () => {
  const { expected, raw, marker } = fixture()
  marker.connectionId = raw.connectionId
  assert.equal(readOpenCodeReconciliation(marker, expected), undefined)
})

function user(id, parts = [{ type: 'text', text: 'hello' }]) {
  return { info: { id, role: 'user', sessionID: 'ses_worker' }, parts }
}
function assistant(id, parentID, extra = {}, parts = []) {
  return { info: { id, parentID, role: 'assistant', sessionID: 'ses_worker',
    time: { created: 10, completed: 20 }, finish: 'stop', ...extra }, parts }
}
function scan(root, messages) {
  const history = new OpenCodeTurnHistory(root)
  for (const message of [...messages].reverse()) if (history.push(message)) break
  return history
}
test('BR1-002: actual rooted scanner retains the exact selected assistant object', () => {
  const root = user(nativeMessageId('owned-root')), selected = assistant('msg_selected', root.info.id)
  const history = scan(root, [root, selected])
  assert(history.rooted)
  assert.equal(history.result.outcome, 'succeeded')
  assert.equal(history.resultMessageId, selected.info.id)
  assert.equal(history.resultMessage, selected)
})
test('BR1-002: actual compaction scanner retains the continuation, not the summary', () => {
  const root = user(nativeMessageId('owned-root'))
  const compact = user('msg_compact', [{ type: 'compaction', auto: true }])
  const continuation = user('msg_continue', [{ type: 'text', text: 'continue', synthetic: true,
    metadata: { compaction_continue: true } }])
  const summary = assistant('msg_summary', compact.info.id, { summary: true })
  const selected = assistant('msg_selected', continuation.info.id)
  const history = scan(root, [root, assistant('msg_tools', root.info.id, { finish: 'tool-calls' }), compact, summary, continuation, selected])
  assert(history.rooted)
  assert.equal(history.result.outcome, 'succeeded')
  assert.equal(history.resultMessage, selected)
  assert.notEqual(history.resultMessage.info.parentID, root.info.id)
})
for (const [name, extra, parts] of [
  ['unfinished', { time: { created: 10 } }, []],
  ['tool-call', { finish: 'tool-calls' }, []],
  ['pending tool', {}, [{ type: 'tool', state: { status: 'running' } }]],
  ['summary', { summary: true }, []],
]) test(`BR1-002: actual scanner exposes no selected terminal provenance for ${name}`, () => {
  const root = user(nativeMessageId('owned-root'))
  const history = scan(root, [root, assistant('msg_old', root.info.id), assistant('msg_new', root.info.id, extra, parts)])
  assert(history.rooted)
  assert.equal(history.result, undefined)
  assert.equal(history.resultMessage, undefined)
})
test('BR1-002: incomplete page scan cannot expose a terminal source', () => {
  const root = user(nativeMessageId('owned-root')), history = scan(root, [assistant('msg_selected', root.info.id)])
  assert.equal(history.rooted, false)
  assert.equal(history.result, undefined)
  assert.equal(history.resultMessage, undefined)
})
