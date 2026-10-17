import assert from 'node:assert/strict'
import { assertResponse } from '../../assertions.js'
import { openBrowserStream, StreamHttpError } from '../../clients/streams.js'
import { assertOperatorSnapshot, nextFrame } from './operatorFrames.js'
import type { Scenario } from '../../scenario.js'
import { createConversation } from '../smoke/conversations.js'
import { assertEmptyOperatorState } from '../mcp/conversations.js'
import { sendOperatorTurn } from './operatorTurn.js'
import { readOperatorState } from './operatorTurnState.js'

const eventsPath = '/api/operator/conversations/:conversationId/events'

export const operatorStreamScenarios: Scenario[] = [
  {
    id: 'streams.operator.native-order', title: 'Operator native completion preserves contiguous frames and publishes durable text before idle',
    lane: 'A1', covers: [{ surface: 'stream', name: eventsPath, case: 'order' }],
    async run(context) {
      const { conversation } = await createConversation(context, 'Operator native stream order')
      await sendOperatorTurn(context, conversation, { content: 'Conformance default native response',
        assertAnswer(answer) { assert.equal(answer, 'answer-agent-a') } })
    },
  },
  {
    id: 'streams.operator.snapshot-framing', title: 'Operator SSE begins with its exact durable snapshot and a comment heartbeat',
    lane: 'A1', covers: [{ surface: 'stream', name: eventsPath, case: 'framing' },
      { surface: 'http', method: 'GET', path: eventsPath, transport: 'sse', case: 'success' }],
    async run(context) {
      const { conversation } = await createConversation(context, 'Operator stream framing')
      const state = await readOperatorState(context, conversation.id)
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
    lane: 'A1', covers: [{ surface: 'stream', name: eventsPath, case: 'reconnect' }],
    async run(context) {
      const { conversation } = await createConversation(context, 'Operator stream reconnect')
      const path = `/api/operator/conversations/${conversation.id}`
      const before = await readOperatorState(context, conversation.id)
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
      const restored = await readOperatorState(context, conversation.id)
      assertEmptyOperatorState(restored, conversation, 2)
      const reconnected = await openBrowserStream({ baseUrl: context.target.baseUrl, path: `${path}/events`,
        headers: context.http.requestHeaders(), signal: context.signal, lastEventId: String(before.revision) })
      try { await assertOperatorSnapshot(reconnected, restored) }
      finally { await reconnected.close() }
    },
  },
  {
    id: 'streams.operator.invalid-caller', title: 'Operator SSE denies an invalid credential before opening an event stream',
    lane: 'A1', covers: [{ surface: 'http', method: 'GET', path: eventsPath, transport: 'sse', case: 'error' }],
    async run(context) {
      const { conversation } = await createConversation(context, 'Operator stream denied caller')
      await assert.rejects(() => openBrowserStream({ baseUrl: context.target.baseUrl,
        path: `/api/operator/conversations/${conversation.id}/events`, signal: context.signal,
        headers: context.http.requestHeaders({ token: 'conformance-invalid-credential' }),
      }), error => {
        assert.ok(error instanceof StreamHttpError)
        assertResponse({ status: error.status, body: error.body, headers: new Headers() }, {
          status: 401, body: { error: { code: 'AUTH_INVALID', message: 'The supplied credential is invalid.', requestId: '<uuid>' } },
        }, [{ pointer: '/body/error/requestId', kind: 'uuid' }])
        return true
      })
    },
  },
]
