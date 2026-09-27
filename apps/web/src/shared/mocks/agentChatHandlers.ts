import { http, HttpResponse } from 'msw'
import {
  AgentChatContextSchema, AgentChatQuerySchema, AgentChatStateSchema, CancelQueuedAgentChatTurnRequestSchema,
  InterruptAgentChatRequestSchema, RespondAgentChatInteractionRequestSchema, SendAgentChatMessageRequestSchema,
  SendAgentChatMessageResponseSchema, agentChatFixtures, type AgentChatContext, type AgentChatState,
  type AgentChatTurn, type SendAgentChatMessageResponse,
} from '@graphql/contracts/agent-chat'
import type { ManagementAction } from '@graphql/contracts/management'
import { agentChatContextKey } from '../../features/conversations/agentChat/model'

const at = '2026-09-27T12:00:00.000Z'
const root = '/api/workspaces/:workspaceId/agent-chat'
export const agentChatTestActions: ManagementAction[] = ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'agent_chat:respond']
const failure = (code: string, message: string, status = 409) => HttpResponse.json({ error: { code, message } }, { status })

/** Derive a distinct selection from the frozen fixtures, without making native runtime claims. */
export function agentChatFixtureFor(state: AgentChatState, context: AgentChatContext, conversationId = state.conversation?.id): AgentChatState {
  const result = structuredClone(state)
  result.context = { ...context }
  if (result.conversation) {
    const { runId, ...identity } = context
    result.conversation = { ...result.conversation, ...identity, id: conversationId!, origin: runId
      ? { kind: 'run_execution', runId, executionId: `execution-${runId}`, sourceNativeSessionId: `source-${runId}` } : { kind: 'fresh' } }
    result.messages = result.messages.map((message) => ({ ...message, conversationId: result.conversation!.id }))
  }
  return AgentChatStateSchema.parse(result)
}

/** Deterministic HTTP fixtures. This is a test server, never a native-session simulator. */
export function createAgentChatMock(initial: AgentChatState = agentChatFixtures.empty, actions: ManagementAction[] = agentChatTestActions) {
  const states = new Map<string, AgentChatState>(), receipts = new Map<string, { input: string; response: SendAgentChatMessageResponse }>()
  const calls: { method: string; path: string; body?: unknown }[] = []
  let serial = 0
  const setState = (state: AgentChatState) => { states.set(agentChatContextKey(state.context), AgentChatStateSchema.parse(structuredClone(state))) }
  const reset = () => { states.clear(); receipts.clear(); calls.length = 0; serial = 0; setState(initial) }
  reset()
  const getState = (context: AgentChatContext) => states.get(agentChatContextKey(context)) ?? agentChatFixtureFor(agentChatFixtures.empty, context)
  const find = (workspaceId: string, id: string) => [...states.values()].find((state) => state.context.workspaceId === workspaceId && state.conversation?.id === id)
  const record = (request: Request, body?: unknown) => calls.push({ method: request.method, path: new URL(request.url).pathname, body })
  const commandState = (state: AgentChatState) => { setState(state); return HttpResponse.json({ state: getState(state.context) }) }
  const handlers = [
    http.get('/api/auth/session', () => HttpResponse.json({ principal: { id: 'chat-test-principal', name: 'Chat tester',
      expiresAt: '2099-01-01T00:00:00.000Z', grants: actions.length ? [{ actions, scope: {} }] : [] } })),
    http.get(root, ({ request, params }) => {
      record(request)
      const query = AgentChatQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams))
      return HttpResponse.json(getState(AgentChatContextSchema.parse({ workspaceId: params.workspaceId, ...query })))
    }),
    http.post(`${root}/messages`, async ({ request, params }) => {
      const input = SendAgentChatMessageRequestSchema.parse(await request.json()); record(request, input)
      const context = AgentChatContextSchema.parse({ workspaceId: params.workspaceId, ...input.context })
      const key = `${agentChatContextKey(context)}:${input.requestId}`, previous = receipts.get(key)
      if (previous) return previous.input === JSON.stringify(input)
        ? HttpResponse.json({ ...previous.response, replayed: true }) : failure('AGENT_CHAT_REQUEST_CONFLICT', 'The requestId was used for different input.')
      const before = getState(context)
      if (input.expectedConversationId !== (before.conversation?.id ?? null)) return failure('AGENT_CHAT_CONTEXT_STALE', 'The conversation changed.')
      if (!before.availability.canSend) return failure('AGENT_CHAT_UNAVAILABLE', before.availability.message ?? 'Chat is unavailable.')
      if (input.intent === 'steer' && (!before.activeTurn || before.capabilities.steer === 'native_expected_turn' && input.expectedNativeTurnId !== before.activeTurn.nativeTurnId)) {
        return failure('AGENT_CHAT_TURN_NOT_ACTIVE', 'The targeted native turn finished.')
      }
      const conversation = before.conversation ?? agentChatFixtureFor(agentChatFixtures.active, context, `conversation-created-${++serial}`).conversation!
      const turn: AgentChatTurn = { requestId: input.requestId, messageId: `message-${input.requestId}`, intent: input.intent,
        sequence: String(before.turns.reduce((max, item) => Math.max(max, Number(item.sequence)), 0) + 1),
        delivery: before.activeTurn && input.intent === 'next_turn' ? 'queued' : 'accepted',
        ...(input.expectedNativeTurnId ? { targetNativeTurnId: input.expectedNativeTurnId } : {}), createdAt: at, updatedAt: at }
      const activeTurn = turn.delivery === 'queued' || input.intent === 'steer' ? before.activeTurn
        : { requestId: turn.requestId, nativeTurnId: `native-${turn.requestId}`, startedAt: at }
      const state = AgentChatStateSchema.parse({ ...before, conversation, activeTurn, sessionState: 'active', revision: before.revision + 1,
        turns: [...before.turns, turn], messages: [...before.messages, { id: turn.messageId, conversationId: conversation.id, requestId: turn.requestId,
          role: 'user', content: input.content, createdAt: at }] })
      setState(state)
      const response = SendAgentChatMessageResponseSchema.parse({ state, turn, replayed: false })
      receipts.set(key, { input: JSON.stringify(input), response })
      return HttpResponse.json(response)
    }),
    http.post(`${root}/conversations/:id/interrupt`, async ({ request, params }) => {
      const input = InterruptAgentChatRequestSchema.parse(await request.json()); record(request, input)
      const state = find(String(params.workspaceId), String(params.id))
      if (!state) return failure('NOT_FOUND', 'Conversation not found.', 404)
      return commandState({ ...state, revision: state.revision + 1, sessionState: 'idle', activeTurn: null,
        turns: state.turns.map((turn) => ['queued', 'accepted', 'submitting'].includes(turn.delivery) ? { ...turn, delivery: 'canceled' } : turn) })
    }),
    http.post(`${root}/conversations/:id/turns/:turnRequestId/cancel`, async ({ request, params }) => {
      const input = CancelQueuedAgentChatTurnRequestSchema.parse(await request.json()); record(request, input)
      const state = find(String(params.workspaceId), String(params.id))
      if (!state) return failure('NOT_FOUND', 'Conversation not found.', 404)
      if (state.turns.find((turn) => turn.requestId === params.turnRequestId)?.delivery !== 'queued') return failure('AGENT_CHAT_TURN_NOT_ACTIVE', 'The queued message already started.')
      return commandState({ ...state, revision: state.revision + 1, turns: state.turns.map((turn) => turn.requestId === params.turnRequestId ? { ...turn, delivery: 'canceled' } : turn) })
    }),
    http.post(`${root}/conversations/:id/responses`, async ({ request, params }) => {
      const input = RespondAgentChatInteractionRequestSchema.parse(await request.json()); record(request, input)
      const state = find(String(params.workspaceId), String(params.id))
      if (!state) return failure('NOT_FOUND', 'Conversation not found.', 404)
      if (!actions.includes('agent_chat:respond')) return failure('FORBIDDEN', 'Approval access denied.', 403)
      if (state.pendingInteraction?.turn.nativeRequestId !== input.nativeRequestId
        || !state.pendingInteraction.responseOptions.some((option) => option.optionId === input.optionId)) return failure('AGENT_CHAT_CONTEXT_STALE', 'The native request changed.')
      const next = { ...state, revision: state.revision + 1, sessionState: 'active' as const }
      delete next.pendingInteraction
      return commandState(next)
    }),
    http.get(`${root}/conversations/:id/history`, ({ request, params }) => {
      record(request)
      if (!find(String(params.workspaceId), String(params.id))) return failure('NOT_FOUND', 'Conversation not found.', 404)
      return HttpResponse.json({ conversationId: params.id, messages: [], nextCursor: null })
    }),
    http.get(`${root}/conversations/:id/events`, ({ request, params }) => {
      record(request)
      const state = find(String(params.workspaceId), String(params.id))
      if (!state) return failure('NOT_FOUND', 'Conversation not found.', 404)
      const event = { id: 0, conversationId: params.id, type: 'snapshot', data: state }
      return new HttpResponse(`event: snapshot\nid: 0\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    }),
  ]
  return { handlers, calls, getState, setState, reset }
}

const defaultMock = createAgentChatMock()
/** Authentication remains owned by the existing global mock; individual chat tests opt into grants. */
export const agentChatHandlers = defaultMock.handlers.slice(1)
export const resetAgentChatFixtures = defaultMock.reset
