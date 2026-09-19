import assert from 'node:assert/strict'
import { it } from 'vitest'

import { OpenCodeTurnHistory, type JsonObject, type OpenCodeMessage } from '../src/modules/harnesses/opencodeProtocol.js'

function user(id: string, parts: JsonObject[] = [{ type: 'text', text: 'original request' }]): OpenCodeMessage {
  return { info: { id, role: 'user' }, parts }
}
function assistant(id: string, parentID: string, parts: JsonObject[] = [{ type: 'text', text: 'answer' }]): OpenCodeMessage {
  return { info: { id, parentID, role: 'assistant', time: { completed: 1 }, finish: 'stop' }, parts }
}
function history(root: OpenCodeMessage, newestFirst: OpenCodeMessage[]): OpenCodeTurnHistory {
  const value = new OpenCodeTurnHistory(root)
  for (const message of newestFirst) assert.equal(value.push(message), false)
  assert.equal(value.push(root), true)
  assert.equal(value.rooted, true)
  return value
}

for (const status of ['pending', 'running'] as const) {
  for (const position of ['newest', 'older', 'before compaction'] as const) {
    it(`does not complete a turn with a ${status} tool in the ${position} assistant`, () => {
      const root = user('root')
      const blocked = assistant('blocked', 'root', [{ type: 'tool', state: { status } }])
      const complete = assistant('complete', 'root')
      const messages = position === 'newest' ? [blocked, complete] : position === 'older' ? [complete, blocked] : [
        assistant('continued', 'compaction'),
        user('compaction', [{ type: 'compaction', auto: true }]),
        blocked,
      ]
      const value = history(root, messages)
      assert.equal(value.result, undefined)
      assert.equal(value.resultMessageId, undefined)
    })
  }
}

it('allows completed tools and selects only visible answer text', () => {
  const value = history(user('root'), [assistant('answer', 'root', [
    { type: 'tool', state: { status: 'completed' } },
    { type: 'reasoning', text: 'private' },
    { type: 'text', text: 'ignored', ignored: true },
    { type: 'text', text: 'visible answer' },
  ])])
  assert.deepEqual(value.result, { outcome: 'succeeded', output: { text: 'visible answer' } })
  assert.equal(value.resultMessageId, 'answer')
})

it('does not fall back to an older answer when the newest assistant is incomplete', () => {
  const newest = assistant('newest', 'root')
  newest.info.time = {}
  assert.equal(history(user('root'), [newest, assistant('older', 'root')]).result, undefined)
})

it('clears pending-tool state only when crossing a different real user turn', () => {
  const value = history(user('root'), [
    assistant('later', 'other', [{ type: 'tool', state: { status: 'pending' } }]),
    user('other', [{ type: 'text', text: 'different request' }]),
    assistant('answer', 'root'),
  ])
  assert.equal(value.result?.outcome, 'succeeded')
  assert.equal(value.resultMessageId, 'answer')
})

for (const mime of [undefined, 'image/png', 'application/pdf'] as const) {
  it(`matches ${mime ?? 'text'} overflow replay without using native part metadata as content`, () => {
    const root = user('root', mime
      ? [{ type: 'file', mime, filename: 'attachment', id: 'old-part', sessionID: 'old-session', messageID: 'root', time: { start: 1 } }]
      : [{ type: 'text', text: 'original request', id: 'old-part', sessionID: 'old-session', messageID: 'root', time: { start: 1 } }])
    const replay = user('replay', mime
      ? [{ type: 'text', text: `[Attached ${mime}: attachment]`, id: 'new-part', messageID: 'replay' }]
      : [{ ...root.parts[0], id: 'new-part', sessionID: 'new-session', messageID: 'replay', time: { start: 2 } }])
    const before = structuredClone([root, replay])
    const value = history(root, [
      assistant('continued', 'replay'), replay,
      assistant('summary', 'compaction'),
      user('compaction', [{ type: 'compaction', auto: true, overflow: true }]),
    ])
    assert.deepEqual(value.result, { outcome: 'succeeded', output: { text: 'answer' } })
    assert.equal(value.resultMessageId, 'continued')
    assert.deepEqual([root, replay], before)
  })
}

for (const compaction of ['missing', 'not overflow', 'wrong parent'] as const) {
  it(`rejects a replay chain when compaction is ${compaction}`, () => {
    const root = user('root')
    const messages = [assistant('continued', 'replay'), user('replay')]
    if (compaction !== 'missing') messages.push(
      assistant('summary', compaction === 'wrong parent' ? 'foreign' : 'compaction'),
      user('compaction', [{ type: 'compaction', auto: true, overflow: compaction !== 'not overflow' }]),
    )
    assert.equal(history(root, messages).result, undefined)
  })
}

it('rechecks a candidate whose parts change before the addressed root is reached', () => {
  const root = user('root')
  const answer = assistant('answer', 'root')
  const value = new OpenCodeTurnHistory(root)
  value.push(answer)
  answer.parts.push({ type: 'tool', state: { status: 'running' } })
  value.push(root)
  assert.equal(value.result, undefined)
})
