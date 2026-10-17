import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  AgentChatContextSchema, AgentChatHistoryPageSchema, AgentChatTurnPageSchema, SendAgentChatMessageRequestSchema,
  type AgentChatState, type AgentChatStreamEvent,
} from '@foreman-code/contracts/agent-chat'
import { assertResponse } from '../../assertions.js'
import { openBrowserStream, StreamHttpError } from '../../clients/streams.js'
import type { Scenario } from '../../scenario.js'
import { assertProtectedRead, readCoverage } from '../http/support.js'
import { assertApiError, httpCoverage } from '../smoke/support.js'
import { createExecutableWorkflow } from '../workflows/authoring.js'
import { installCodexScripts, releaseCodexTurn } from '../workflows/codexScript.js'
import { agentLiveEvents, assertAgentSnapshot } from './agentFrames.js'
import {
  agentChatPath, agentChatReadPath, assertAgentAdmission, assertAgentState, assertEmptyAgentState,
  readAgentState, waitForActiveAgent,
} from './agentState.js'

const root = '/api/workspaces/:workspaceId/agent-chat'
const conversation = `${root}/conversations/:conversationId`
const eventsPath = `${conversation}/events`

export const agentStreamScenarios: Scenario[] = [{
  id: 'streams.agent.native-framing-order-reconnect',
  title: 'Agent browser stream preserves native text, durable receipt ordering and complete restart snapshots',
  lane: 'A1', timeoutMs: 120_000,
  covers: [
    ...(['framing', 'order', 'reconnect'] as const).map(caseName => ({ surface: 'stream' as const, name: eventsPath, case: caseName })),
    ...(['success', 'error'] as const).map(caseName => ({ surface: 'http' as const, method: 'GET', path: eventsPath, transport: 'sse' as const, case: caseName })),
    ...readCoverage(root), ...readCoverage(`${conversation}/history`), ...readCoverage(`${conversation}/turns`),
    httpCoverage('POST', `${root}/messages`, 'success'), httpCoverage('POST', `${root}/messages`, 'error'),
    { surface: 'harness', name: 'codex-native', case: 'success' },
  ],
  async run(ctx) {
    const fixture = await createExecutableWorkflow(ctx, { name: 'Agent native browser stream' })
    const node = fixture.saved.version.definition.nodes[0]!
    assert.notEqual(node.kind, 'job')
    if (node.kind === 'job') throw new Error('This Agent stream fixture requires an Agent node.')
    const context = AgentChatContextSchema.parse({ workspaceId: fixture.workspace.workspace.id,
      workflowId: fixture.workflow.workflow.id, workflowNodeId: node.id, agentId: node.agentId })
    const query = { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId }
    const before = await readAgentState(ctx, context)
    assertEmptyAgentState(before, context)
    await assertProtectedRead(ctx, agentChatReadPath(context), before)
    const answer = 'Agent native stream answer: two lines.\nUnicode stays exact: λ雪.'
    const input = SendAgentChatMessageRequestSchema.parse({ requestId: randomUUID(), context: query,
      content: 'Conformance held Agent native browser stream', expectedConversationId: null })
    const path = agentChatPath(context)
    await installCodexScripts(ctx, [{ id: 'agent-browser', includes: input.content,
      turns: [{ answer, holdUntilFile: 'release-agent-browser', holdTerminalUntilFile: 'finish-agent-browser' }] }])
    assertApiError(await ctx.http.request('POST', `${path}/messages`, {
      body: input, token: 'conformance-invalid-credential',
    }), 401, 'AUTH_INVALID', 'The supplied credential is invalid.')
    const expected = { context, configurationVersionId: fixture.saved.version.agentConfigurationVersionIds[node.agentId]!, input }
    const accepted = assertAgentAdmission(await ctx.http.request('POST', `${path}/messages`, { body: input }), expected)
    const active = await waitForActiveAgent(ctx, context)
    assertAgentState(active, { ...expected, phase: 'active', accepted })
    assert.notEqual(active.qualificationKey, before.qualificationKey)
    const conversationPath = `${path}/conversations/${active.conversation!.id}`
    await assert.rejects(() => openBrowserStream({ baseUrl: ctx.target.baseUrl, path: `${conversationPath}/events`,
      signal: ctx.signal, headers: ctx.http.requestHeaders({ token: 'conformance-invalid-credential' }) }), error => {
      assert.ok(error instanceof StreamHttpError)
      assertApiError({ status: error.status, body: error.body, headers: new Headers() },
        401, 'AUTH_INVALID', 'The supplied credential is invalid.')
      return true
    })
    const stream = await openBrowserStream({ baseUrl: ctx.target.baseUrl, path: `${conversationPath}/events`,
      signal: ctx.signal, headers: ctx.http.requestHeaders() })
    let completion: AgentChatStreamEvent[]
    let presented: AgentChatState
    try {
      await assertAgentSnapshot(stream, active)
      const live = agentLiveEvents(stream, active, answer)
      await live.heartbeat()
      assert.deepStrictEqual(await readAgentState(ctx, context), active,
        'A native heartbeat/reconciliation must not mutate a held accepted turn.')
      await releaseCodexTurn(ctx, 'release-agent-browser')
      await live.presented()
      presented = await readAgentState(ctx, context)
      assertAgentState(presented, { ...expected, phase: 'presented', accepted, answer })
      await releaseCodexTurn(ctx, 'finish-agent-browser')
      completion = await live.terminal()
    } finally { await stream.close() }
    const completed = await readAgentState(ctx, context)
    assertAgentState(completed, { ...expected, phase: 'completed', accepted, answer })
    assert.equal(completed.messages[1]!.id, presented.messages[1]!.id,
      'The final native item must update the same previously observed provisional message.')
    assert.equal(completed.messages[1]!.createdAt, presented.messages[1]!.createdAt)
    assert.notEqual(completed.qualificationKey, active.qualificationKey)
    await assertProtectedRead(ctx, agentChatReadPath(context), completed)
    const history = AgentChatHistoryPageSchema.parse({ conversationId: active.conversation!.id, messages: completed.messages, nextCursor: null })
    const turns = AgentChatTurnPageSchema.parse({ conversationId: active.conversation!.id, turns: completed.turns, nextCursor: null })
    await assertProtectedRead(ctx, `${conversationPath}/history`, history)
    await assertProtectedRead(ctx, `${conversationPath}/turns`, turns)
    assertResponse(await ctx.http.request('POST', `${path}/messages`, { body: input }), {
      status: 200, body: { replayed: true, state: completed, turn: completed.turns[0] },
    })
    assertApiError(await ctx.http.request('POST', `${path}/messages`, { body: { ...input, content: 'Changed receipt payload' } }),
      409, 'AGENT_CHAT_REQUEST_CONFLICT', 'This request ID was already used with a different message.')
    await ctx.target.restart()
    await assertProtectedRead(ctx, agentChatReadPath(context), completed)
    await assertProtectedRead(ctx, `${conversationPath}/history`, history)
    await assertProtectedRead(ctx, `${conversationPath}/turns`, turns)
    const reconnected = await openBrowserStream({ baseUrl: ctx.target.baseUrl, path: `${conversationPath}/events`,
      signal: ctx.signal, headers: ctx.http.requestHeaders(), lastEventId: String(completion.at(-1)!.id) })
    try { await assertAgentSnapshot(reconnected, completed) }
    finally { await reconnected.close() }
  },
}]
