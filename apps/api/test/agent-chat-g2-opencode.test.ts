import assert from 'node:assert/strict'
import { MessageSchema } from '@graphql/contracts'
import { describe, it } from 'vitest'
import { agentChatCorrelation } from '../src/modules/conversations/agentChatRepository.js'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { nativeMessageId } from '../src/modules/harnesses/opencodeProtocol.js'
import { eventually, fixture } from './helpers/agentChatF1.js'
import { FixtureServer, request } from './opencode-fixtures.js'

/** Only extend the scripted store's message sink; no service/adapter lifecycle method is replaced.
 * Actual SQL isolation is covered by the opt-in PostgreSQL suite, not this HTTP/SSE substitute. */
function messageSink(f: ReturnType<typeof fixture>) {
  f.service['activity'].append = async () => undefined
  f.service['messages'].appendAssistantMessage = async (conversationId, requestId, nativeMessageId, content, metadata) => {
    const existing = [...f.store.messages.values()].find((message) => message.nativeMessageId === nativeMessageId)
    if (existing) return false
    const now = new Date().toISOString()
    const message = MessageSchema.parse({ id: `fixture-${nativeMessageId}`, conversationId, requestId, role: 'assistant', content,
      nativeMessageId, afterActivitySequence: '0',
      ...(metadata ? { nativeParentMessageId: metadata.parentMessageId, nativeMessageComplete: metadata.complete } : {}), createdAt: now, updatedAt: now })
    f.store.messages.set(message.id, message)
    return true
  }
  f.service['messages'].appendAssistantTextOperation = async (conversationId, requestId, operation) => {
    assert.equal(conversationId, f.store.row.id)
    assert.equal(requestId, f.store.row.active_request_id)
    assert.equal(operation.identity.sessionId, f.store.row.native_session_id)
    assert.equal(operation.identity.turnId, f.store.row.active_native_turn_id)
    assert(operation.identity.parentId)
    const inserted = await f.service['messages'].appendAssistantMessage(conversationId, requestId, operation.identity.itemId, operation.text,
      { parentMessageId: operation.identity.parentId, complete: operation.final })
    if (!inserted) return { status: 'ignored', revision: String(f.store.row.revision) }
    return { status: 'committed', revision: String(f.store.row.revision), messageRevision: String(f.store.row.revision) }
  }
  const connect = f.store.pool.connect.bind(f.store.pool)
  f.store.pool.connect = (async () => {
    const client = await connect()
    return new Proxy(client, {
      get(target, property) {
        if (property !== 'query') return Reflect.get(target, property)
        return async (text: string, values: unknown[] = []) => {
          const sql = text.replace(/\s+/g, ' ').trim()
          if (sql.startsWith('select 1 from operator_conversation_messages')) {
            const found = [...f.store.messages.values()].some((message) => message.nativeMessageId === values[1]
              || message.nativeParentMessageId === values[1] && message.requestId === values[2])
            return { rows: found ? [{ '1': 1 }] : [], rowCount: found ? 1 : 0 }
          }
          if (sql.startsWith('select coalesce(max(sequence),0)::text as sequence')) return { rows: [{ sequence: '0' }], rowCount: 1 }
          return target.query(text, values)
        }
      },
    })
  }) as typeof f.store.pool.connect
}

describe('G2 A2-PF-03: actual OpenCode adapter, synthetic HTTP/SSE only', () => {
  it('releases a heartbeat-producing watcher after terminal history and starts B once on the same session', async () => {
    const f = fixture(), server = new FixtureServer()
    server.config = { mcp: { graphql: { type: 'local', enabled: false, command: ['fixture-launcher'] } } }
    const manager = new OpenCodeNativeSessionManager({ server, ownerAgentId: f.store.row.agent_id, appMcpAccess: 'none' })
    let heartbeat: ReturnType<typeof setInterval> | undefined
    try {
      const nativeRequest = request()
      Object.assign(nativeRequest, { executionId: `agent-chat:${f.store.row.id}`, runId: `agent-chat:${f.store.row.id}`,
        workspaceId: f.store.row.workspace_id, workflowNodeId: f.store.row.workflow_node_id })
      Object.assign(nativeRequest.configuration, { id: f.store.row.agent_configuration_version_id,
        workspaceId: f.store.row.workspace_id, agentId: f.store.row.agent_id })
      Object.assign(f.store.row.record, { workingDirectory: nativeRequest.workingDirectory, runtimeDirectory: nativeRequest.runtimeDirectory })
      const session = await manager.createSession({ request: nativeRequest })
      Object.assign(f.store.row, { harness: 'opencode', provider_version: session.providerVersion,
        native_session_id: session.nativeSessionId, agent_configuration_version_id: nativeRequest.configuration.id })
      f.service['workflows'].getAgentConfiguration = async () => nativeRequest.configuration
      f.internals.runtimes.set(f.store.row.id, { manager, session, configuration: nativeRequest.configuration })
      messageSink(f)
      const correlationA = agentChatCorrelation(f.store.row.id, 'A')
      const correlationB = agentChatCorrelation(f.store.row.id, 'B')
      const submitted = (correlation: string) => server.calls.filter((call) => call.path.includes('/prompt_async')
        && call.body?.messageID === nativeMessageId(correlation))
      let pulses = 0
      heartbeat = setInterval(() => {
        pulses += 1
        // Keep both the body and parser live, with no terminal/idle event for A.
        server.emitBytes(new TextEncoder().encode(': heartbeat\n\n'))
        server.emit('session.status', { sessionID: 'unrelated-session', status: { type: 'busy' } })
      }, 5)
      await f.send('A')
      await eventually(() => f.store.row.active_native_turn_id === nativeMessageId(correlationA))
      await f.send('B')
      await new Promise<void>((done) => setTimeout(done, 20))
      assert(pulses > 0)
      assert.equal(server.cancelledSubscriptions, 0)
      assert.equal(f.store.turns.get('B')?.delivery, 'queued')
      const connections = server.connections
      // Store positive native history only. Deliberately do NOT call server.complete(),
      // emit session.idle/message completion, close the body, or change generation.
      const answer = server.assistant(nativeMessageId(correlationA), 'Recovered A', 'stop', true, session.nativeSessionId)
      server.statuses.delete(session.nativeSessionId)
      await f.service['repair'](f.store.row.id)
      await eventually(() => f.store.row.active_native_turn_id === nativeMessageId(correlationB))
      assert.equal(f.store.turns.get('A')?.delivery, 'completed')
      assert.equal(submitted(correlationA).length, 1)
      assert.equal(submitted(correlationB).length, 1)
      assert.equal(server.cancelledSubscriptions, 1)
      assert.equal(server.connections, connections + 1)
      assert.equal(server.generation, 0)
      assert.equal(server.disposals, 0)
      assert.equal(server.restartEnvironments.length, 0)
      assert.equal(server.calls.filter((call) => call.path.includes('/abort')).length, 0)
      assert.equal(server.calls.filter((call) => call.method === 'POST'
        && new URL(call.path, 'http://fixture.invalid').pathname === '/session').length, 1)
      assert.equal(f.internals.runtimes.get(f.store.row.id)?.session.nativeSessionId, session.nativeSessionId)
      assert([...f.store.messages.values()].some((message) => message.content === 'Recovered A'
        && (message.nativeMessageId === answer.info.id || message.nativeParentMessageId === answer.info.id)))
      // Normal event-driven completion still drains the successor exactly once.
      server.complete(correlationB, 'Completed B', session.nativeSessionId)
      await f.idle()
      assert.equal(f.store.turns.get('B')?.delivery, 'completed')
      assert.equal(f.store.turns.get('B')?.native_turn_id, nativeMessageId(correlationB))
      assert.deepEqual(f.store.turns.get('B')?.result, { outcome: 'succeeded', output: { text: 'Completed B' } })
      assert.equal(submitted(correlationB).length, 1)
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      try { await f.service.shutdown() } finally { await manager.dispose() }
    }
  })
})
