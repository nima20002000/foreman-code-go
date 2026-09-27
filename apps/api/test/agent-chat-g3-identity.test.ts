import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'vitest'
import type { AgentChatTurn, SendAgentChatMessageRequest } from '@graphql/contracts/agent-chat'

import { agentChatInputHash, agentChatKey } from '../src/modules/conversations/agentChatRepository.js'
import { context, fixture } from './helpers/agentChatF1.js'

type Fixture = ReturnType<typeof fixture>

/** Pre-F1 (a8c4ebe) hashed exactly these three fields, even for targeted commands. */
function legacyHash(input: SendAgentChatMessageRequest) {
  return createHash('sha256').update(JSON.stringify([input.content, input.intent, input.context])).digest('hex')
}

function seed(f: Fixture, input: SendAgentChatMessageRequest, options: {
  legacy: boolean; delivery?: AgentChatTurn['delivery']; target?: string | null
}) {
  const now = new Date()
  const messageId = `message-${input.requestId}`
  const target = options.target === undefined ? input.expectedNativeTurnId ?? null : options.target
  // Exact retained pre-F1 shape: content-only payload, no hash-version or original request object.
  f.store.turns.set(input.requestId, { request_id: input.requestId, turn_sequence: '1', intent: input.intent,
    delivery: options.delivery ?? 'completed', message_id: messageId, native_turn_id: target,
    target_native_turn_id: target, delivery_error: null,
    input_hash: options.legacy ? legacyHash(input) : agentChatInputHash(input), payload: { content: input.content },
    created_at: now, updated_at: now })
  f.store.messages.set(messageId, { id: messageId, conversationId: f.store.row.id, role: 'user',
    requestId: input.requestId, content: input.content, createdAt: now.toISOString(), updatedAt: now.toISOString() })
  // Replays must use the receipt's historical target, not this later active owner.
  f.store.row.active_request_id = 'later'; f.store.row.active_native_turn_id = 'turn-later'; f.store.row.turn_state = 'active'
  f.manager.active = 'later'
}

function unchanged(f: Fixture, before: { turns: unknown; messages: unknown; row: unknown }) {
  assert.deepEqual(f.store.turns, before.turns)
  assert.deepEqual(f.store.messages, before.messages)
  assert.deepEqual(f.store.row, before.row)
  assert.deepEqual(f.store.statements.filter(({ sql }) => /^(insert|update|delete)\b/.test(sql)), [])
  assert.deepEqual(f.manager.starts, []); assert.deepEqual(f.manager.steers, []); assert.deepEqual(f.manager.cancels, [])
}
function snapshot(f: Fixture) {
  return structuredClone({ turns: f.store.turns, messages: f.store.messages, row: f.store.row })
}

describe('G3 receipt identity (production repository with scripted SQL, not PostgreSQL)', () => {
  for (const delivery of ['submitting', 'unknown', 'accepted', 'completed', 'failed', 'canceled'] as const) {
    it(`A2-PF-08: pre-F1 targeted steer replays its ${delivery} receipt after service reconstruction without writes or resend`, async () => {
      const original = fixture()
      const input = original.request('legacy-steer', { intent: 'steer', content: 'keep the original target', expectedNativeTurnId: 'turn-A' })
      seed(original, input, { legacy: true, delivery })
      await original.service.shutdown()
      const f = fixture(original.store)
      const before = snapshot(f)
      try {
        for (let retry = 0; retry < 2; retry++) {
          const result = await f.service.send(f.principal, context.workspaceId, input)
          assert.equal(result.replayed, true)
          assert.equal(result.turn.requestId, input.requestId)
          assert.equal(result.turn.delivery, delivery)
          assert.equal(result.turn.targetNativeTurnId, 'turn-A')
          assert.equal(result.turn.messageId, 'message-legacy-steer')
        }
        unchanged(f, before)
      } finally { await f.service.shutdown() }
    })
  }

  for (const legacy of [true, false]) {
    it(`A-R05: ${legacy ? 'legacy' : 'current'} steer replay conflicts on a changed or omitted target, text, or intent`, async () => {
      const f = fixture()
      const input = f.request('steer', { intent: 'steer', expectedNativeTurnId: 'turn-A' })
      seed(f, input, { legacy })
      const before = snapshot(f)
      try {
        for (const change of [
          { expectedNativeTurnId: 'turn-later' }, { expectedNativeTurnId: undefined },
          { content: 'different instruction' }, { intent: 'next_turn' as const },
        ]) {
          await assert.rejects(f.service.send(f.principal, context.workspaceId, { ...input, ...change }),
            { code: 'AGENT_CHAT_REQUEST_CONFLICT' })
        }
        const exact = await f.service.send(f.principal, context.workspaceId, input)
        assert.equal(exact.replayed, true); assert.equal(exact.turn.targetNativeTurnId, 'turn-A')
        unchanged(f, before)
      } finally { await f.service.shutdown() }
    })
  }

  it('A-R05: a changed context does not qualify for legacy comparison', async () => {
    const f = fixture()
    const input = f.request('steer', { intent: 'steer', expectedNativeTurnId: 'turn-A' })
    seed(f, input, { legacy: true })
    const before = snapshot(f)
    try {
      const changed = { ...input, context: { ...input.context, workflowNodeId: 'other-node' } }
      await assert.rejects(f.repository.admit({ key: agentChatKey({ ...context, workflowNodeId: 'other-node' }),
        context: { ...context, workflowNodeId: 'other-node' }, request: changed, delivery: 'queued' }),
      { code: 'AGENT_CHAT_REQUEST_CONFLICT' })
      unchanged(f, before)
    } finally { await f.service.shutdown() }
  })

  it('A2-PF-08: absent legacy target evidence stays fail-closed; current ownership cannot fill the gap', async () => {
    const f = fixture()
    const input = f.request('legacy-steer', { intent: 'steer', expectedNativeTurnId: 'turn-later' })
    seed(f, input, { legacy: true, target: null })
    const before = snapshot(f)
    try {
      await assert.rejects(f.service.send(f.principal, context.workspaceId, input), { code: 'AGENT_CHAT_REQUEST_CONFLICT' })
      unchanged(f, before)
    } finally { await f.service.shutdown() }
  })

  it('A2-PF-08 unresolved data case: pre-F1 urgent sends lost their target, so neither claimed target is guessed', async () => {
    const f = fixture()
    const input = f.request('legacy-urgent', { intent: 'interrupt_and_send', expectedNativeTurnId: 'turn-A' })
    // a8c4ebe sendMessage omitted targetNativeTurnId when calling admit for urgent sends.
    seed(f, input, { legacy: true, target: null })
    const before = snapshot(f)
    try {
      for (const expectedNativeTurnId of ['turn-A', 'turn-later']) {
        await assert.rejects(f.service.send(f.principal, context.workspaceId, { ...input, expectedNativeTurnId }),
          { code: 'AGENT_CHAT_REQUEST_CONFLICT' })
      }
      unchanged(f, before)
    } finally { await f.service.shutdown() }
  })

  it('A-R05: an untargeted current urgent receipt cannot acquire a supplied precondition on replay', async () => {
    const f = fixture()
    f.store.row.active_request_id = 'A'; f.store.row.active_native_turn_id = 'turn-A'
    const input = f.request('urgent', { intent: 'interrupt_and_send' })
    try {
      await f.repository.admit({ key: agentChatKey(context), context, request: input, delivery: 'queued' })
      assert.equal(f.store.turns.get('urgent')!.target_native_turn_id, 'turn-A')
      f.store.statements.length = 0
      const before = snapshot(f)
      await assert.rejects(f.service.send(f.principal, context.workspaceId, { ...input, expectedNativeTurnId: 'turn-A' }),
        { code: 'AGENT_CHAT_REQUEST_CONFLICT' })
      assert.equal((await f.service.send(f.principal, context.workspaceId, input)).replayed, true)
      unchanged(f, before)
    } finally { await f.service.shutdown() }
  })

  it('A-R05: new steers require the caller target and recheck it at repository admission', async () => {
    const f = fixture()
    f.store.row.active_request_id = 'A'; f.store.row.active_native_turn_id = 'turn-A'; f.manager.active = 'A'
    const before = snapshot(f)
    try {
      for (const expectedNativeTurnId of [undefined, 'stale']) {
        await assert.rejects(f.send('new-steer', { intent: 'steer', expectedNativeTurnId }), { code: 'AGENT_CHAT_TURN_NOT_ACTIVE' })
      }
      const admit = f.repository.admit.bind(f.repository)
      f.repository.admit = async (input) => {
        f.store.row.active_request_id = 'B'; f.store.row.active_native_turn_id = 'turn-B'
        return admit(input)
      }
      await assert.rejects(f.send('raced-steer', { intent: 'steer', expectedNativeTurnId: 'turn-A' }),
        { code: 'AGENT_CHAT_TURN_NOT_ACTIVE' })
      // Only the test's simulated concurrent owner change is allowed.
      f.store.row.active_request_id = 'A'; f.store.row.active_native_turn_id = 'turn-A'
      unchanged(f, before)
    } finally { await f.service.shutdown() }
  })

  it('A-R05: legacy replay still requires both write and transcript-read authority before database access', async () => {
    const f = fixture()
    const input = f.request('legacy-steer', { intent: 'steer', expectedNativeTurnId: 'turn-A' })
    seed(f, input, { legacy: true })
    const before = snapshot(f)
    try {
      for (const actions of [['agent_chat:read'] as const, ['agent_chat:write'] as const]) {
        const principal = { ...f.principal, grants: [{ scope: { workspaceIds: [context.workspaceId] }, actions: [...actions] }] }
        await assert.rejects(f.service.send(principal, context.workspaceId, input), { code: 'ACCESS_DENIED' })
      }
      assert.equal(f.store.statements.length, 0)
      unchanged(f, before)
    } finally { await f.service.shutdown() }
  })
})
