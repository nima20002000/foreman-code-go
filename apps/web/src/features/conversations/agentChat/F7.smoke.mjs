/* global structuredClone */
/** Dependency-free execution of F7's production projection/retention helpers.
 * The small cache facade below is NOT TanStack Query, React, MSW, a browser or a native provider.
 * node --experimental-strip-types --test apps/web/src/features/conversations/agentChat/F7.smoke.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentChatFixtures as fixtures } from '../../../../../../packages/contracts/src/agentChatFixtures.ts'
import { intentUnavailable } from './model.ts'
import {
  AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT, compactAgentChatResult, currentCommandReceipt,
  isRetirableAcknowledgement, retireAgentChatAcknowledgements,
} from './commandRecords.ts'

const key = ['agent-chat', 7, 'selected-context', 'command']
const receipt = (delivery, requestId = 'request-1') => ({ ...fixtures.active.turns[0], requestId, delivery })
const result = (delivery, requestId) => compactAgentChatResult({ state: fixtures.active, turn: receipt(delivery, requestId), replayed: false })
const record = (delivery, requestId, status = 'success', mutationKey = key) => ({
  options: { mutationKey }, state: { status, data: result(delivery, requestId),
    variables: { kind: 'send', input: { requestId, content: `Input ${requestId}` } } },
})
const cacheFacade = () => {
  const records = [], states = new Map()
  const cache = { getAll: () => records.slice(), remove: (entry) => records.splice(records.indexOf(entry), 1) }
  return { records, states, client: { getMutationCache: () => cache, getQueryData: (queryKey) => states.get(JSON.stringify(queryKey)) },
    readback: (state, commandKey = key) => states.set(JSON.stringify([...commandKey.slice(0, 3), 'state']), state) }
}

test('B-R06: resident Codex continuation follows the server fact, not restart assumptions', () => {
  const state = structuredClone(fixtures.idleAfterCompletion)
  state.capabilities.resume = true
  assert.equal(intentUnavailable(state, 'next_turn'), undefined)
  state.capabilities.resume = false
  state.capabilities.unavailable.resume = 'Current continuation is unavailable.'
  assert.equal(intentUnavailable(state, 'next_turn'), 'Current continuation is unavailable.')
})

test('B-R06: post-restart session loss blocks follow-up even with optimistic capability data', () => {
  const state = structuredClone(fixtures.sessionMissing)
  state.capabilities.resume = true
  assert.equal(intentUnavailable(state, 'next_turn'), state.availability.message)
})

test('B-R07: sends retain only conversation/receipt identity, not full message/activity snapshots', () => {
  const wire = { state: structuredClone(fixtures.active), turn: receipt('accepted'), replayed: false }
  const compact = compactAgentChatResult(wire)
  assert.deepEqual(Object.keys(compact).sort(), ['conversationId', 'replayed', 'turn'])
  assert.equal(compact.turn, wire.turn)
  assert.equal(compact.conversationId, wire.state.conversation.id)
  assert.ok(!JSON.stringify(compact).includes('messages'))
  assert.ok(!JSON.stringify(compact).includes('activities'))
})

test('B-R07: successful controls do not retain their state projection', () => {
  assert.deepEqual(compactAgentChatResult({ state: fixtures.active }), { conversationId: fixtures.active.conversation.id })
})

test('B-R07: pending, failed HTTP and every nonterminal receipt keep their input', () => {
  for (const status of ['idle', 'pending', 'error']) assert.equal(isRetirableAcknowledgement({ status, result: result('completed') }), false)
  for (const delivery of ['queued', 'submitting', 'accepted', 'unknown']) {
    assert.equal(isRetirableAcknowledgement({ status: 'success', result: result(delivery) }), false)
  }
  for (const delivery of ['completed', 'failed', 'canceled']) {
    assert.equal(isRetirableAcknowledgement({ status: 'success', result: result(delivery) }), true)
  }
})

test('B-R07: later unknown readback protects an initially accepted command', () => {
  const state = { ...fixtures.active, turns: [receipt('unknown')], messages: [] }
  assert.equal(isRetirableAcknowledgement({ status: 'success', result: result('accepted') }, state), false)
  state.turns = [receipt('completed')]
  assert.equal(isRetirableAcknowledgement({ status: 'success', result: result('unknown') }, state), true)
})

test('B-R07: 200 positively completed commands retain at most 20 terminal records', () => {
  const cache = cacheFacade(), turns = []
  for (let index = 0; index < 200; index++) {
    const requestId = `completed-${index}`
    cache.records.push(record('queued', requestId))
    turns.push(receipt('completed', requestId))
    cache.readback({ ...fixtures.active, turns: turns.slice(-100) })
    retireAgentChatAcknowledgements(cache.client)
    assert.ok(cache.records.length <= AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT)
  }
  assert.deepEqual(cache.records.map((entry) => entry.state.data.turn.requestId),
    Array.from({ length: AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT }, (_, index) => `completed-${180 + index}`))
})

test('B-R07: pruning terminal controls preserves unresolved commands and unrelated mutation keys', () => {
  const cache = cacheFacade()
  const protectedEntries = [record('accepted', 'pending', 'pending'), record('accepted', 'lost-ack', 'error'),
    ...['queued', 'submitting', 'accepted', 'unknown'].map((delivery) => record(delivery, delivery)),
    record('completed', 'other-feature', 'success', ['other', 7, 'selected-context', 'command'])]
  cache.records.push(...protectedEntries)
  for (let index = 0; index < 60; index++) cache.records.push({ options: { mutationKey: key }, state: {
    status: 'success', data: compactAgentChatResult({ state: fixtures.active }), variables: { kind: 'stop', requestId: `control-${index}` },
  } })
  retireAgentChatAcknowledgements(cache.client)
  assert.equal(cache.records.length, protectedEntries.length + AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT)
  for (const entry of protectedEntries) assert.ok(cache.records.includes(entry))
  assert.equal(cache.records.find((entry) => entry.state.data.turn?.delivery === 'unknown').state.variables.input.content, 'Input unknown')
})

test('B-R07: receipt readback is looked up within the command context and session generation', () => {
  const cache = cacheFacade()
  const unresolved = record('accepted', 'request-1')
  cache.records.push(unresolved, ...Array.from({ length: 30 }, (_, index) => record('completed', `done-${index}`)))
  cache.readback({ ...fixtures.active, turns: [receipt('completed')] }, ['agent-chat', 8, 'selected-context', 'command'])
  retireAgentChatAcknowledgements(cache.client)
  assert.ok(cache.records.includes(unresolved))
  assert.equal(cache.records.length, AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT + 1)
})

for (const delivery of ['completed', 'failed', 'canceled', 'unknown']) test(`B-R08: initially queued acknowledgement reads current ${delivery} delivery`, () => {
  const initial = result('queued')
  const state = { ...fixtures.active, turns: [receipt(delivery)] }
  assert.equal(currentCommandReceipt(initial, state).delivery, delivery)
  assert.equal(initial.turn.intent, 'next_turn')
  assert.equal(initial.turn.delivery, 'queued')
})

test('B-R08: absent readback is historical, never a receipt from another conversation or request', () => {
  const initial = result('queued')
  assert.equal(currentCommandReceipt(initial, undefined), undefined)
  assert.equal(currentCommandReceipt(initial, { ...fixtures.active, turns: [] }), undefined)
  assert.equal(currentCommandReceipt(initial, { ...fixtures.active, turns: [receipt('completed', 'other-request')] }), undefined)
  assert.equal(currentCommandReceipt(initial, { ...fixtures.active, conversation: { ...fixtures.active.conversation, id: 'replacement' } }), undefined)
})
