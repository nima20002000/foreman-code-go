import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  CreateOperatorConversationRequestSchema, CreateOperatorConversationResponseSchema, DEFAULT_AGENT_DEFAULTS,
  DeleteOperatorConversationResponseSchema, GetOperatorConversationResponseSchema,
  ListOperatorConversationsResponseSchema, OperatorActivityPageSchema, OperatorConversationDeletionInputSchema,
  operatorChatSettings, type Conversation, type OperatorConversationState,
} from '@foreman-code/contracts'
import { OperatorConversationHistoryPageSchema } from '@foreman-code/contracts/operator-chat'
import { DEFAULT_PROMPT_TEXT } from '@foreman-code/contracts/management'
import type { McpClient } from '../../clients/mcp.js'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertInvalidCallerDenied, assertReadOnlyDenied, assertToolFailure,
  assertValue, callTool, mcpClaims, operatorClients } from './support.js'

export async function createMcpConversation(client: McpClient, title: string) {
  const input = CreateOperatorConversationRequestSchema.parse({ commandId: randomUUID(), title })
  const result = await callTool(client, 'operator_chat_create', input, CreateOperatorConversationResponseSchema)
  assertValue(result, { conversation: { id: '<uuid>', agentId: 'application-operator', scope: 'application',
    operatorConfigurationVersionId: '<id>', initialPrompt: { value: DEFAULT_PROMPT_TEXT, revision: 0, versionId: null },
    title, status: 'open', createdAt: '<timestamp>', updatedAt: '<timestamp>',
  } }, [
    { pointer: '/body/conversation/id', kind: 'uuid' },
    { pointer: '/body/conversation/operatorConfigurationVersionId', kind: 'id' },
    { pointer: '/body/conversation/createdAt', kind: 'timestamp' },
    { pointer: '/body/conversation/updatedAt', kind: 'timestamp' },
  ])
  return { input, result }
}

/** The one generated qualification identifier is checked unchanged against same-caller HTTP readback. */
export function assertEmptyOperatorState(state: OperatorConversationState, conversation: Conversation, revision = 0): void {
  GetOperatorConversationResponseSchema.parse(state)
  assert.equal(typeof state.qualificationKey, 'string')
  assert.match(state.qualificationKey!, /^[0-9a-f]{64}$/)
  assertValue(state, {
    conversation, messages: [], activities: [], activityNextCursor: null, hasEarlierMessages: false,
    settings: operatorChatSettings(DEFAULT_AGENT_DEFAULTS.operator.harness, DEFAULT_AGENT_DEFAULTS.operator.showThinking),
    providerAccountBinding: { kind: 'legacy-profile', provider: 'codex', target: null, profileRef: null, historicalSubject: 'unknown' },
    turnState: 'idle', revision, activeRequestId: null,
    activitySnapshot: {
      schemaVersion: 1, scope: { kind: 'operator_chat', conversationId: conversation.id }, revision: String(revision),
      sourceRevisions: [{ source: 'scope', id: conversation.id, revision: String(revision) }],
      active: [], queued: [], latest: null, pendingInteractions: [], activities: [],
      page: { before: null, nextCursor: null, hasMore: false },
    }, qualificationKey: '<id>',
  }, [{ pointer: '/body/qualificationKey', kind: 'id' }])
}

export const conversationMcpScenarios: Scenario[] = [
  {
    id: 'mcp.conversations.create-read', title: 'MCP Operator conversations preserve ownership, full snapshots and history after restart',
    lane: 'A1', authentication: 'operator', covers: mcpClaims('operator_chat_create', 'operator_chat_list',
      'operator_chat_get', 'operator_chat_history_get', 'operator_chat_activity_get'),
    async run(context) {
      const { operator, readOnly } = operatorClients(context)
      assertValue(await callTool(operator, 'operator_chat_list', {}, ListOperatorConversationsResponseSchema), { conversations: [] })
      await assertReadOnlyDenied(readOnly, 'operator_chat_create', CreateOperatorConversationRequestSchema.parse({
        commandId: randomUUID(), title: 'Denied conversation',
      }))
      const { input, result } = await createMcpConversation(operator, 'MCP owned conversation')
      const { conversation } = result
      const scope = { conversationId: conversation.id }
      await assertInvalidCallerDenied(operator, 'operator_chat_list', {})
      for (const tool of ['operator_chat_get', 'operator_chat_history_get', 'operator_chat_activity_get']) {
        await assertInvalidCallerDenied(operator, tool, scope)
      }
      const state = await callTool(operator, 'operator_chat_get', scope, GetOperatorConversationResponseSchema)
      assertEmptyOperatorState(state, conversation)
      const history = { ...scope, revision: 0, activeRequestId: null, entries: [], nextCursor: null }
      assertValue(await callTool(operator, 'operator_chat_history_get', scope, OperatorConversationHistoryPageSchema), history)
      assertValue(await callTool(operator, 'operator_chat_activity_get', scope, OperatorActivityPageSchema), { activities: [], nextCursor: null })
      await context.target.restart()
      assert.deepStrictEqual(await callTool(operator, 'operator_chat_create', input, CreateOperatorConversationResponseSchema), result)
      assertValue(await callTool(operator, 'operator_chat_list', {}, ListOperatorConversationsResponseSchema), { conversations: [conversation] })
      assert.deepStrictEqual(await callTool(operator, 'operator_chat_get', scope, GetOperatorConversationResponseSchema), state)
      assertValue(await callTool(operator, 'operator_chat_history_get', scope, OperatorConversationHistoryPageSchema), history)
      assertValue(await callTool(operator, 'operator_chat_activity_get', scope, OperatorActivityPageSchema), { activities: [], nextCursor: null })
      const headers = { token: context.target.operatorToken! }
      assertResponse(await context.http.request('GET', `/api/operator/conversations/${conversation.id}`, headers), { status: 200, body: state })
      assertResponse(await context.http.request('GET', `/api/operator/conversations/${conversation.id}/history`, headers), { status: 200, body: history })
      assertResponse(await context.http.request('GET', `/api/operator/conversations/${conversation.id}/activity`, headers), {
        status: 200, body: { activities: [], nextCursor: null },
      })
    },
  },
  {
    id: 'mcp.conversations.delete-restore', title: 'MCP deletion and restoration persist without reapplying an old command',
    lane: 'A1', authentication: 'operator', covers: mcpClaims('operator_chat_delete', 'operator_chat_restore'),
    async run(context) {
      const { operator, readOnly } = operatorClients(context)
      const { result: { conversation } } = await createMcpConversation(operator, 'MCP restorable conversation')
      const remove = OperatorConversationDeletionInputSchema.parse({ commandId: randomUUID(), conversationId: conversation.id })
      await assertReadOnlyDenied(readOnly, 'operator_chat_delete', remove)
      const deleted = await callTool(operator, 'operator_chat_delete', remove, DeleteOperatorConversationResponseSchema)
      assertValue(deleted, { conversationId: conversation.id, revision: 1 })
      assertToolFailure(await operator.callTool('operator_chat_get', { conversationId: conversation.id }), {
        code: 'CONVERSATION_NOT_FOUND', message: 'Conversation was not found.',
      })
      await context.target.restart()
      assertValue(await callTool(operator, 'operator_chat_list', {}, ListOperatorConversationsResponseSchema), { conversations: [] })
      const restore = OperatorConversationDeletionInputSchema.parse({ commandId: randomUUID(), conversationId: conversation.id })
      await assertReadOnlyDenied(readOnly, 'operator_chat_restore', restore)
      const restored = await callTool(operator, 'operator_chat_restore', restore, DeleteOperatorConversationResponseSchema)
      assertValue(restored, { conversationId: conversation.id, revision: 2 })
      assert.deepStrictEqual(await callTool(operator, 'operator_chat_delete', remove, DeleteOperatorConversationResponseSchema), deleted)
      await context.target.restart()
      assert.deepStrictEqual(await callTool(operator, 'operator_chat_restore', restore, DeleteOperatorConversationResponseSchema), restored)
      const state = await callTool(operator, 'operator_chat_get', { conversationId: conversation.id }, GetOperatorConversationResponseSchema)
      assertEmptyOperatorState(state, conversation, 2)
      assertValue(await callTool(operator, 'operator_chat_list', {}, ListOperatorConversationsResponseSchema), { conversations: [conversation] })
      assertResponse(await context.http.request('GET', `/api/operator/conversations/${conversation.id}`, {
        token: context.target.operatorToken!,
      }), { status: 200, body: state })
    },
  },
]
