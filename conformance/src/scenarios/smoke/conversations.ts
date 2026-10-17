import { randomUUID } from 'node:crypto'
import {
  CreateOperatorConversationRequestSchema,
  CreateOperatorConversationResponseSchema,
  ListOperatorConversationsResponseSchema,
} from '@foreman-code/contracts'
import { OperatorConversationHistoryPageSchema } from '@foreman-code/contracts/operator-chat'
import { DEFAULT_PROMPT_TEXT } from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { assertApiError, httpCoverage } from './support.js'

const conversationsPath = '/api/operator/conversations'
const conversationPath = `${conversationsPath}/:conversationId`

export async function createConversation(ctx: ScenarioContext, title: string) {
  const input = CreateOperatorConversationRequestSchema.parse({ commandId: randomUUID(), title })
  const response = await ctx.http.request('POST', conversationsPath, { body: input })
  const { conversation } = CreateOperatorConversationResponseSchema.parse(response.body)
  assertResponse(response, {
    status: 201,
    body: { conversation: {
      id: '<uuid>', agentId: 'application-operator', scope: 'application',
      operatorConfigurationVersionId: '<id>',
      initialPrompt: { value: DEFAULT_PROMPT_TEXT, revision: 0, versionId: null },
      title, status: 'open', createdAt: '<timestamp>', updatedAt: '<timestamp>',
    } },
  }, [
    { pointer: '/body/conversation/id', kind: 'uuid' },
    { pointer: '/body/conversation/operatorConfigurationVersionId', kind: 'id' },
    { pointer: '/body/conversation/createdAt', kind: 'timestamp' },
    { pointer: '/body/conversation/updatedAt', kind: 'timestamp' },
  ])
  return { input, conversation }
}

async function readEmptyHistory(ctx: ScenarioContext, conversationId: string, revision: number) {
  const response = await ctx.http.request('GET', `${conversationsPath}/${conversationId}/history`)
  OperatorConversationHistoryPageSchema.parse(response.body)
  assertResponse(response, {
    status: 200,
    body: { conversationId, revision, activeRequestId: null, entries: [], nextCursor: null },
  })
}

export const conversationScenarios: Scenario[] = [
  {
    id: 'conversation.create-list', title: 'A created Operator conversation appears as the exact persisted record', lane: 'A1',
    covers: [httpCoverage('POST', conversationsPath, 'success'), httpCoverage('GET', conversationsPath, 'success')],
    async run(ctx) {
      assertResponse(await ctx.http.request('GET', conversationsPath), { status: 200, body: { conversations: [] } })
      const { conversation } = await createConversation(ctx, 'Conformance conversation')
      const response = await ctx.http.request('GET', conversationsPath)
      ListOperatorConversationsResponseSchema.parse(response.body)
      assertResponse(response, { status: 200, body: { conversations: [conversation] } })
    },
  },
  {
    id: 'conversation.create-replay-history', title: 'Conversation creation replay retains identity and empty durable history', lane: 'A1',
    covers: [httpCoverage('POST', conversationsPath, 'success'), httpCoverage('GET', `${conversationPath}/history`, 'success')],
    async run(ctx) {
      const { input, conversation } = await createConversation(ctx, 'Conformance conversation receipt')
      const replay = await ctx.http.request('POST', conversationsPath, { body: input })
      assertResponse(replay, { status: 201, body: { conversation } })
      await readEmptyHistory(ctx, conversation.id, 0)
      assertResponse(await ctx.http.request('GET', conversationsPath), { status: 200, body: { conversations: [conversation] } })
    },
  },
  {
    id: 'conversation.delete-restore', title: 'Deleting and restoring a conversation fences reads and preserves its history', lane: 'A1',
    covers: [httpCoverage('DELETE', conversationPath, 'success'), httpCoverage('POST', `${conversationPath}/restore`, 'success'),
      httpCoverage('GET', `${conversationPath}/history`, 'error')],
    async run(ctx) {
      const { conversation } = await createConversation(ctx, 'Conformance conversation deletion')
      const path = `${conversationsPath}/${conversation.id}`
      assertResponse(await ctx.http.request('DELETE', path), {
        status: 200, body: { conversationId: conversation.id, revision: 1 },
      })
      assertResponse(await ctx.http.request('GET', conversationsPath), { status: 200, body: { conversations: [] } })
      assertApiError(await ctx.http.request('GET', `${path}/history`), 404, 'CONVERSATION_NOT_FOUND', 'Conversation was not found.')
      assertResponse(await ctx.http.request('POST', `${path}/restore`), {
        status: 200, body: { conversationId: conversation.id, revision: 2 },
      })
      await readEmptyHistory(ctx, conversation.id, 2)
      assertResponse(await ctx.http.request('GET', conversationsPath), { status: 200, body: { conversations: [conversation] } })
    },
  },
]
