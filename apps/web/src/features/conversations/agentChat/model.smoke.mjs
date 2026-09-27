/** Real pure projection checks on the frozen fixtures. No React, HTTP, DB or harness is running.
 * node --experimental-strip-types --test apps/web/src/features/conversations/agentChat/model.smoke.mjs */
/* global structuredClone */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { agentChatFixtures as fixtures } from '../../../../../../packages/contracts/src/agentChatFixtures.ts'
import { acceptAgentChatState, agentChatContextKey, stateBelongsToContext, intentUnavailable, mergeChatMessages } from './model.ts'

for (const [name, fixture] of Object.entries(fixtures)) test(`frozen fixture ${name} has its own valid context`, () => {
  assert.equal(stateBelongsToContext(fixture, fixture.context), true)
})
test('all five selection identities participate in collision-safe keys', () => {
  const context = fixtures.empty.context
  const keys = [agentChatContextKey(context), ...['workspaceId', 'workflowId', 'workflowNodeId', 'agentId', 'runId'].map((field) =>
    agentChatContextKey({ ...context, [field]: 'other' }))]
  assert.equal(new Set(keys).size, 6)
})
test('old polls and replayed snapshots cannot roll back a committed conversation', () => {
  assert.equal(acceptAgentChatState(fixtures.idleAfterCompletion, fixtures.empty), fixtures.idleAfterCompletion)
  assert.equal(acceptAgentChatState(fixtures.idleAfterCompletion, fixtures.active), fixtures.idleAfterCompletion)
})
test('messages deduplicate by app message identity and final text wins over partial text', () => {
  const messages = mergeChatMessages(fixtures.idleAfterCompletion.messages, fixtures.active.messages, fixtures.active.messages)
  assert.equal(messages.length, 2)
  assert.equal(messages[1].content, 'It is a workflow engine.')
  const partial = structuredClone(fixtures.active); partial.revision = fixtures.idleAfterCompletion.revision
  assert.equal(acceptAgentChatState(fixtures.idleAfterCompletion, partial).messages[1].nativeMessageComplete, true)
})
test('capabilities control continuation, queueing, and steer; Run activity never authorizes chat', () => {
  assert.equal(intentUnavailable(fixtures.empty, 'next_turn'), undefined)
  assert.equal(intentUnavailable(fixtures.runActive, 'next_turn'), fixtures.runActive.availability.message)
  assert.equal(intentUnavailable(fixtures.sessionMissing, 'next_turn'), fixtures.sessionMissing.availability.message)
  assert.equal(intentUnavailable(fixtures.steerUnavailable, 'steer'), fixtures.steerUnavailable.capabilities.unavailable.steer)
})
test('foreign conversation and Run identities cannot be painted as the selected context', () => {
  const state = structuredClone(fixtures.active)
  state.conversation.agentId = 'other'
  assert.equal(stateBelongsToContext(state, state.context), false)
  assert.equal(stateBelongsToContext(fixtures.active, { ...fixtures.active.context, runId: 'other' }), false)
})
test('queue order does not lose precision above Number.MAX_SAFE_INTEGER', () => {
  const state = structuredClone(fixtures.activeWithQueue)
  state.turns[0].sequence = '9007199254740993'; state.turns[1].sequence = '9007199254740992'; state.turns[2].sequence = '9'
  assert.deepEqual(acceptAgentChatState(undefined, state).turns.map((turn) => turn.requestId), ['request-3', 'request-2', 'request-1'])
})
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
test('mounted Board panel receives selected Run identity and the pinned Run canvas reuses it', () => {
  assert.match(source('../../graph/nextDraft/NextDraftEditor.tsx'), /runId: board\.run\.runId/)
  assert.match(source('../../graph/nextDraft/DraftCanvas.tsx'), /scope=\{selectedRun\} panels=\{panels\}/)
  const pinned = source('../../workflow-board/inspect/SelectedRunCanvas.tsx')
  assert.match(pinned, /ui\.panels\(id, \{ agentId: data\.agentId, name: data\.label \}\)/)
  assert.match(pinned, /nodesDraggable=\{false\} nodesConnectable=\{false\}/)
})
test('narrow panel styles wrap controls, constrain width and contain transcript overflow', () => {
  const css = source('./agentChat.css')
  assert.match(css, /min-width: 0/); assert.match(css, /max-width: 100%/)
  assert.match(css, /flex-wrap: wrap/); assert.match(css, /overflow-x: hidden/)
  assert.match(css, /overflow-wrap: anywhere/)
})
