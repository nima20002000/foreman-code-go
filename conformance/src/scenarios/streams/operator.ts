import assert from 'node:assert/strict'
import { GetOperatorConversationResponseSchema, type OperatorConversationState } from '@foreman-code/contracts'
import { assertResponse } from '../../assertions.js'
import { openBrowserStream, type BrowserStream, type SseFrame } from '../../clients/streams.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { createConversation } from '../smoke/conversations.js'
import { assertEmptyOperatorState } from '../mcp/conversations.js'

async function readState(context: ScenarioContext, conversationId: string): Promise<OperatorConversationState> {
  const response = await context.http.request('GET', `/api/operator/conversations/${conversationId}`)
  assert.equal(response.status, 200)
  const state = GetOperatorConversationResponseSchema.parse(response.body)
  assert.deepStrictEqual(response.body, state)
  return state
}

export async function nextFrame(stream: BrowserStream): Promise<SseFrame> {
  const next = await stream.frames.next()
  assert.equal(next.done, false, 'The browser stream closed before the expected frame.')
  return next.value!
}

export async function assertOperatorSnapshot(stream: BrowserStream, state: OperatorConversationState): Promise<void> {
  assert.equal(stream.status, 200)
  assert.equal(stream.headers.get('content-type'), 'text/event-stream')
  assert.equal(stream.headers.get('cache-control'), 'no-cache, no-transform')
  assert.equal(stream.headers.get('x-accel-buffering'), 'no')
  const snapshot = await nextFrame(stream)
  assert.equal(snapshot.event, 'snapshot')
  assert.equal(snapshot.id, String(state.revision))
  assert.equal(snapshot.retry, undefined)
  assert.deepStrictEqual(snapshot.comments, [])
  assert.equal(typeof snapshot.data, 'string')
  assert.deepStrictEqual(JSON.parse(snapshot.data!), state)
  assert.equal(snapshot.raw, `id: ${state.revision}\nevent: snapshot\ndata: ${snapshot.data}\n\n`)
}

export const operatorStreamScenarios: Scenario[] = [
  {
    id: 'streams.operator.snapshot-framing', title: 'Operator SSE begins with its exact durable snapshot and a comment heartbeat',
    lane: 'A1', covers: [{ surface: 'stream', name: 'operator-chat', case: 'framing' }],
    async run(context) {
      const { conversation } = await createConversation(context, 'Operator stream framing')
      const state = await readState(context, conversation.id)
      assertEmptyOperatorState(state, conversation)
      const stream = await openBrowserStream({ baseUrl: context.target.baseUrl,
        path: `/api/operator/conversations/${conversation.id}/events`,
        headers: context.http.requestHeaders(), signal: context.signal })
      try {
        await assertOperatorSnapshot(stream, state)
        assert.deepStrictEqual(await nextFrame(stream), {
          event: 'message', data: undefined, id: undefined, retry: undefined,
          comments: ['heartbeat'], raw: ': heartbeat\n\n',
        })
      } finally { await stream.close() }
    },
  },
  {
    id: 'streams.operator.reconnect-snapshot', title: 'Operator SSE reconnect reads the restored durable revision instead of replaying stale events',
    lane: 'A1', covers: [{ surface: 'stream', name: 'operator-chat', case: 'reconnect' }],
    async run(context) {
      const { conversation } = await createConversation(context, 'Operator stream reconnect')
      const path = `/api/operator/conversations/${conversation.id}`
      const before = await readState(context, conversation.id)
      assertEmptyOperatorState(before, conversation)
      const original = await openBrowserStream({ baseUrl: context.target.baseUrl, path: `${path}/events`,
        headers: context.http.requestHeaders(), signal: context.signal })
      try { await assertOperatorSnapshot(original, before) }
      finally { await original.close() }
      assertResponse(await context.http.request('DELETE', path), {
        status: 200, body: { conversationId: conversation.id, revision: 1 },
      })
      assertResponse(await context.http.request('POST', `${path}/restore`), {
        status: 200, body: { conversationId: conversation.id, revision: 2 },
      })
      await context.target.restart()
      const restored = await readState(context, conversation.id)
      assertEmptyOperatorState(restored, conversation, 2)
      const reconnected = await openBrowserStream({ baseUrl: context.target.baseUrl, path: `${path}/events`,
        headers: context.http.requestHeaders(), signal: context.signal, lastEventId: String(before.revision) })
      try { await assertOperatorSnapshot(reconnected, restored) }
      finally { await reconnected.close() }
    },
  },
]
