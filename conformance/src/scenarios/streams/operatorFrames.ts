import assert from 'node:assert/strict'
import type { OperatorConversationState } from '@foreman-code/contracts'
import type { BrowserStream, SseFrame } from '../../clients/streams.js'

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
