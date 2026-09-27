/** Dependency-free tests of production projections. Not React, browser geometry or provider proof.
 * node --experimental-strip-types --test apps/web/src/features/conversations/agentChat/F6.regressions.smoke.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentChatFixtures } from '../../../../../../packages/contracts/src/agentChatFixtures.ts'
import { mergeChatMessages } from './model.ts'
import { claimDraftReadback, receiptForCommand } from './receiptReadback.ts'
import { readEarlierChatHistory } from './historyReadback.ts'
import { placeChatActivities } from './activityPlacement.ts'

const base = agentChatFixtures.idleAfterCompletion
const command = () => ({ kind: 'send', clearDraft: true, input: {
  requestId: 'request-1', content: 'Summarize the repository.', intent: 'next_turn', expectedConversationId: base.conversation.id,
  context: { workflowId: base.context.workflowId, workflowNodeId: base.context.workflowNodeId, agentId: base.context.agentId },
} })
for (const delivery of ['queued', 'submitting', 'accepted', 'completed', 'canceled']) {
  test(`B-R01: ${delivery} readback reconciles the exact submitted draft once`, () => {
    const submitted = command(), state = { ...base, turns: [{ ...base.turns[0], delivery }] }
    const receipt = receiptForCommand(state, submitted)
    assert.equal(receipt.delivery, delivery)
    assert.equal(claimDraftReadback(submitted, receipt), true)
    // Polling/reopen with the same retained mutation must not erase a later equal-text draft.
    assert.equal(claimDraftReadback(submitted, receiptForCommand({ ...state, revision: state.revision + 1 }, submitted)), false)
  })
}
for (const delivery of ['unknown', 'failed']) test(`B-R01: ${delivery} readback preserves the draft even outside the message cut`, () => {
  const submitted = command(), state = { ...base, messages: [], turns: [{ ...base.turns[0], delivery }] }
  const receipt = receiptForCommand(state, submitted)
  assert.equal(receipt.delivery, delivery)
  assert.equal(claimDraftReadback(submitted, receipt), false)
  assert.equal(claimDraftReadback(submitted, { ...receipt, delivery: 'completed' }), true)
})
test('B-R01: a neighboring request, context or conversation cannot reconcile a draft', () => {
  const submitted = command()
  assert.equal(receiptForCommand({ ...base, turns: [{ ...base.turns[0], requestId: 'another-request' }] }, submitted), undefined)
  for (const field of ['workflowId', 'workflowNodeId', 'agentId', 'runId']) {
    assert.equal(receiptForCommand({ ...base, context: { ...base.context, [field]: 'another-selection' } }, submitted), undefined)
  }
  assert.equal(receiptForCommand({ ...base, conversation: { ...base.conversation, id: 'another-chat' } }, submitted), undefined)
  assert.equal(claimDraftReadback(submitted, { ...base.turns[0], requestId: 'another-request' }), false)
  assert.equal(claimDraftReadback({ ...submitted, clearDraft: false }, base.turns[0]), false)
  assert.equal(receiptForCommand(base, { ...submitted, input: { ...submitted.input, expectedConversationId: null } }).requestId, 'request-1')
})
test('B-R01: a changed draft survives expected-content reconciliation', () => {
  const submitted = command()
  let draft = 'An edit made after submitting'
  if (claimDraftReadback(submitted, receiptForCommand(base, submitted)) && draft.trim() === submitted.input.content) draft = ''
  assert.equal(draft, 'An edit made after submitting')
})

// Intentionally opaque ids and absent timestamps: order comes from the server arrays only.
const message = (i) => ({ id: `opaque-${i * 7919 % 65537}`, conversationId: base.conversation.id,
  role: i % 2 ? 'user' : 'assistant', content: `message ${i}`, nativeMessageComplete: true })
const all = Array.from({ length: 200 }, (_, index) => message(index + 1))
test('B-R02: overlapping newest subsets never move ahead of the older state prefix', () => {
  assert.deepEqual(mergeChatMessages(all.slice(150), all.slice(100)), all.slice(100))
  assert.deepEqual(mergeChatMessages([all[0], all[1], all[0]]), all.slice(0, 2))
  assert.deepEqual(mergeChatMessages(all.slice(100, 150), all.slice(150), all.slice(100)), all.slice(100))
  assert.deepEqual(mergeChatMessages(all.slice(50, 100), all.slice(100, 150), all.slice(150), all.slice(100)), all.slice(50))
})
test('B-R02: ordered overlapping windows deduplicate while retaining completed text', () => {
  for (let start = 0; start < 200; start += 13) {
    const window = all.slice(start, Math.min(200, start + 50))
    const merged = mergeChatMessages(window, all)
    assert.deepEqual(merged, all)
  }
  const complete = all.at(-1), partial = { ...complete, content: 'partial', nativeMessageComplete: false }
  assert.deepEqual(mergeChatMessages([complete], [...all.slice(100, -1), partial, partial]), all.slice(100))
})
test('B-R02: one earlier operation crosses the actual 100-state/50-history boundary using returned cursors', async () => {
  const calls = [], pages = []
  const batch = await readEarlierChatHistory(async (before) => {
    calls.push(before)
    const end = before === undefined ? 200 : Number(before) - 1
    const page = { conversationId: base.conversation.id, messages: all.slice(Math.max(0, end - 50), end), nextCursor: end > 50 ? String(end - 49) : null }
    pages.push(page)
    // Every intermediate wire page can be merged without disrupting chronology.
    const merged = mergeChatMessages(...[...pages].reverse().map((item) => item.messages), all.slice(100))
    assert.deepEqual(merged, all.slice(Math.min(100, end - 50)))
    return page
  }, undefined, all[100].id)
  assert.deepEqual(calls, [undefined, '151', '101'])
  assert.equal(batch.pages.length, 3)
  assert.equal(batch.nextCursor, '51')
  assert.deepEqual(mergeChatMessages(...[...batch.pages].reverse().map((page) => page.messages), all.slice(100)), all.slice(50))
})
test('B-R02: a live message between requests does not stop bootstrap or create gaps/duplicates', async () => {
  const server = [...all], calls = []
  let current = all.slice(100)
  const batch = await readEarlierChatHistory(async (before) => {
    calls.push(before)
    if (before === '151') { server.push(message(201)); current = server.slice(-100) }
    const end = before === undefined ? server.length : Number(before) - 1
    return { conversationId: base.conversation.id, messages: server.slice(Math.max(0, end - 50), end), nextCursor: end > 50 ? String(end - 49) : null }
  }, undefined, current[0].id)
  assert.deepEqual(calls, [undefined, '151', '101'])
  assert.deepEqual(mergeChatMessages(...[...batch.pages].reverse().map((page) => page.messages), current), server.slice(50))
})
test('B-R02: an all-new cursorless page is not mistaken for earlier history', async () => {
  const server = [...all, ...Array.from({ length: 60 }, (_, i) => message(i + 201))], calls = []
  const batch = await readEarlierChatHistory(async (before) => {
    calls.push(before)
    const end = before === undefined ? server.length : Number(before) - 1
    return { conversationId: base.conversation.id, messages: server.slice(Math.max(0, end - 50), end), nextCursor: end > 50 ? String(end - 49) : null }
  }, undefined, all[100].id)
  assert.deepEqual(calls, [undefined, '211', '161', '111'])
  assert.equal(batch.nextCursor, '61')
  assert.deepEqual(mergeChatMessages(...[...batch.pages].reverse().map((page) => page.messages), all.slice(100)), server.slice(60))
})
test('B-R02: subsequent earlier operations use one page and stop at exhaustion', async () => {
  const calls = []
  const batch = await readEarlierChatHistory(async (before) => {
    calls.push(before)
    return { conversationId: base.conversation.id, messages: all.slice(0, 50), nextCursor: null }
  }, '51', all[100].id)
  assert.deepEqual(calls, ['51'])
  assert.equal(batch.nextCursor, null)
})
test('B-R02: nonadvancing cursors fail instead of looping forever', async () => {
  await assert.rejects(readEarlierChatHistory(async () => ({ conversationId: base.conversation.id, messages: [], nextCursor: '51' }), '51', all[100].id), /did not advance/)
})
test('B-R03: a history denial during bootstrap is propagated, not swallowed as an overlap page', async () => {
  const denied = new Error('FORBIDDEN')
  const calls = []
  await assert.rejects(readEarlierChatHistory(async (before) => {
    calls.push(before)
    if (before) throw denied
    return { conversationId: base.conversation.id, messages: all.slice(150), nextCursor: '151' }
  }, undefined, all[100].id), (error) => error === denied)
  assert.deepEqual(calls, [undefined, '151'])
})

const activity = (id, requestId, sequence) => ({ id, requestId, sequence, revision: 1, kind: 'tool', title: id, status: 'completed' })
test('B-R04: tool-heavy completed turns put all their activity before their own final reply', () => {
  const messages = [], activities = []
  for (let i = 1; i <= 3; i++) {
    messages.push({ ...message(i * 2 - 1), requestId: `r${i}` }, { ...message(i * 2), requestId: `r${i}` })
    for (let j = 1; j <= 24; j++) activities.push(activity(`tool-${i}-${j}`, `r${i}`, String((i - 1) * 24 + j)))
  }
  const placed = placeChatActivities(messages, activities)
  assert.equal(placed.earlier.length, 0)
  assert.equal(placed.trailing.length, 0)
  assert.equal(placed.after.size, 0)
  for (let i = 1; i <= 3; i++) assert.equal(placed.before.get(messages[i * 2 - 1].id).length, 24)
})
test('B-R04: explicit activity boundaries, failed-turn tails and requestless history do not trail later replies', () => {
  const messages = [
    { ...message(1), requestId: 'old' },
    { ...message(2), requestId: 'old', afterActivitySequence: '9007199254740992' },
    { ...message(3), requestId: 'new' },
    { ...message(4), requestId: 'new' },
  ]
  const entries = [activity('at-boundary', 'old', '9007199254740992'), activity('old-tail', 'old', '9007199254740993'),
    activity('not-loaded', 'outside', '1'), activity('new-tool', 'new', '9007199254740994')]
  const placed = placeChatActivities(messages, entries)
  assert.deepEqual(placed.before.get(messages[1].id), [entries[0]])
  assert.deepEqual(placed.after.get(messages[1].id), [entries[1]])
  assert.deepEqual(placed.earlier, [entries[2]])
  assert.deepEqual(placed.before.get(messages[3].id), [entries[3]])
  assert.equal(placed.trailing.length, 0)
})
test('B-R04: only activity of a genuinely active request with no message anchor goes at the bottom', () => {
  const current = activity('current', 'current-request', '2'), older = activity('old', 'old-request', '1')
  const placed = placeChatActivities([], [older, current], 'current-request')
  assert.deepEqual(placed.earlier, [older])
  assert.deepEqual(placed.trailing, [current])
})
