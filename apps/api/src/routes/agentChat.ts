import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  AgentChatHistoryPageSchema, AgentChatQuerySchema, AgentChatStateResponseSchema, AgentChatStateSchema, CancelQueuedAgentChatTurnRequestSchema,
  InterruptAgentChatRequestSchema, RespondAgentChatInteractionRequestSchema, SendAgentChatMessageRequestSchema,
  SendAgentChatMessageResponseSchema, type AgentChatStreamEvent,
} from '@graphql/contracts/agent-chat'
import { OperatorHistoryCursorSchema } from '@graphql/contracts/operator-chat'

import { requirePrincipal } from '../modules/access/http.js'
import type { AgentChatService } from '../modules/conversations/agentChat.js'
import { DomainError } from '../modules/errors.js'
import { createSseWriter } from './sseWriter.js'

interface WorkspaceParams { workspaceId: string }
interface ConversationParams extends WorkspaceParams { conversationId: string }
interface TurnParams extends ConversationParams { turnRequestId: string }
const HistoryQuerySchema = z.object({ before: OperatorHistoryCursorSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict()
const MAX_STREAMS = 64
const MAX_OWNER_STREAMS = 16
const MAX_BOOTSTRAP_EVENTS = 128

export function registerAgentChatRoutes(app: FastifyInstance, chat: AgentChatService): void {
  const root = '/api/workspaces/:workspaceId/agent-chat'
  const streams = new Map<() => void, string>()
  app.addHook('preClose', async () => { for (const stop of streams.keys()) stop(); streams.clear() })

  app.get<{ Params: WorkspaceParams; Querystring: unknown }>(root, async (request) =>
    AgentChatStateSchema.parse(await chat.read(requirePrincipal(request), request.params.workspaceId, AgentChatQuerySchema.parse(request.query))))
  app.post<{ Params: WorkspaceParams; Body: unknown }>(`${root}/messages`, async (request, reply) => {
    const result = await chat.send(requirePrincipal(request), request.params.workspaceId, SendAgentChatMessageRequestSchema.parse(request.body))
    reply.code(result.replayed ? 200 : 202)
    return SendAgentChatMessageResponseSchema.parse(result)
  })
  app.post<{ Params: ConversationParams; Body: unknown }>(`${root}/conversations/:conversationId/interrupt`, async (request) => {
    const input = InterruptAgentChatRequestSchema.parse(request.body)
    return AgentChatStateResponseSchema.parse({ state: await chat.interrupt(requirePrincipal(request), request.params.workspaceId,
      request.params.conversationId, input.expectedNativeTurnId) })
  })
  app.post<{ Params: TurnParams; Body: unknown }>(`${root}/conversations/:conversationId/turns/:turnRequestId/cancel`, async (request) => {
    CancelQueuedAgentChatTurnRequestSchema.parse(request.body)
    return AgentChatStateResponseSchema.parse({ state: await chat.cancelQueued(requirePrincipal(request), request.params.workspaceId,
      request.params.conversationId, request.params.turnRequestId) })
  })
  app.post<{ Params: ConversationParams; Body: unknown }>(`${root}/conversations/:conversationId/responses`, async (request) => {
    const input = RespondAgentChatInteractionRequestSchema.parse(request.body)
    return AgentChatStateResponseSchema.parse({ state: await chat.respond(requirePrincipal(request), request.params.workspaceId,
      request.params.conversationId, input.nativeRequestId, input.optionId) })
  })
  app.get<{ Params: ConversationParams; Querystring: unknown }>(`${root}/conversations/:conversationId/history`, async (request) => {
    const query = HistoryQuerySchema.parse(request.query)
    return AgentChatHistoryPageSchema.parse(await chat.history(requirePrincipal(request), request.params.workspaceId,
      request.params.conversationId, query.before, query.limit))
  })

  app.get<{ Params: ConversationParams }>(`${root}/conversations/:conversationId/events`, async (request, reply) => {
    let principal = requirePrincipal(request)
    if (!request.reauthorizeOperator) throw new DomainError('AUTH_REQUIRED', 'Stream reauthorization is unavailable.', 401)
    if (streams.size >= MAX_STREAMS || [...streams.values()].filter((owner) => owner === principal.id).length >= MAX_OWNER_STREAMS) {
      throw new DomainError('STREAM_LIMIT', 'Too many open chat streams. Close an inactive tab and retry.', 429)
    }
    const { workspaceId, conversationId: id } = request.params
    let stopped = false
    let bootstrapping = true
    let heartbeat: NodeJS.Timeout | undefined
    let checking = false
    const queued: string[] = []
    const stop = () => {
      if (stopped) return
      stopped = true; writer.close(); clearInterval(heartbeat); unsubscribe(); streams.delete(stop)
      if (reply.raw.headersSent && !reply.raw.writableEnded) reply.raw.end()
    }
    const writer = createSseWriter(reply.raw, () => !stopped && Date.parse(principal.expiresAt) > Date.now(), stop)
    const frame = (value: AgentChatStreamEvent) => `event: ${value.type}\nid: ${value.id}\ndata: ${JSON.stringify(value)}\n\n`
    const event = (value: AgentChatStreamEvent) => {
      if (!bootstrapping) { writer.write(frame(value)); return }
      if (queued.length >= MAX_BOOTSTRAP_EVENTS) { stop(); return }
      queued.push(frame(value))
    }
    // Subscribe before the snapshot so nothing between the read and the stream is lost.
    const unsubscribe = chat.events.subscribe(id, event)
    streams.set(stop, principal.id)
    reply.raw.once('close', stop); reply.raw.once('error', stop)
    try {
      const snapshot = await chat.readConversation(principal, workspaceId, id)
      principal = await request.reauthorizeOperator()
      await chat.assertReadable(principal, workspaceId, id)
      if (stopped) throw new DomainError('STREAM_RECONNECT_REQUIRED', 'Stream initialization overflowed or disconnected. Reconnect for a fresh snapshot.', 503)
      reply.hijack()
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive', 'x-accel-buffering': 'no' })
      // Every connection starts from an authoritative snapshot; deltas are never replayed.
      writer.write(`event: snapshot\ndata: ${JSON.stringify({ id: 0, conversationId: id, type: 'snapshot', data: snapshot })}\n\n`)
      bootstrapping = false
      for (const queuedFrame of queued) writer.write(queuedFrame)
      queued.length = 0
      heartbeat = setInterval(() => {
        if (checking || stopped) return
        checking = true
        void (async () => {
          principal = await request.reauthorizeOperator!()
          await chat.assertReadable(principal, workspaceId, id)
          writer.write(': heartbeat\n\n')
        })().catch(stop).finally(() => { checking = false })
      }, 5_000)
      heartbeat.unref()
    } catch (error) { stop(); throw error }
  })
}
