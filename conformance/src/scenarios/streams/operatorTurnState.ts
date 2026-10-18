import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  DEFAULT_AGENT_DEFAULTS, GetOperatorConversationResponseSchema, SendOperatorMessageResponseSchema,
  type OperatorConversationState, type SendOperatorMessageRequest,
} from '@foreman-code/contracts'
import { OperatorConversationHistoryPageSchema } from '@foreman-code/contracts/operator-chat'
import { messageAttachmentIdentity, type FileWithRevision } from '@foreman-code/contracts/files'
import { assertResponse } from '../../assertions.js'
import { parseSuccessResponse } from '../../clients/response.js'
import type { ScenarioContext } from '../../scenario.js'

export async function readOperatorState(context: ScenarioContext, id: string, token?: string) {
  const response = await context.http.request('GET', `/api/operator/conversations/${id}`, token === undefined ? {} : { token })
  assert.equal(response.status, 200)
  const value = GetOperatorConversationResponseSchema.parse(response.body)
  assert.deepStrictEqual(value, response.body)
  return value
}

export async function readOperatorHistory(context: ScenarioContext, id: string, token?: string) {
  const response = await context.http.request('GET', `/api/operator/conversations/${id}/history`, token === undefined ? {} : { token })
  assert.equal(response.status, 200)
  const value = OperatorConversationHistoryPageSchema.parse(response.body)
  assert.deepStrictEqual(value, response.body)
  return value
}

export function assertAcceptedOperatorTurn(response: Awaited<ReturnType<ScenarioContext['http']['request']>>,
  before: OperatorConversationState, input: SendOperatorMessageRequest, files: readonly FileWithRevision[]) {
  // Success-only normalization must not hide an HTTP error or a malformed acceptance envelope.
  const result = parseSuccessResponse(response, SendOperatorMessageResponseSchema, {
    method: 'POST',
    path: `/api/operator/conversations/${before.conversation.id}/messages`,
    status: 202,
    contract: 'SendOperatorMessageResponse',
  })
  const base = structuredClone(before)
  delete base.activitySnapshot
  delete base.qualificationKey
  assertResponse(response, { status: 202, body: { replayed: false, state: { ...base,
    conversation: { ...base.conversation, updatedAt: '<timestamp>' },
    messages: [{ id: '<uuid>', conversationId: before.conversation.id, role: 'user', requestId: input.requestId,
      content: input.content, acceptedModel: { harness: 'codex', model: DEFAULT_AGENT_DEFAULTS.operator.harness.model },
      revision: '0', sequence: '1', createdAt: '<timestamp>', updatedAt: '<timestamp>',
      originalInput: { requestId: input.requestId, content: input.content, attachments: input.attachments ?? [] },
      ...(files.length ? { attachments: files } : {}) }],
    turnState: 'starting', revision: 1, activeRequestId: input.requestId,
  } } }, [
    { pointer: '/body/state/conversation/updatedAt', kind: 'timestamp' },
    { pointer: '/body/state/messages/0/id', kind: 'uuid' },
    { pointer: '/body/state/messages/0/createdAt', kind: 'timestamp' },
    { pointer: '/body/state/messages/0/updatedAt', kind: 'timestamp' },
  ])
  assert.deepStrictEqual(result, response.body)
  const message = result.state.messages[0]!
  assert.equal(message.createdAt, message.updatedAt)
  assert.ok(Date.parse(result.state.conversation.updatedAt!) >= Date.parse(before.conversation.updatedAt!))
  return result
}

export async function assertOperatorTurnPersistence(context: ScenarioContext, state: OperatorConversationState,
  input: SendOperatorMessageRequest, token?: string) {
  const history = await readOperatorHistory(context, state.conversation.id, token)
  assert.equal(history.entries.length, 2)
  const receipt = history.entries[0]!.receipt
  assert.ok(receipt)
  const payload = { content: input.content, configurationVersionId: input.configurationVersionId,
    ...(input.attachments?.length ? {
      attachmentIdentity: messageAttachmentIdentity({ requestId: input.requestId, attachments: input.attachments }),
    } : {}) }
  const inputHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  assert.deepStrictEqual(history, { conversationId: state.conversation.id, revision: state.revision,
    activeRequestId: null, nextCursor: null, entries: state.messages.map((message, index) => ({
      sequence: message.sequence, message, receipt: index === 0
        ? { requestId: input.requestId, inputHash, outcome: 'succeeded', retryable: false } : null,
    })) })
  await context.target.restart()
  assert.deepStrictEqual(await readOperatorState(context, state.conversation.id, token), state)
  assert.deepStrictEqual(await readOperatorHistory(context, state.conversation.id, token), history)
  return history
}
