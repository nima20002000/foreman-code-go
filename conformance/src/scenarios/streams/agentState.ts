import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import {
  DEFAULT_PROMPT_TEXT, type ActivityItem, type ActivitySnapshotV1, type Message, type WorkRef,
} from '@foreman-code/contracts'
import {
  AgentChatStateSchema, SendAgentChatMessageResponseSchema, codexChatCapabilities,
  type AgentChatContext, type AgentChatState, type SendAgentChatMessageRequest,
} from '@foreman-code/contracts/agent-chat'
import { assertJson, assertResponse, type NormalizationRule } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'

const availability = { canSend: true, message: 'Foreman Code workflow tools are not available in chat. The scoped Foreman Code App MCP server is disabled for chat only; other accepted Agent settings are retained.' }

export function agentChatPath(context: AgentChatContext): string {
  return `/api/workspaces/${context.workspaceId}/agent-chat`
}

export function agentChatReadPath(context: AgentChatContext): string {
  const query = new URLSearchParams({ workflowId: context.workflowId, workflowNodeId: context.workflowNodeId,
    agentId: context.agentId })
  if (context.runId !== undefined) query.set('runId', context.runId)
  return `${agentChatPath(context)}?${query.toString()}`
}

export async function readAgentState(ctx: ScenarioContext, context: AgentChatContext) {
  const response = await ctx.http.request('GET', agentChatReadPath(context))
  assert.equal(response.status, 200)
  const state = AgentChatStateSchema.parse(response.body)
  assert.deepStrictEqual(state, response.body)
  return state
}

export function assertEmptyAgentState(state: AgentChatState, context: AgentChatContext): void {
  assert.match(state.qualificationKey!, /^[0-9a-f]{64}$/)
  assertJson(state, { context, conversation: null, sessionState: 'none', availability,
    capabilities: { ...codexChatCapabilities, providerVersion: null }, activeTurn: null,
    turns: [], messages: [], hasEarlierMessages: false, activities: [], revision: 0,
    qualificationKey: '<id>',
  }, [{ pointer: '/body/qualificationKey', kind: 'id' }])
}

function textItem(message: Message, owner: WorkRef, native?: ActivityItem['native']): ActivityItem {
  return { id: `message:${message.id}`, messageId: message.id, role: message.role,
    revision: message.revision!, order: message.sequence!, orderSource: 'conversation_message', owner,
    ...(native ? { native } : {}),
    ...(message.afterActivitySequence === undefined ? {} : { afterActivitySequence: '0' }),
    source: { schemaVersion: 1, system: 'conversation_message', observedAt: null },
    evidence: 'confirmed', kind: 'text', text: message.content,
    finality: message.nativeMessageComplete === false ? 'provisional' : 'authoritative_final' }
}

export interface AgentStateExpectation {
  context: AgentChatContext
  configurationVersionId: string
  input: SendAgentChatMessageRequest
  phase: 'admitting' | 'active' | 'presented' | 'completed'
  answer?: string
  accepted?: ReturnType<typeof SendAgentChatMessageResponseSchema.parse>
}

/** Enumerate the real admission stages; revisions and payload fields are never discarded. */
export function assertAgentState(state: AgentChatState, expected: AgentStateExpectation): void {
  const { context, input, accepted } = expected
  const revision = expected.phase === 'admitting' ? state.revision
    : expected.phase === 'active' ? 5 : expected.phase === 'presented' ? 6 : 8
  if (expected.phase === 'admitting') assert.ok([1, 2, 3, 4, 5].includes(revision), 'A held first turn cannot finish during admission.')
  const completed = expected.phase === 'completed'
  const hasAnswer = completed || expected.phase === 'presented'
  const owning = revision >= 2 && !completed
  const bound = revision >= 4
  const nativeAccepted = revision >= 5
  assert.ok(state.conversation)
  const conversationId = state.conversation.id
  const userId = accepted?.turn.messageId ?? state.messages[0]?.id
  assert.ok(userId)
  const nativeSessionId = bound ? state.conversation.nativeSession?.nativeSessionId : undefined
  if (bound) assert.match(nativeSessionId!, /^thread-agent-a-[1-9][0-9]*-1$/)
  const native = { harness: 'codex', sessionId: nativeSessionId!, turnId: 'turn-1', itemId: 'answer-turn-1' }
  const owner: WorkRef = { kind: 'chat_request', conversationId, requestId: input.requestId }
  const user: Message = { id: userId, conversationId, requestId: input.requestId, role: 'user',
    content: input.content, createdAt: '<timestamp>', updatedAt: '<timestamp>', revision: '0', sequence: '1' }
  const messages: Message[] = [user]
  if (hasAnswer) {
    assert.equal(typeof expected.answer, 'string')
    assert.equal(state.messages.length, 2, 'Duplicate native completion must persist exactly one assistant answer.')
    messages.push({ id: state.messages[1]!.id, conversationId, requestId: input.requestId, role: 'assistant',
      content: expected.answer!, nativeMessageId: 'answer-turn-1', nativeMessageComplete: completed,
      activityNative: native, activityChannel: 'assistant', afterActivitySequence: '0',
      createdAt: '<timestamp>', updatedAt: '<timestamp>', revision: completed ? '1' : '0', sequence: '2' })
  }
  const providerVersion = expected.phase === 'admitting' ? state.capabilities.providerVersion : '0.154.0'
  assert.ok(bound ? [null, '0.154.0'].includes(providerVersion) : providerVersion === null)
  const snapshot: ActivitySnapshotV1 = {
    schemaVersion: 1, scope: { kind: 'agent_chat', conversationId, workspaceId: context.workspaceId,
      workflowId: context.workflowId, nodeId: context.workflowNodeId, agentId: context.agentId },
    revision: String(revision), sourceRevisions: [{ source: 'scope', id: conversationId, revision: String(revision) },
      ...messages.map(message => ({ source: 'message' as const, id: message.id, revision: message.revision! }))],
    active: owning ? [{ ref: owner, phase: nativeAccepted ? 'active' : 'preparing', outcome: null,
      delivery: nativeAccepted ? 'accepted' : 'submitting', evidence: 'confirmed', startedAt: '<timestamp>',
      ...(bound ? { native: { harness: 'codex', sessionId: nativeSessionId!, ...(nativeAccepted ? { turnId: 'turn-1' } : {}) } } : {}) }] : [],
    queued: revision === 1 ? [owner] : [], latest: owner, pendingInteractions: [],
    activities: messages.map((message, index) => textItem(message, owner, index === 1 ? native : undefined)),
    page: { before: null, nextCursor: null, hasMore: false },
  }
  const rules: NormalizationRule[] = [
    { pointer: '/body/conversation/id', kind: 'uuid' },
    { pointer: '/body/conversation/createdAt', kind: 'timestamp' },
    { pointer: '/body/conversation/updatedAt', kind: 'timestamp' },
    { pointer: '/body/turns/0/createdAt', kind: 'timestamp' },
    { pointer: '/body/turns/0/updatedAt', kind: 'timestamp' },
    { pointer: '/body/qualificationKey', kind: 'id' },
    ...messages.flatMap((_, index): NormalizationRule[] => [
      { pointer: `/body/messages/${index}/id`, kind: 'uuid' },
      { pointer: `/body/messages/${index}/createdAt`, kind: 'timestamp' },
      { pointer: `/body/messages/${index}/updatedAt`, kind: 'timestamp' },
    ]),
  ]
  if (bound) rules.push({ pointer: '/body/conversation/nativeSession/nativeSessionId', kind: 'id' })
  if (owning) rules.push({ pointer: '/body/activeTurn/startedAt', kind: 'timestamp' },
    { pointer: '/body/activitySnapshot/active/0/startedAt', kind: 'timestamp' })
  assert.match(state.qualificationKey!, /^[0-9a-f]{64}$/)
  assertJson(state, { context, conversation: { id: '<uuid>', ...context,
    agentConfigurationVersionId: expected.configurationVersionId, harness: 'codex', origin: { kind: 'fresh' },
    providerAccountBinding: { kind: 'legacy-profile', provider: 'codex', target: null, profileRef: null, historicalSubject: 'unknown' },
    systemPrompt: { value: DEFAULT_PROMPT_TEXT, revision: 0, versionId: null },
    nativeSession: bound ? { nativeSessionId: '<id>', providerVersion: '0.154.0' } : null,
    createdAt: '<timestamp>', updatedAt: '<timestamp>' },
    sessionState: completed || revision === 1 ? 'idle' : bound ? 'active' : 'creating',
    availability, capabilities: { ...codexChatCapabilities, providerVersion },
    activeTurn: owning ? { requestId: input.requestId, ...(nativeAccepted ? { nativeTurnId: 'turn-1' } : {}), startedAt: '<timestamp>' } : null,
    turns: [{ requestId: input.requestId, sequence: '1', intent: 'next_turn', messageId: userId,
      delivery: completed ? 'completed' : nativeAccepted ? 'accepted' : revision === 1 ? 'queued' : 'submitting',
      ...(nativeAccepted ? { nativeTurnId: 'turn-1' } : {}), createdAt: '<timestamp>', updatedAt: '<timestamp>' }],
    messages: messages.map(message => ({ ...message, id: '<uuid>' })), hasEarlierMessages: false, activities: [],
    ...(completed ? { lastResult: { outcome: 'succeeded', output: { text: expected.answer } } } : {}),
    revision, activitySnapshot: snapshot, qualificationKey: '<id>',
  }, rules)
  assert.equal(state.messages[0]!.createdAt, state.messages[0]!.updatedAt)
  if (hasAnswer) {
    const assistant = state.messages[1]!
    if (!completed) assert.equal(assistant.createdAt, assistant.updatedAt)
    else assert.ok(Date.parse(assistant.updatedAt!) >= Date.parse(assistant.createdAt!))
  }
  if (owning) assert.equal(state.activeTurn!.startedAt, state.activitySnapshot!.active[0]!.startedAt)
  if (accepted) {
    assert.equal(conversationId, accepted.state.conversation!.id)
    assert.deepStrictEqual(state.messages[0], accepted.state.messages[0])
    assert.equal(state.conversation.createdAt, accepted.state.conversation!.createdAt)
    assert.equal(state.turns[0]!.createdAt, accepted.turn.createdAt)
  }
}

export function assertAgentAdmission(response: Awaited<ReturnType<ScenarioContext['http']['request']>>,
  expected: Omit<AgentStateExpectation, 'phase'>) {
  assert.equal(response.status, 202)
  const value = SendAgentChatMessageResponseSchema.parse(response.body)
  assert.deepStrictEqual(value, response.body)
  assertAgentState(value.state, { ...expected, phase: 'admitting' })
  assertResponse(response, { status: 202, body: { state: value.state, replayed: false,
    turn: { requestId: expected.input.requestId, sequence: '1', intent: 'next_turn', delivery: 'queued',
      messageId: value.state.messages[0]!.id, createdAt: '<timestamp>', updatedAt: '<timestamp>' } } }, [
    { pointer: '/body/turn/createdAt', kind: 'timestamp' }, { pointer: '/body/turn/updatedAt', kind: 'timestamp' },
  ])
  assert.equal(value.turn.createdAt, value.turn.updatedAt)
  return value
}

export async function waitForActiveAgent(ctx: ScenarioContext, context: AgentChatContext) {
  for (;;) {
    ctx.signal.throwIfAborted()
    const state = await readAgentState(ctx, context)
    if (state.sessionState === 'active' && state.turns[0]?.delivery === 'accepted') return state
    assert.ok(['idle', 'creating', 'active'].includes(state.sessionState), JSON.stringify(state))
    assert.ok(state.revision <= 5, 'A held native turn advanced beyond its accepted state.')
    await setTimeout(100, undefined, { signal: ctx.signal })
  }
}
