import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  OperatorConversationStreamEventSchema, SendOperatorMessageRequestSchema,
  type Conversation, type OperatorConversationStreamEvent,
} from '@foreman-code/contracts'
import type { FileWithRevision, MessageAttachmentRef } from '@foreman-code/contracts/files'
import { openBrowserStream, type BrowserStream } from '../../clients/streams.js'
import type { ScenarioContext } from '../../scenario.js'
import { assertEmptyOperatorState } from '../mcp/conversations.js'
import { assertOperatorSnapshot, nextFrame } from './operatorFrames.js'
import { assertAcceptedOperatorTurn, assertOperatorTurnPersistence,
  readOperatorState } from './operatorTurnState.js'
import { assertCompletedOperatorProjection } from './operatorProjection.js'
import type { ExpectedOperatorToolCall } from './operatorToolProjection.js'

export type { ExpectedOperatorToolCall } from './operatorToolProjection.js'

export interface OperatorTurnOptions {
  content: string
  attachments?: MessageAttachmentRef[]
  inputFiles?: readonly FileWithRevision[]
  assertAnswer(answer: string): Promise<readonly FileWithRevision[] | void> | readonly FileWithRevision[] | void
  expectedToolCalls?(answer: string): readonly ExpectedOperatorToolCall[]
  token?: string
}

export async function observeOperatorTerminal(stream: BrowserStream, conversationId: string, requestId: string) {
  const events: OperatorConversationStreamEvent[] = []
  while (events.length < 1024) {
    const frame = await nextFrame(stream)
    if (frame.data === undefined) {
      assert.deepStrictEqual(frame, { event: 'message', data: undefined, id: undefined, retry: undefined,
        comments: ['heartbeat'], raw: ': heartbeat\n\n' })
      continue
    }
    const value = JSON.parse(frame.data)
    const event = OperatorConversationStreamEventSchema.parse(value)
    assert.deepStrictEqual(value, event)
    assert.equal(event.id, events.length, 'Live browser event IDs must be contiguous within this connection.')
    assert.equal(event.conversationId, conversationId)
    assert.equal(frame.event, event.type)
    assert.equal(frame.id, undefined)
    assert.equal(frame.retry, undefined)
    assert.deepStrictEqual(frame.comments, [])
    assert.equal(frame.raw, `event: ${event.type}\ndata: ${frame.data}\n\n`)
    assert.notEqual(event.type, 'snapshot', 'A live update must not silently replace the initial snapshot.')
    assert.notEqual(event.type, 'error', `Operator native turn failed: ${JSON.stringify(event.data)}`)
    events.push(event)
    if (event.type !== 'state' || !['idle', 'error'].includes(String(event.data.turnState))) continue
    assert.deepStrictEqual(event.data, { requestId, turnState: 'idle' })
    const predecessor = events.at(-2)
    assert.ok(predecessor, 'A terminal state must follow its durable message invalidation.')
    assert.equal(predecessor.type, 'message')
    assert.deepStrictEqual(predecessor.data, { requestId })
    return events
  }
  throw new Error('Operator native turn exceeded the bounded browser event count.')
}

/** One fresh conversation, actual native execution, and complete public persistence readback. */
export async function sendOperatorTurn(context: ScenarioContext, conversation: Conversation, options: OperatorTurnOptions) {
  const inputFiles = options.inputFiles ?? []
  const input = SendOperatorMessageRequestSchema.parse({ requestId: randomUUID(), content: options.content,
    attachments: options.attachments ?? [], configurationVersionId: conversation.operatorConfigurationVersionId })
  assert.deepStrictEqual(input.attachments, inputFiles.map(value => ({
    fileId: value.file.fileId, revisionId: value.revision.revisionId,
  })), 'Input metadata must come from the same immutable public upload pins.')
  const before = await readOperatorState(context, conversation.id, options.token)
  assertEmptyOperatorState(before, conversation)
  const path = `/api/operator/conversations/${conversation.id}`
  const stream = await openBrowserStream({ baseUrl: context.target.baseUrl, path: `${path}/events`,
    headers: context.http.requestHeaders({ token: options.token }), signal: context.signal })
  let accepted
  let events: OperatorConversationStreamEvent[]
  try {
    await assertOperatorSnapshot(stream, before)
    accepted = assertAcceptedOperatorTurn(await context.http.request('POST', `${path}/messages`, {
      body: input, token: options.token,
    }), before, input, inputFiles)
    events = await observeOperatorTerminal(stream, conversation.id, input.requestId)
  } finally { await stream.close() }
  const state = await readOperatorState(context, conversation.id, options.token)
  assert.equal(state.messages.length, 2)
  const answer = state.messages[1]!.content
  const publications = await options.assertAnswer(answer)
  assertCompletedOperatorProjection(state, { before, accepted, input, answer, inputFiles,
    publications: publications ?? [], toolCalls: options.expectedToolCalls?.(answer) ?? [] })
  const history = await assertOperatorTurnPersistence(context, state, input, options.token)
  return { input, accepted, state, history, events, answer }
}
