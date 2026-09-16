import {
  CancelOperatorTurnResponseSchema,
  CreateOperatorConversationRequestSchema,
  CreateOperatorConversationResponseSchema,
  GetOperatorConversationResponseSchema,
  ListOperatorConversationsResponseSchema,
  SendOperatorMessageRequestSchema,
  SendOperatorMessageResponseSchema,
} from '@graphql/contracts'
import type { FastifyInstance } from 'fastify'
import type { ServerResponse } from 'node:http'

import type { OperatorChatService } from '../modules/conversations/operatorChat.js'

interface ConversationParams { conversationId: string }

export function registerOperatorChatRoutes(app: FastifyInstance, chat: OperatorChatService): void {
  const streams = new Set<ServerResponse>()
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end()
    streams.clear()
  })
  app.get('/api/operator/conversations', async () =>
    ListOperatorConversationsResponseSchema.parse({ conversations: await chat.list() }))
  app.post<{ Body: unknown }>('/api/operator/conversations', async (request, reply) => {
    const input = CreateOperatorConversationRequestSchema.parse(request.body ?? {})
    reply.code(201)
    return CreateOperatorConversationResponseSchema.parse({ conversation: await chat.create(input.title) })
  })
  app.get<{ Params: ConversationParams }>('/api/operator/conversations/:conversationId', async (request) =>
    GetOperatorConversationResponseSchema.parse(await chat.get(request.params.conversationId)))
  app.post<{ Params: ConversationParams; Body: unknown }>('/api/operator/conversations/:conversationId/messages', async (request, reply) => {
    const input = SendOperatorMessageRequestSchema.parse(request.body)
    const result = await chat.send(request.params.conversationId, {
      requestId: input.requestId, content: input.content, ...(input.context ? { context: input.context } : {}),
    })
    reply.code(result.replayed ? 200 : 202)
    return SendOperatorMessageResponseSchema.parse(result)
  })
  app.post<{ Params: ConversationParams }>('/api/operator/conversations/:conversationId/cancel', async (request) =>
    CancelOperatorTurnResponseSchema.parse({ state: await chat.cancel(request.params.conversationId) }))
  app.get<{ Params: ConversationParams }>('/api/operator/conversations/:conversationId/events', async (request, reply) => {
    const snapshot = await chat.get(request.params.conversationId)
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive', 'x-accel-buffering': 'no',
    })
    reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
    streams.add(reply.raw)
    const unsubscribe = chat.events.subscribe(request.params.conversationId, (event) => {
      reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    })
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000)
    request.raw.once('close', () => { clearInterval(heartbeat); unsubscribe(); streams.delete(reply.raw) })
  })
}
