/** Dependency-free checks of the actual receipt/retention modules, not React, HTTP or provider tests.
 * Node >=22.16: node --test apps/web/src/features/conversations/agentChat/G5.regressions.smoke.mjs
 * The QueryClient double models only the public cache methods used by these helpers.
 * G5.regressions.test.tsx exercises the real QueryClient and mounted React/MSW path. */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { URL } from 'node:url'

const source = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')
const moduleUrl = (text) => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text)).toString('base64')}`
const receiptUrl = moduleUrl(source('receiptReadback.ts'))
const { claimDraftReadback, receiptForCommand } = await import(receiptUrl)
const { agentChatReadbacksKey, compactAgentChatResult, confirmedCommandReceipt, isRetirableAcknowledgement,
  rememberAgentChatReadback, retireAgentChatAcknowledgements, AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT } = await import(moduleUrl(
  source('commandRecords.ts').replace("from './receiptReadback'", `from '${receiptUrl}'`)))
const context = { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' }
const key = ['agent-chat', 0, JSON.stringify(['agent-chat', 'workspace', 'workflow', 'node', 'agent', null]), 'state']
const commandKey = [...key.slice(0, 3), 'command']
function command(id = 'request', intent = 'next_turn') {
  return { kind: 'send', clearDraft: true, input: { requestId: id, intent, content: `Input ${id}`, expectedConversationId: 'conversation',
    context: { workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' } } }
}
function receipt(id = 'request', delivery = 'completed', intent = 'next_turn') {
  return { requestId: id, messageId: `message-${id}`, sequence: '1', intent, delivery,
    createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:01Z' }
}
function state(turns = []) {
  return { context, conversation: { id: 'conversation' }, turns, messages: [], activities: [], revision: 1 }
}
class QueryClientDouble {
  data = new Map()
  mutations = []
  nextId = 1
  cache = {
    getAll: () => [...this.mutations],
    findAll: ({ mutationKey, exact }) => {
      assert.equal(exact, true)
      return this.mutations.filter((mutation) => JSON.stringify(mutation.options.mutationKey) === JSON.stringify(mutationKey))
    },
    remove: (mutation) => { this.mutations = this.mutations.filter((entry) => entry !== mutation) },
  }
  getMutationCache() { return this.cache }
  getQueryData(queryKey) { return this.data.get(JSON.stringify(queryKey)) }
  setQueryData(queryKey, value) { this.data.set(JSON.stringify(queryKey), value); return value }
  add(input, status = 'error', result, mutationKey = commandKey) {
    const mutation = { mutationId: this.nextId++, options: { mutationKey },
      state: { variables: input, status, data: result, submittedAt: this.nextId, error: status === 'error' ? new Error('HTTP response lost') : null } }
    this.mutations.push(mutation)
    return mutation
  }
  record(mutation) {
    return { command: mutation.state.variables, result: mutation.state.data, status: mutation.state.status,
      error: mutation.state.error, submittedAt: mutation.state.submittedAt,
      readback: this.getQueryData(agentChatReadbacksKey)?.[mutation.mutationId] }
  }
  read(projection) {
    rememberAgentChatReadback(this, key, projection)
    this.setQueryData(key, projection)
  }
}

test('B2-PF-01: provisional steer cannot claim an unchanged draft, including repeated GET/SSE reads', () => {
  const input = command('steer', 'steer'), provisional = receipt('steer', 'submitting', 'steer')
  assert.equal(claimDraftReadback(input, provisional), false)
  assert.equal(claimDraftReadback(input, provisional), false)
  assert.equal(claimDraftReadback(input, undefined), false) // Definite rejection discards it.
})
test('B-R01: provisional steer does not consume the later positive claim; replay cannot clear a newer draft', () => {
  const input = command('accepted-steer', 'steer')
  assert.equal(claimDraftReadback(input, receipt('accepted-steer', 'submitting', 'steer')), false)
  assert.equal(claimDraftReadback(input, receipt('accepted-steer', 'accepted', 'steer')), true)
  assert.equal(claimDraftReadback(input, receipt('accepted-steer', 'completed', 'steer')), false)
})
test('B-R01: a durable next-turn submitting receipt still reconciles once', () => {
  const input = command('next')
  assert.equal(claimDraftReadback(input, receipt('next', 'submitting')), true)
  assert.equal(claimDraftReadback(input, receipt('next', 'completed')), false)
})
test('B-R01: unknown, failed, mismatched and explicitly non-clearing commands never claim a draft', () => {
  for (const delivery of ['unknown', 'failed']) assert.equal(claimDraftReadback(command(), receipt('request', delivery)), false)
  assert.equal(claimDraftReadback(command(), receipt('another-request')), false)
  assert.equal(claimDraftReadback({ ...command(), clearDraft: false }, receipt()), false)
  assert.equal(claimDraftReadback(undefined, receipt()), false)
})
test('B2-PF-02: lost-response terminal readback survives receipt/message eviction without changing HTTP outcome', () => {
  const client = new QueryClientDouble(), mutation = client.add(command())
  client.read(state([receipt()]))
  client.read(state([receipt('newer')]))
  const record = client.record(mutation)
  assert.equal(confirmedCommandReceipt(record, client.getQueryData(key))?.delivery, 'completed')
  assert.equal(record.status, 'error')
  assert.equal(record.result, undefined)
  assert.equal(isRetirableAcknowledgement(record, client.getQueryData(key)), true)
})
test('B-R07: an initial queued success stays retirable after observed completion and eviction', () => {
  const client = new QueryClientDouble()
  const initial = compactAgentChatResult({ state: state([receipt('request', 'queued')]), turn: receipt('request', 'queued'), replayed: false })
  const mutation = client.add(command(), 'success', initial)
  client.read(state([receipt()])); client.read(state())
  assert.equal(client.record(mutation).result.turn.delivery, 'queued')
  assert.equal(confirmedCommandReceipt(client.record(mutation), state())?.delivery, 'completed')
  assert.equal(isRetirableAcknowledgement(client.record(mutation), state()), true)
  assert.deepEqual(Object.keys(initial).sort(), ['conversationId', 'replayed', 'turn'])
})
test('B2-PF-02: pending -> terminal proof -> eviction -> HTTP error retains proof but cannot retire pending work', () => {
  const client = new QueryClientDouble(), mutation = client.add(command(), 'pending')
  client.read(state([receipt()])); client.read(state())
  assert.equal(isRetirableAcknowledgement(client.record(mutation), state()), false)
  mutation.state.status = 'error'
  assert.equal(isRetirableAcknowledgement(client.record(mutation), state()), true)
  assert.equal(confirmedCommandReceipt(client.record(mutation), state())?.delivery, 'completed')
})
test('B-R01: a terminal proof captured between renders can reconcile the unchanged draft after eviction', () => {
  const client = new QueryClientDouble(), mutation = client.add(command('between-renders'))
  client.read(state([receipt('between-renders')]))
  client.read(state([receipt('later')]))
  const record = client.record(mutation), proof = confirmedCommandReceipt(record, client.getQueryData(key))
  assert.equal(claimDraftReadback(record.command, proof), true)
  assert.equal(claimDraftReadback(record.command, proof), false)
})
test('B2-PF-02: nonterminal and unknown evidence is not irreversible terminal proof', () => {
  for (const delivery of ['queued', 'submitting', 'accepted', 'unknown']) {
    const client = new QueryClientDouble(), mutation = client.add(command())
    client.read(state([receipt('request', delivery)])); client.read(state())
    assert.equal(client.record(mutation).readback, undefined)
    assert.equal(isRetirableAcknowledgement(client.record(mutation), state()), false)
  }
})
test('B2-PF-02: completed, failed and canceled errors all retain terminal proof, failed drafts stay untouched', () => {
  for (const delivery of ['completed', 'failed', 'canceled']) {
    const client = new QueryClientDouble(), mutation = client.add(command(delivery))
    client.read(state([receipt(delivery, delivery)])); client.read(state())
    const record = client.record(mutation)
    assert.equal(confirmedCommandReceipt(record, state()).delivery, delivery)
    assert.equal(isRetirableAcknowledgement(record, state()), true)
    if (delivery === 'failed') assert.equal(claimDraftReadback(record.command, record.readback.turn), false)
  }
})
test('B-R07: bounds recovered errors and successes to 20 while unknown, pending, unresolved errors survive', () => {
  const client = new QueryClientDouble()
  const unresolved = client.add(command('unresolved'))
  const unknown = client.add(command('unknown'), 'success', { conversationId: 'conversation', turn: receipt('unknown', 'unknown') })
  const pending = client.add(command('pending'), 'pending')
  const recovered = []
  for (let index = 0; index < AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT + 13; index++) {
    const id = `terminal-${index}`, transport = index % 5 === 0 ? 'success' : 'error'
    const result = transport === 'success' ? { conversationId: 'conversation', turn: receipt(id, 'queued') } : undefined
    recovered.push(client.add(command(id), transport, result))
    client.read(state([receipt(id, ['completed', 'failed', 'canceled'][index % 3])]))
    client.read(state()); retireAgentChatAcknowledgements(client)
  }
  const retained = client.getMutationCache().getAll()
  assert.equal(retained.length, AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT + 3)
  assert.ok(retained.includes(unresolved)); assert.ok(retained.includes(unknown)); assert.ok(retained.includes(pending))
  assert.deepEqual(retained.slice(3), recovered.slice(-AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT))
  assert.equal(Object.keys(client.getQueryData(agentChatReadbacksKey)).length, AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT)
  assert.equal(unresolved.state.variables.input.content, 'Input unresolved')
})
test('B-R07: compact proof is detached from later projection mutation, contains no full snapshot, and retires with its owner', () => {
  const client = new QueryClientDouble(), mutation = client.add(command())
  const terminal = receipt(); terminal.error = { code: 'completed', message: 'Original detail' }
  client.read(state([terminal]))
  terminal.delivery = 'queued'; terminal.error.message = 'Changed detail'
  const proof = client.record(mutation).readback
  assert.deepEqual(Object.keys(proof).sort(), ['conversationId', 'turn'])
  assert.equal(proof.turn.delivery, 'completed')
  assert.equal(proof.turn.error.message, 'Original detail')
  for (const field of ['state', 'messages', 'activities', 'content']) assert.equal(field in proof, false)
  client.cache.remove(mutation); retireAgentChatAcknowledgements(client)
  assert.deepEqual(client.getQueryData(agentChatReadbacksKey), {})
})
test('B2-PF-02: request, selection and conversation fences prevent unrelated proof ingestion/display', () => {
  const client = new QueryClientDouble(), mutation = client.add(command())
  for (const field of ['workflowId', 'workflowNodeId', 'agentId', 'runId']) {
    client.read({ ...state([receipt()]), context: { ...context, [field]: 'another' } })
    assert.equal(client.record(mutation).readback, undefined)
  }
  client.read({ ...state([receipt()]), conversation: { id: 'replacement' } })
  client.read(state([receipt('another-request')]))
  assert.equal(client.record(mutation).readback, undefined)
  client.read(state([receipt()]))
  const record = client.record(mutation)
  assert.equal(confirmedCommandReceipt(record, undefined), undefined)
  assert.equal(confirmedCommandReceipt(record, { ...state(), conversation: { id: 'replacement' } }), undefined)
  assert.equal(confirmedCommandReceipt({ ...record, command: command('another-request') }, state()), undefined)
  assert.equal(confirmedCommandReceipt(record, { ...state(), context: { ...context, runId: 'another-run' } }), undefined)
  assert.equal(receiptForCommand(state([receipt()]), { ...command(), input: { ...command().input, context: undefined } }), undefined)
})
test('B2-PF-02: first-message proof respects the confirmed response conversation and cannot migrate after capture', () => {
  const client = new QueryClientDouble(), first = command(); first.input.expectedConversationId = null
  const mutation = client.add(first, 'success', { conversationId: 'conversation', turn: receipt('request', 'queued') })
  client.read({ ...state([receipt()]), conversation: { id: 'replacement' } })
  assert.equal(client.record(mutation).readback, undefined)
  client.read(state([receipt()]))
  const proof = client.record(mutation).readback
  client.read({ ...state([receipt()]), conversation: { id: 'replacement' } })
  assert.equal(client.record(mutation).readback, proof)
})
test('B2-PF-02: QueryClient, workspace selection key and auth-generation keys isolate proof', () => {
  const client = new QueryClientDouble(), other = new QueryClientDouble(), mutation = client.add(command())
  rememberAgentChatReadback(client, [key[0], 1, key[2], key[3]], state([receipt()]))
  rememberAgentChatReadback(client, [key[0], key[1], 'another-workspace-context', key[3]], state([receipt()]))
  assert.equal(client.record(mutation).readback, undefined)
  client.read(state([receipt()]))
  assert.equal(other.getQueryData(agentChatReadbacksKey), undefined)
})
test('B-R07: successful controls remain bounded; failed controls and unrelated mutations are not retired', () => {
  const client = new QueryClientDouble(), failed = client.add({ kind: 'stop' }, 'error')
  const unrelated = client.add(command('other'), 'success', undefined, ['another-feature'])
  for (let index = 0; index < 30; index++) {
    client.add({ kind: 'stop' }, 'success', { conversationId: 'conversation' })
    retireAgentChatAcknowledgements(client)
  }
  assert.equal(client.mutations.length, AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT + 2)
  assert.ok(client.mutations.includes(failed)); assert.ok(client.mutations.includes(unrelated))
})
