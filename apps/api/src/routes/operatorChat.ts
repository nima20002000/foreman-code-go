import {
  CancelOperatorTurnRequestSchema, CancelOperatorTurnResponseSchema,
  CreateOperatorConversationRequestSchema, CreateOperatorConversationResponseSchema,
  GetOperatorConversationResponseSchema, ListOperatorConversationsResponseSchema,
  ListOperatorConversationSummariesResponseSchema,
  SendOperatorMessageRequestSchema, SendOperatorMessageResponseSchema,
  RespondOperatorInteractionRequestSchema,
  type OperatorConversationStreamEvent,
} from '@graphql/contracts'
import type { FastifyInstance } from 'fastify'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { OperatorChatService } from '../modules/conversations/operatorChat.js'
import { createSseWriter } from './sseWriter.js'

interface ConversationParams { conversationId: string }
const MAX_STREAMS = 64
const MAX_OWNER_STREAMS = 8
const MAX_BOOTSTRAP_BYTES = 256 * 1024
const MAX_BOOTSTRAP_EVENTS = 128

export function registerOperatorChatRoutes(app: FastifyInstance, chat: OperatorChatService): void {
  const streams = new Map<() => void, string>()
  app.addHook('preClose', async () => { for (const stop of streams.keys()) stop(); streams.clear() })

  app.get('/api/operator/conversations/summaries', async (request) =>
    ListOperatorConversationSummariesResponseSchema.parse({ conversations: await chat.summaries(requirePrincipal(request)) }))
  app.get('/api/operator/conversations', async (request) =>
    ListOperatorConversationsResponseSchema.parse({ conversations: await chat.list(requirePrincipal(request)) }))
  app.post<{ Body: unknown }>('/api/operator/conversations', async (request, reply) => {
    const input = CreateOperatorConversationRequestSchema.parse(request.body ?? {})
    reply.code(201)
    return CreateOperatorConversationResponseSchema.parse({ conversation: await chat.create(requirePrincipal(request), input.title) })
  })
  app.get<{ Params: ConversationParams }>('/api/operator/conversations/:conversationId', async (request) =>
    GetOperatorConversationResponseSchema.parse(await chat.get(request.params.conversationId, requirePrincipal(request))))
  app.post<{ Params: ConversationParams; Body: unknown }>('/api/operator/conversations/:conversationId/messages', async (request, reply) => {
    const input = SendOperatorMessageRequestSchema.parse(request.body)
    const result = await chat.send(request.params.conversationId, input, requirePrincipal(request))
    reply.code(result.replayed ? 200 : 202)
    return SendOperatorMessageResponseSchema.parse(result)
  })
  app.post<{ Params: ConversationParams; Body: unknown }>('/api/operator/conversations/:conversationId/cancel', async (request) => {
    const input = CancelOperatorTurnRequestSchema.parse(request.body)
    return CancelOperatorTurnResponseSchema.parse({ state: await chat.cancel(request.params.conversationId, input.requestId, requirePrincipal(request)) })
  })
  app.post<{ Params: ConversationParams; Body: unknown }>('/api/operator/conversations/:conversationId/responses', async (request) => {
    const input = RespondOperatorInteractionRequestSchema.parse(request.body)
    return CancelOperatorTurnResponseSchema.parse({ state: await chat.respond(request.params.conversationId, input, requirePrincipal(request)) })
  })

  app.get<{ Params: ConversationParams }>('/api/operator/conversations/:conversationId/events', async (request, reply) => {
    let principal = requirePrincipal(request)
    if (!request.reauthorizeOperator) throw new DomainError('AUTH_REQUIRED', 'Stream reauthorization is unavailable.', 401)
    if (streams.size >= MAX_STREAMS || [...streams.values()].filter((owner) => owner === principal.id).length >= MAX_OWNER_STREAMS) {
      throw new DomainError('STREAM_LIMIT', 'Too many open Operator streams. Close an inactive tab and retry.', 429)
    }
    const id = request.params.conversationId
    let stopped = false
    let bootstrapping = true
    let bytes = 0
    let heartbeat: NodeJS.Timeout | undefined
    let checking = false
    let unsubscribe = () => {}
    const queued: string[] = []
    const stop = () => {
      if (stopped) return
      stopped = true; writer.close(); clearInterval(heartbeat); unsubscribe(); streams.delete(stop)
      if (reply.raw.headersSent && !reply.raw.writableEnded) reply.raw.end()
    }
    const writer = createSseWriter(reply.raw,
      () => !stopped && Date.parse(principal.expiresAt) > Date.now(), stop)
    const write = (frame: string) => writer.write(frame)
    const event = (value: OperatorConversationStreamEvent) => {
      const frame = `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`
      if (bootstrapping) {
        bytes += Buffer.byteLength(frame)
        if (queued.length >= MAX_BOOTSTRAP_EVENTS || bytes > MAX_BOOTSTRAP_BYTES) { stop(); return }
        queued.push(frame)
      } else write(frame)
    }
    // Subscribe before the first asynchronous snapshot read. Nothing is disclosed before access succeeds.
    unsubscribe = chat.events.subscribe(id, event)
    streams.set(stop, principal.id)
    reply.raw.once('close', stop); reply.raw.once('error', stop)
    try {
      const snapshot = await chat.get(id, principal)
      principal = await request.reauthorizeOperator()
      await chat.assertAccess(id, principal)
      if (stopped) throw new DomainError('STREAM_RECONNECT_REQUIRED', 'Stream initialization overflowed or disconnected. Reconnect for a fresh snapshot.', 503)
      reply.hijack()
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive', 'x-accel-buffering': 'no' })
      // Last-Event-ID is a hint only: every connection starts from an authoritative revisioned snapshot.
      // Transient deltas have no replay cursor and must never substitute for persisted messages.
      write(`id: ${snapshot.revision}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
      bootstrapping = false
      for (const frame of queued) write(frame)
      queued.length = 0
      if (stopped) return
      heartbeat = setInterval(() => {
        if (checking || stopped) return
        checking = true
        void (async () => {
          principal = await request.reauthorizeOperator!()
          await chat.assertAccess(id, principal)
          write(': heartbeat\n\n')
        })().catch(stop).finally(() => { checking = false })
      }, 5_000)
      heartbeat.unref()
    } catch (error) { stop(); throw error }
  })
}
