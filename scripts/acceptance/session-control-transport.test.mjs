import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionControlTransport } from './session-control-transport.mjs'

function fixture() {
  const calls = []
  const controls = { revision: 2, desiredMode: 'plan', desired: { contextBudget: 100000 } }
  const value = sessionControlTransport({ baseUrl: 'http://127.0.0.1:3307',
    tool: async (name, args, options) => {
      calls.push({ name, args, options })
      if (!['owned', 'future-owned'].includes(args.conversationId)) throw new Error('Conversation denied')
      return controls
    },
    request: async (url, input, options) => {
      calls.push({ url: url.pathname, input, options })
      if (url.pathname.includes('/operator/')) throw new Error('The implicit local user does not own this MCP chat')
      return controls
    } })
  return { value, calls, controls }
}

test('keeps MCP-created Operator reads, controls, input and future defaults with their creating caller', async () => {
  const f = fixture()
  const row = { role: 'operator', conversationId: 'owned', futureDefaultsConversationId: 'future-owned' }
  const input = { requestId: 'one-input', content: 'Inspect without modifying files.', sessionMode: 'plan' }
  const options = { signal: AbortSignal.timeout(1000) }
  assert.equal(await f.value.controls(row), f.controls)
  assert.equal(await f.value.transcript(row), f.controls)
  await f.value.change(row, { kind: 'compact', requestId: 'one-compact' }, options)
  await f.value.send(row, input)
  assert.equal(await f.value.futureDefaults(row), f.controls)
  assert.deepEqual(f.calls.map(call => call.name), [
    'operator_chat_controls_get', 'operator_chat_get', 'operator_chat_controls_update',
    'operator_chat_send', 'operator_chat_controls_get',
  ])
  assert.deepEqual(f.calls[3].args, { conversationId: 'owned', request: input })
  assert.equal(f.calls[2].options.signal, options.signal)
  assert.equal(f.calls[4].args.conversationId, 'future-owned')
  assert.equal(f.calls.some(call => call.url), false)
})

test('retains caller denial instead of retrying as the implicit local user', async () => {
  const f = fixture()
  const row = { role: 'operator', conversationId: 'foreign' }
  await assert.rejects(f.value.controls(row), /Conversation denied/)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls.some(call => call.url), false)
})

test('keeps saved node HTTP requests on their workspace and conversation without adding credentials', async () => {
  const f = fixture()
  const row = { role: 'agent', workspaceId: 'workspace', conversationId: 'node-chat',
    readPath: '/api/workspaces/workspace/agent-chat?workflowNodeId=node',
    sendPath: '/api/workspaces/workspace/agent-chat/messages',
    futureDefaultsReadPath: '/api/workspaces/workspace/agent-chat/future/session-controls' }
  const input = { kind: 'mode', mode: 'plan', requestId: 'mode' }
  assert.equal(await f.value.controls(row), f.controls)
  await f.value.change(row, input)
  await f.value.transcript(row)
  await f.value.send(row, { content: 'Read-only plan', sessionMode: 'plan' })
  await f.value.futureDefaults(row)
  assert.equal(f.calls[0].url, '/api/workspaces/workspace/agent-chat/conversations/node-chat/session-controls')
  assert.deepEqual(f.calls[1].input, input)
  assert.equal(f.calls.some(call => call.name), false)
})
