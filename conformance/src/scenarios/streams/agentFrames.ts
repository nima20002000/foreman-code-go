import assert from 'node:assert/strict'
import { ActivityChangeEnvelopeV1Schema } from '@foreman-code/contracts'
import { AgentChatStreamEventSchema, type AgentChatState, type AgentChatStreamEvent } from '@foreman-code/contracts/agent-chat'
import { assertJson } from '../../assertions.js'
import type { BrowserStream, SseFrame } from '../../clients/streams.js'
import { nextFrame } from './operatorFrames.js'

const heartbeat = { event: 'message', data: undefined, id: undefined, retry: undefined,
  comments: ['heartbeat'], raw: ': heartbeat\n\n' }

function parseEvent(frame: SseFrame, conversationId: string): AgentChatStreamEvent {
  assert.equal(typeof frame.data, 'string')
  const value = JSON.parse(frame.data!)
  const event = AgentChatStreamEventSchema.parse(value)
  assert.deepStrictEqual(event, value)
  assert.equal(event.conversationId, conversationId)
  assert.equal(frame.event, event.type)
  assert.equal(frame.id, String(event.id))
  assert.equal(frame.retry, undefined)
  assert.deepStrictEqual(frame.comments, [])
  assert.equal(frame.raw, `event: ${event.type}\nid: ${event.id}\ndata: ${frame.data}\n\n`)
  return event
}

export async function assertAgentSnapshot(stream: BrowserStream, state: AgentChatState) {
  assert.equal(stream.status, 200)
  assert.equal(stream.headers.get('content-type'), 'text/event-stream')
  assert.equal(stream.headers.get('cache-control'), 'no-cache, no-transform')
  assert.equal(stream.headers.get('x-accel-buffering'), 'no')
  const event = parseEvent(await nextFrame(stream), state.conversation!.id)
  assert.deepStrictEqual(event, { id: 0, conversationId: state.conversation!.id, type: 'snapshot', data: state })
}

/** Connection ordering is independent of the snapshot's durable revision and zero wire ID. */
export function agentLiveEvents(stream: BrowserStream, active: AgentChatState, answer: string) {
  const conversationId = active.conversation!.id
  const requestId = active.activeTurn!.requestId
  const events: AgentChatStreamEvent[] = []
  let previousId: number | undefined
  let provisionalText = false
  let finalText = false
  let finalInvalidation = false
  async function next() {
    const frame = await nextFrame(stream)
    if (frame.data === undefined) { assert.deepStrictEqual(frame, heartbeat); return undefined }
    const event = parseEvent(frame, conversationId)
    if (previousId === undefined) assert.ok(event.id >= 3, 'Admission, claim and native acceptance precede this subscriber.')
    else assert.equal(event.id, previousId + 1, 'Agent browser events must retain contiguous live transport order.')
    previousId = event.id
    events.push(event)
    assert.ok(events.length <= 1024, 'Agent native turn exceeded its bounded browser event count.')
    return event
  }
  function accept(event: AgentChatStreamEvent): boolean {
    assert.notEqual(event.type, 'error', `Agent native stream reported failure: ${JSON.stringify(event.data)}`)
    switch (event.type) {
      case 'delta': {
        const activityChange = ActivityChangeEnvelopeV1Schema.parse(event.data.activityChange)
        assert.deepStrictEqual(activityChange, event.data.activityChange)
        const provisional = activityChange.change.kind === 'text.append'
        assertJson(event.data, { requestId, scopeRevision: provisional ? '6' : '7', activityChange: {
          schemaVersion: 1, owner: { kind: 'chat_request', conversationId, requestId },
          scope: active.activitySnapshot!.scope,
          native: { harness: 'codex', sessionId: active.conversation!.nativeSession!.nativeSessionId,
            turnId: 'turn-1', itemId: 'answer-turn-1' },
          source: { schemaVersion: 1, system: 'codex', observedAt: '<timestamp>' },
          change: { kind: provisional ? 'text.append' : 'text.replace', itemId: 'answer-turn-1',
            channel: 'assistant', text: answer, finality: provisional ? 'provisional' : 'authoritative_final' },
        } }, [{ pointer: '/body/activityChange/source/observedAt', kind: 'timestamp' }])
        if (provisional) {
          assert.equal(provisionalText, false, 'One native provisional delta must be delivered exactly once.')
          assert.equal(finalText, false)
          provisionalText = true
        } else {
          assert.ok(provisionalText, 'The real provisional delta must precede its final replacement.')
          assert.equal(finalText, false, 'Duplicate native completion must not duplicate final public text.')
          assert.equal(finalInvalidation, false, 'A delivered replacement must precede its final readback invalidation.')
          finalText = true
        }
        break
      }
      case 'message':
        if (event.data.nativeMessageId !== undefined) {
          assert.deepStrictEqual(event.data, { requestId, nativeMessageId: 'answer-turn-1' })
          assert.ok(provisionalText, 'Native history may finalize only after the observed provisional write.')
          finalInvalidation = true
        } else if (event.data.snapshotRequired !== undefined) {
          assert.deepStrictEqual(event.data, { requestId, snapshotRequired: true, scopeRevision: '7' })
          assert.ok(provisionalText)
          finalInvalidation = true
        } else assert.deepStrictEqual(event.data, { requestId })
        break
      case 'state':
        if (event.data.delivery === 'completed') {
          assert.deepStrictEqual(event.data, { requestId, delivery: 'completed' })
          assert.ok(provisionalText, 'A scenario cannot credit text delivery without its actual native delta.')
          const previous = events.at(-2)
          assert.ok(previous)
          assert.deepStrictEqual({ type: previous.type, data: previous.data }, { type: 'message', data: { requestId } },
            'The durable message invalidation must immediately precede native completion.')
          return true
        }
        if (event.data.snapshotRequired !== undefined) assert.deepStrictEqual(event.data, { requestId, snapshotRequired: true })
        else assert.deepStrictEqual(event.data, { requestId, delivery: 'accepted' })
        break
      default:
        assert.fail(`Unexpected Agent live event: ${JSON.stringify(event)}`)
    }
    return false
  }
  return {
    async heartbeat() {
      for (;;) {
        const event = await next()
        if (!event) return
        assert.deepStrictEqual({ type: event.type, data: event.data }, {
          type: 'state', data: { requestId, delivery: 'accepted' },
        }, 'While held, native reconciliation must keep the same accepted request.')
      }
    },
    async presented() {
      while (!provisionalText) {
        const event = await next()
        if (event) assert.equal(accept(event), false, 'The held native turn completed before its presentation gate.')
      }
    },
    async terminal() {
      for (;;) {
        const event = await next()
        if (!event) continue
        if (accept(event)) return events
      }
    },
  }
}
