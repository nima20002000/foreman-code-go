import assert from 'node:assert/strict'
import type {
  ActivityItem, ActivityNativeIdentity, ActivitySnapshotV1, Message, OperatorConversationState,
  SendOperatorMessageRequest, SendOperatorMessageResponseSchema, WorkRef,
} from '@foreman-code/contracts'
import type { FileWithRevision } from '@foreman-code/contracts/files'
import { assertJson, type NormalizationRule } from '../../assertions.js'
import { expectedOperatorPublications, expectedOperatorTools, type ExpectedOperatorToolCall } from './operatorToolProjection.js'

export interface OperatorProjectionExpectation {
  before: OperatorConversationState
  accepted: ReturnType<typeof SendOperatorMessageResponseSchema.parse>
  input: SendOperatorMessageRequest
  answer: string
  inputFiles: readonly FileWithRevision[]
  publications: readonly FileWithRevision[]
  toolCalls: readonly ExpectedOperatorToolCall[]
}

function textItem(message: Message, owner: WorkRef, native?: ActivityNativeIdentity): ActivityItem {
  return { id: `message:${message.id}`, messageId: message.id, role: message.role,
    revision: message.revision!, order: message.sequence!, orderSource: 'conversation_message', owner,
    ...(message.afterActivitySequence !== undefined ? { afterActivitySequence: message.afterActivitySequence } : {}),
    ...(native ? { native } : {}), source: { schemaVersion: 1, system: 'conversation_message', observedAt: null },
    evidence: 'confirmed', kind: 'text', text: message.content, finality: 'authoritative_final' }
}

/** A fresh first turn has one accepted user message and one authoritative native answer. */
export function assertCompletedOperatorProjection(state: OperatorConversationState, expected: OperatorProjectionExpectation): void {
  const { before, accepted, input, answer, inputFiles, publications, toolCalls } = expected
  assert.equal(state.messages.length, 2, 'Duplicate native completion must not duplicate the persisted answer.')
  const conversationId = before.conversation.id
  const observedAssistant = state.messages[1]!
  const sessionId = observedAssistant.activityNative?.sessionId
  assert.equal(typeof sessionId, 'string')
  assert.match(sessionId!, /^thread-agent-a-[1-9][0-9]*-1$/)
  const native = { harness: 'codex', sessionId: sessionId!, turnId: 'turn-1', itemId: 'answer-turn-1' }
  const owner: WorkRef = { kind: 'chat_request', conversationId, requestId: input.requestId }
  const tools = expectedOperatorTools(state, toolCalls, owner, sessionId!)
  const receipts = expectedOperatorPublications(toolCalls)
  assert.deepStrictEqual(publications, receipts.map(receipt => receipt.value),
    'Every expected publication must come from an independently asserted native publish result.')
  const attachments = [...inputFiles, ...publications]
  const user: Message = { ...accepted.state.messages[0]!, revision: String(receipts.length),
    ...(attachments.length ? { attachments } : {}) }
  const assistant: Message = { id: observedAssistant.id, conversationId, requestId: input.requestId,
    role: 'assistant', content: answer, acceptedModel: user.acceptedModel, revision: '0', sequence: '2',
    activityNative: native, activityChannel: 'assistant', nativeMessageId: 'answer-turn-1', nativeMessageComplete: true,
    afterActivitySequence: String(Math.max(0, toolCalls.length * 2 - 1)),
    createdAt: '<timestamp>', updatedAt: '<timestamp>' }
  // The two reconciled native-history observations each advance the public scope once.
  const revision = 9 + toolCalls.length * 2
  const snapshot: ActivitySnapshotV1 = {
    schemaVersion: 1, scope: { kind: 'operator_chat', conversationId }, revision: String(revision),
    sourceRevisions: [
      { source: 'scope', id: conversationId, revision: String(revision) },
      { source: 'message', id: user.id, revision: user.revision! },
      { source: 'message', id: assistant.id, revision: '0' },
      ...attachments.map(file => ({ source: 'file' as const, id: file.file.fileId, revision: '1' })),
      ...receipts.flatMap(receipt => [
        { source: 'publication' as const, id: receipt.receiptId, revision: '0' },
        { source: 'file' as const, id: receipt.value.file.fileId, revision: '1' },
      ]),
    ], active: [], queued: [], latest: owner, pendingInteractions: [],
    activities: [
      ...receipts.map((receipt): ActivityItem => ({ kind: 'file_publication', id: `publication:${receipt.receiptId}`,
        revision: '1', order: '1', orderSource: 'file_publication', owner,
        native: { harness: 'codex', sessionId: sessionId!, turnId: 'turn-1' },
        source: { schemaVersion: 1, system: 'file_tool_publication', observedAt: null }, evidence: 'confirmed',
        receiptId: receipt.receiptId, fileId: receipt.value.file.fileId,
        fileRevisionId: receipt.value.revision.revisionId, status: 'ready' })),
      textItem(user, owner), textItem(assistant, owner, native), ...tools.items,
    ], page: { before: null, nextCursor: null, hasMore: false },
  }
  const rules: NormalizationRule[] = [
    { pointer: '/body/conversation/updatedAt', kind: 'timestamp' },
    { pointer: '/body/messages/1/id', kind: 'uuid' },
    { pointer: '/body/messages/1/activityNative/sessionId', kind: 'id' },
    { pointer: '/body/messages/1/createdAt', kind: 'timestamp' },
    { pointer: '/body/messages/1/updatedAt', kind: 'timestamp' },
    { pointer: '/body/qualificationKey', kind: 'id' }, ...tools.rules,
  ]
  assert.match(state.qualificationKey!, /^[0-9a-f]{64}$/)
  assert.notEqual(state.qualificationKey, before.qualificationKey,
    'The same actor’s qualification key must change with the authoritative scope revision.')
  assertJson(state, { ...before, conversation: { ...before.conversation, updatedAt: '<timestamp>' },
    messages: [user, { ...assistant, id: '<uuid>', activityNative: { ...native, sessionId: '<id>' } }],
    activities: tools.activities, activityNextCursor: null, hasEarlierMessages: false,
    turnState: 'idle', revision, activeRequestId: null, lastResult: { outcome: 'succeeded', output: { text: answer } },
    activitySnapshot: snapshot, qualificationKey: '<id>',
  }, rules)
  assert.equal(observedAssistant.createdAt, observedAssistant.updatedAt)
  assert.ok(Date.parse(observedAssistant.createdAt!) >= Date.parse(user.createdAt!))
  assert.ok(Date.parse(state.conversation.updatedAt!) >= Date.parse(observedAssistant.createdAt!))
}
