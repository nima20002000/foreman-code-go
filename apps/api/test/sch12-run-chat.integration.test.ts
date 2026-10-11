import { randomUUID } from 'node:crypto'
import { agentWorkflowVersion } from './helpers/agentWorkflowFixture.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentConfigurationVersionSchema, NativeSessionReferenceSchema, type HarnessExecution,
} from '@foreman-code/contracts'
import type { SelectedRunChatTarget } from '@foreman-code/contracts/selected-run-chat'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import {
  allExecutions, conversationPages, historicalFixture, historicalRows, openHistoricalApi, qualifyLocation,
  readSelected, readSnapshot, runA, saveWithoutY, selectedPath, sendAndFinish, startSaved, targetFor,
  type HistoricalApi,
} from './helpers/sch12HistoricalRuns.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { approvalFixture } from './helpers/wave25ApprovalFixture.js'

function chatTarget(api: HistoricalApi, execution: HarnessExecution): SelectedRunChatTarget {
  return { ...targetFor(api.f, execution.runId), workflowNodeId: execution.workflowNodeId }
}
async function retainedChatRows(api: HistoricalApi) {
  return {
    conversations: (await api.pool.query("select * from operator_conversations where kind='agent' order by id")).rows,
    messages: (await api.pool.query(`select m.* from operator_conversation_messages m join operator_conversations c
      on c.id=m.conversation_id where c.kind='agent' order by m.conversation_id,m.id`)).rows,
    turns: (await api.pool.query(`select t.* from operator_conversation_turns t join operator_conversations c
      on c.id=t.conversation_id where c.kind='agent' order by t.conversation_id,t.request_id`)).rows,
  }
}
async function assertExactOrigin(api: HistoricalApi, execution: HarnessExecution, id: string) {
  const row = await api.repository.get(id)
  expect(row).toMatchObject({ workspace_id: api.f.f.scope.workspaceId, workflow_id: api.f.f.scope.workflowId,
    workflow_node_id: execution.workflowNodeId, agent_id: execution.agentId,
    agent_configuration_version_id: execution.agentConfigurationVersionId,
    origin_run_id: execution.runId, origin_execution_id: execution.id,
    record: { origin: { kind: 'run_execution', runId: execution.runId, executionId: execution.id,
      sourceNativeSessionId: execution.nativeSessionId } } })
  const selected = await readSelected(api, chatTarget(api, execution), execution.id)
  expect(selected).toMatchObject({ kind: 'selected', key: { ...chatTarget(api, execution),
    agentId: execution.agentId, executionId: execution.id, conversationId: id },
    state: { conversation: { nativeSession: { nativeSessionId: row!.native_session_id } } } })
  return row!
}
/** Unregistered tools and schema-invalid calls may be JSON-RPC errors rather
 * than domain-error tool results. Both are denial; unrelated transport failures
 * must still fail this test. Domain errors on registered tools use parity below. */
async function expectProtocolDenial(operation: () => Promise<{ isError?: boolean | undefined; structuredContent?: unknown }>) {
  let result: Awaited<ReturnType<typeof operation>>
  try { result = await operation() } catch (error) {
    expect(error).toHaveProperty('code')
    expect([-32601, -32602]).toContain((error as { code: number }).code)
    return
  }
  expect(result.isError, JSON.stringify(result)).toBe(true)
  expect(result.structuredContent).toBeUndefined()
}
async function rejectedSend(api: HistoricalApi, target: SelectedRunChatTarget, executionId: string,
  expectedConversationId: string | null, code: string, token = api.f.writer.token, client = api.client,
  requestId: string = randomUUID(), content = 'This message must not be admitted.') {
  const message = { requestId, content, expectedConversationId }
  const http = await api.app.inject({ method: 'POST', url: `${selectedPath(target)}/messages`,
    headers: { authorization: `Bearer ${token}` }, payload: { executionId, ...message } })
  expect(http.statusCode, http.body).toBe(409)
  expect(http.json()).toMatchObject({ error: { code } })
  const { workspaceId, ...selection } = target
  const mcp = await client.callTool({ name: 'agent_chat_send', arguments: {
    workspaceId, selection: { ...selection, executionId }, message,
  } })
  expect(mcp.isError, JSON.stringify(mcp)).toBe(true)
  expect(mcp.structuredContent).toBeUndefined()
  expect(JSON.stringify(mcp)).toContain(code)
}

afterEach(() => vi.restoreAllMocks())

// PostgreSQL and the authenticated transports/services are real. Native providers
// are existing deterministic port fixtures. No additional product/migration mocks
// are introduced; inherited location/native qualification substitutes stay explicit.
describe.skipIf(!postgresEnabled)('SCH-12 historical Run-scoped chat PostgreSQL / HTTP / MCP', () => {
  it('[SCH-12-C01] removed Y resolves A; shared X never shares a child across Runs; restart/continuation preserve results', async () => {
    const f = await historicalFixture()
    let api: HistoricalApi | undefined
    try {
      await runA(f)
      const [x, y] = f.f.version.definition.nodes
      const executionsA = await allExecutions(f)
      const ax = executionsA.find((execution) => execution.workflowNodeId === x!.id)!
      const ay = executionsA.find((execution) => execution.workflowNodeId === y!.id)!
      const { saved } = await saveWithoutY(f)
      await f.db.pool.query('update agents set archived_at=now() where id=$1', [y!.agentId])
      const b = await startSaved(f, agentWorkflowVersion(saved.version))
      const bx = (await allExecutions(f, b.id)).find((execution) => execution.workflowNodeId === x!.id)!
      expect(ax.nativeSessionId).not.toBe(bx.nativeSessionId)
      const runIds = [f.f.run.id, b.id], before = await historicalRows(f.db.pool, runIds)
      api = await openHistoricalApi(f)
      const snapshotA = await readSnapshot(api, targetFor(f)), snapshotB = await readSnapshot(api, targetFor(f, b.id))
      const automatic = await readSelected(api, chatTarget(api, ay))
      expect(automatic).toMatchObject({ kind: 'selected', key: null,
        selection: { executionId: ay.id }, state: { conversation: null, availability: { canSend: true } } })
      expect(api.native.size).toBe(0)
      expect((await retainedChatRows(api)).conversations).toHaveLength(0)

      const retained: Array<{ execution: HarnessExecution; id: string; marker: string }> = []
      for (const [index, execution] of [ay, ax, bx].entries()) {
        const marker = `SCH-12 transcript ${index}: ${execution.id}`
        const { id, native } = await sendAndFinish(api, chatTarget(api, execution), execution.id,
          null, 'same-request-across-conversations', marker, index % 2 ? 'mcp' : 'http')
        const row = await assertExactOrigin(api, execution, id)
        const source = NativeSessionReferenceSchema.parse((await api.pool.query<{ reference: unknown }>(
          'select reference from execution_native_sessions where execution_id=$1', [execution.id])).rows[0]!.reference)
        expect(native.forks).toHaveLength(1)
        expect(native.forks[0]!.source).toEqual(source)
        expect(row.native_session_id).toBe(native.session.nativeSessionId)
        expect(row.native_session_id).not.toBe(source.nativeSessionId)
        const start = native.forks[0]!.input
        expect(start.kind).toBe('agent-chat')
        if (start.kind !== 'agent-chat') throw new Error('Historical Agent chat must use its conversation owner')
        expect(start.environment).toBeUndefined()
        expect(start).toMatchObject({ conversationId: id, workflowId: f.f.scope.workflowId,
          workflowNodeId: execution.workflowNodeId, configuration: { id: execution.agentConfigurationVersionId } })
        expect('request' in start).toBe(false)
        expect(start.instructionsDelivered).toBe(true)
        retained.push({ execution, id, marker })
      }
      expect(new Set(retained.map((chat) => chat.id)).size).toBe(3)
      expect(new Set([...api.native.values()].map((native) => native.session.nativeSessionId)).size).toBe(3)
      for (const chat of retained) {
        const page = await conversationPages(api, chatTarget(api, chat.execution), chat.execution.id)
        expect(page.history!.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([chat.marker])
        expect(page.receipts!.turns).toHaveLength(1)
        expect(page.receipts!.turns[0]).toMatchObject({ requestId: 'same-request-across-conversations', delivery: 'completed' })
      }
      const own = retained[1]!, other = retained[2]!
      const rowsBeforeDenial = await retainedChatRows(api)
      const promptCount = [...api.native.values()].reduce((count, native) => count + native.prompts.length, 0)
      // Both chats have this requestId already. Wrong expectedConversationId must
      // fail BEFORE receipt replay; another Run's receipt is not acceptance.
      await rejectedSend(api, chatTarget(api, own.execution), own.execution.id, other.id,
        'AGENT_CHAT_CONTEXT_STALE', f.writer.token, api.client, 'same-request-across-conversations', own.marker)
      expect(await retainedChatRows(api)).toEqual(rowsBeforeDenial)
      expect([...api.native.values()].reduce((count, native) => count + native.prompts.length, 0)).toBe(promptCount)
      expect(await historicalRows(f.db.pool, runIds)).toEqual(before)

      const firstApi = api
      await api.close(); api = await openHistoricalApi(f)
      expect(api.pool).not.toBe(firstApi.pool); expect(api.chat).not.toBe(firstApi.chat)
      for (const chat of retained) {
        await assertExactOrigin(api, chat.execution, chat.id)
        const page = await conversationPages(api, chatTarget(api, chat.execution), chat.execution.id)
        expect(page.history!.messages.some((message) => message.content === chat.marker)).toBe(true)
      }
      expect(api.native.size).toBe(0) // readback never attaches/forks/probes
      const historicalY = retained[0]!
      const continued = await sendAndFinish(api, chatTarget(api, ay), ay.id, historicalY.id,
        'continue-after-restart', 'Continue Y in Run A only.', 'mcp')
      expect(continued.id).toBe(historicalY.id)
      expect(continued.native.forks).toHaveLength(0)
      expect(continued.native.attachments).toEqual([continued.native.session])
      expect(continued.native.session.nativeSessionId).not.toBe(ay.nativeSessionId)
      const page = await conversationPages(api, chatTarget(api, ay), ay.id)
      expect(page.history!.messages.filter((message) => message.role === 'user').map((message) => message.content))
        .toEqual([historicalY.marker, 'Continue Y in Run A only.'])
      expect(page.receipts!.turns).toHaveLength(2)
      expect(await readSnapshot(api, targetFor(f))).toEqual(snapshotA)
      expect(await readSnapshot(api, targetFor(f, b.id))).toEqual(snapshotB)
      expect(await historicalRows(f.db.pool, runIds)).toEqual(before)
      expect(f.dispatchErrors).toEqual([])
    } finally { try { await api?.close() } finally { await f.close() } }
  }, 120_000)

  it('[SCH-12-C02] real repeat executions require an explicit choice and retain separate conversations/sessions', async () => {
    const f = await historicalFixture('repeat')
    let api: HistoricalApi | undefined
    try {
      await runA(f)
      const y = f.f.version.definition.nodes[1]!
      const all = await allExecutions(f), executions = all.filter((execution) => execution.workflowNodeId === y.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      expect(executions).toHaveLength(3) // three real finite-repeat occurrences, not fabricated SQL attempts
      expect(new Set(executions.map((execution) => execution.nativeSessionId)).size).toBe(1)
      expect(executions.map((execution) => execution.sessionContinuation?.previousExecutionId))
        .toEqual([undefined, executions[0]!.id, executions[1]!.id])
      const before = await historicalRows(f.db.pool, [f.f.run.id])
      api = await openHistoricalApi(f)
      const target = { ...targetFor(f), workflowNodeId: y.id }
      const choice = await readSelected(api, target)
      expect(choice).toMatchObject({ kind: 'execution_selection_required', target, hasMoreExecutions: false })
      if (choice.kind !== 'execution_selection_required') throw new Error('Several executions must never auto-select the latest')
      expect(choice.executions.map((execution) => execution.executionId).sort()).toEqual(executions.map((execution) => execution.id).sort())
      expect(api.native.size).toBe(0)
      const ids: string[] = []
      for (const execution of executions) {
        expect(await readSelected(api, target, execution.id)).toMatchObject({ kind: 'selected', key: null,
          selection: { executionId: execution.id } })
        const { id, native } = await sendAndFinish(api, target, execution.id, null, 'same-request-per-execution',
          `Only execution ${execution.id}`, 'mcp')
        ids.push(id)
        await assertExactOrigin(api, execution, id)
        expect(native.forks[0]!.source.nativeSessionId).toBe(execution.nativeSessionId)
      }
      expect(new Set(ids).size).toBe(3)
      expect(new Set([...api.native.values()].map((native) => native.session.nativeSessionId)).size).toBe(3)
      expect(await readSelected(api, target)).toEqual(choice) // existing chats do not turn ambiguity into "latest"
      const wrongExecution = all.find((execution) => execution.workflowNodeId !== y.id)!
      const headers = { authorization: `Bearer ${f.writer.token}` }
      const { workspaceId, ...selection } = target
      for (const [executionId, status, code] of [
        [wrongExecution.id, 404, 'RUN_CHAT_EXECUTION_NOT_FOUND'],
        [`absent-${randomUUID()}`, 404, 'RUN_CHAT_EXECUTION_NOT_FOUND'],
      ] as const) {
        const http = await api.app.inject({ method: 'GET', url: `${selectedPath(target)}?${new URLSearchParams({ executionId })}`, headers })
        expect(http.statusCode, http.body).toBe(status)
        expect(http.json()).toMatchObject({ error: { code } })
        const wrong = await api.client.callTool({ name: 'agent_chat_read', arguments: {
          workspaceId, selection: { ...selection, executionId },
        } })
        expect(wrong.isError).toBe(true); expect(wrong.structuredContent).toBeUndefined()
        expect(JSON.stringify(wrong)).toContain(code)
      }
      const missing = await api.app.inject({ method: 'POST', url: `${selectedPath(target)}/messages`, headers,
        payload: { requestId: randomUUID(), content: 'Do not choose an execution for me.', expectedConversationId: null } })
      expect(missing.statusCode, missing.body).toBe(400)
      await expectProtocolDenial(() => api!.client.callTool({ name: 'agent_chat_send', arguments: {
        workspaceId, selection, message: { requestId: randomUUID(), content: 'Do not choose for me.', expectedConversationId: null },
      } }))
      expect((await retainedChatRows(api)).conversations).toHaveLength(3)
      expect([...api.native.values()].every((native) => native.prompts.length === 1 && native.forks.length === 1)).toBe(true)
      expect(await historicalRows(f.db.pool, [f.f.run.id])).toEqual(before)
      expect(f.dispatchErrors).toEqual([])
    } finally { try { await api?.close() } finally { await f.close() } }
  }, 120_000)

  it.each(['missing-child', 'missing-provider'] as const)(
    '[SCH-12-C03] %s after restart stays unavailable with readable transcript/receipts and no replacement', async (kind) => {
      const f = await historicalFixture()
      let api: HistoricalApi | undefined
      try {
        await runA(f)
        const y = f.f.version.definition.nodes[1]!
        const execution = (await allExecutions(f)).find((entry) => entry.workflowNodeId === y.id)!
        api = await openHistoricalApi(f)
        const target = chatTarget(api, execution)
        const { id } = await sendAndFinish(api, target, execution.id, null, 'before-runtime-loss', `Retained ${kind} transcript.`)
        expect(await readSelected(api, target, execution.id)).toMatchObject({ kind: 'selected', state: { availability: { canSend: true } } })
        const pagesBefore = await conversationPages(api, target, execution.id)
        const before = await historicalRows(f.db.pool, [f.f.run.id])
        await api.close()
        // Simulate loss of chat-owned identity only. No Run/source session,
        // immutable configuration, result or snapshot row is rewritten.
        if (kind === 'missing-child') await f.db.pool.query('update operator_conversations set native_session_id=null where id=$1', [id])
        if (kind === 'missing-provider') await f.db.pool.query('update operator_conversations set provider_version=null where id=$1', [id])
        api = await openHistoricalApi(f)
        const unavailable = await readSelected(api, target, execution.id)
        expect(unavailable).toMatchObject({ kind: 'selected', key: pagesBefore.key,
          state: { sessionState: 'unavailable', availability: { canSend: false, reason: 'native_session_missing' },
            capabilities: { resume: false, queueNextTurn: false, interruptAndSend: false, steer: 'unavailable' } } })
        if (unavailable.kind !== 'selected') throw new Error('Retained chat must remain readable')
        expect(unavailable.state.availability.message).toEqual(expect.any(String))
        expect(unavailable.state.availability.message?.length ?? 0).toBeGreaterThan(0)
        const readable = await conversationPages(api, target, execution.id)
        expect(readable.history).toEqual(pagesBefore.history)
        expect(readable.receipts).toEqual(pagesBefore.receipts)
        expect(readable.history!.messages.some((message) => message.content === `Retained ${kind} transcript.`)).toBe(true)
        const conversationsBefore = await retainedChatRows(api)
        await rejectedSend(api, target, execution.id, id, 'AGENT_CHAT_UNAVAILABLE')
        expect(await retainedChatRows(api)).toEqual(conversationsBefore)
        const afterDenial = await conversationPages(api, target, execution.id)
        expect(afterDenial.history).toEqual(pagesBefore.history)
        expect(afterDenial.receipts).toEqual(pagesBefore.receipts)
        expect(api.native.size).toBe(0)
        expect(await historicalRows(f.db.pool, [f.f.run.id])).toEqual(before)
        expect(f.dispatchErrors).toEqual([])
      } finally { try { await api?.close() } finally { await f.close() } }
    }, 120_000)

  it('routed workflow rejects an ephemeral Codex configuration before admission', async () => {
    const db = await agent3Database()
    try {
      const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
      const harness = approvalFixture().configurations[1]!.harness
      if (harness.harness !== 'codex') throw new Error('Routed approval fixture requires Codex')
      fixture.configurations = fixture.configurations.map((configuration) => AgentConfigurationVersionSchema.parse({
        ...configuration,
        harness: { ...harness, advanced: { ...harness.advanced!, sessionPersistence: 'ephemeral' } },
      }))
      // Seed calls the production Save service without the runtime fixture's harness normalization.
      await expect(seedAgent3(db.pool, db.directory, fixture)).rejects.toMatchObject({
        code: 'WORKFLOW_HARNESS_APPROVAL_CONFLICT',
        message: expect.stringContaining('Routed approval requires a resumable Codex session'),
      })
      for (const configuration of fixture.configurations) {
        const stored = (await db.pool.query<{ record: unknown }>(
          'select record from agent_configuration_versions where id=$1', [configuration.id])).rows[0]!
        expect(AgentConfigurationVersionSchema.parse(stored.record).harness).toMatchObject({
          harness: 'codex', advanced: { approvalPolicy: 'on-request', sessionPersistence: 'ephemeral' },
        })
      }
      expect((await db.pool.query('select id from workflow_versions')).rows).toEqual([])
      expect((await db.pool.query('select id from runs')).rows).toEqual([])
      expect((await db.pool.query('select id from harness_executions')).rows).toEqual([])
    } finally {
      await db.close()
    }
  }, 120_000)

  it('[SCH-12-C04] forged/foreign Runs and Run-limited/revoked callers cannot read or mutate another historical chat', async () => {
    const f = await historicalFixture()
    let api: HistoricalApi | undefined
    try {
      await runA(f); await qualifyLocation(f)
      const b = await startSaved(f)
      const ax = (await allExecutions(f))[0]!, bx = (await allExecutions(f, b.id)).find((entry) => entry.workflowNodeId === ax.workflowNodeId)!
      const foreign = await seedAgent3(f.db.pool, f.db.directory, makeCurrentWorkflowFixture(randomUUID()), { run: true })
      api = await openHistoricalApi(f)
      const aTarget = chatTarget(api, ax), bTarget = chatTarget(api, bx)
      const own = await sendAndFinish(api, aTarget, ax.id, null, 'authorized-message', 'Run A retained text.')
      const other = await sendAndFinish(api, bTarget, bx.id, null, 'authorized-message', 'Run B private text.', 'mcp')
      const limited = await api.access.issue({ name: 'SCH-12 Run A reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [aTarget.workspaceId], workflowIds: [aTarget.workflowId], runIds: [aTarget.runId] } }] })
      const limitedClient = await api.connect(limited.token)
      await readSelected(api, aTarget, ax.id, limited.token, limitedClient)
      expect((await limitedClient.listTools()).tools.map((tool) => tool.name)).not.toContain('agent_chat_send')
      const scoped = await api.access.issue({ name: 'SCH-12 workflow reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [aTarget.workspaceId], workflowIds: [aTarget.workflowId] } }] })
      const scopedClient = await api.connect(scoped.token)
      const runIds = [aTarget.runId, bTarget.runId, foreign.run.id]
      const before = await historicalRows(f.db.pool, runIds), chatBefore = await retainedChatRows(api)
      const pagesA = await conversationPages(api, aTarget, ax.id), pagesB = await conversationPages(api, bTarget, bx.id)
      for (const [target, status, token, client] of [
        [bTarget, 403, limited.token, limitedClient],
        [{ ...aTarget, runId: `forged-${randomUUID()}` }, 404, scoped.token, scopedClient],
        [{ ...aTarget, runId: foreign.run.id }, 404, scoped.token, scopedClient],
        [{ workspaceId: foreign.scope.workspaceId, workflowId: foreign.scope.workflowId, runId: foreign.run.id,
          workflowNodeId: foreign.version.entryNodeId }, 403, scoped.token, scopedClient],
      ] as const) {
        const http = await api.app.inject({ method: 'GET', url: selectedPath(target), headers: { authorization: `Bearer ${token}` } })
        expect(http.statusCode, http.body).toBe(status)
        const { workspaceId, ...selection } = target
        const denied = await client.callTool({ name: 'agent_chat_read', arguments: { workspaceId, selection } })
        expect(denied.isError).toBe(true); expect(denied.structuredContent).toBeUndefined()
        expect(JSON.stringify(denied)).toContain(http.json<{ error: { code: string } }>().error.code)
      }
      // Check a denied write at the HTTP boundary; MCP must not expose the tool.
      const deniedSend = await api.app.inject({ method: 'POST', url: `${selectedPath(aTarget)}/messages`,
        headers: { authorization: `Bearer ${limited.token}` }, payload: {
          executionId: ax.id, expectedConversationId: own.id, requestId: randomUUID(), content: 'Read-only principal must not send.',
        } })
      expect(deniedSend.statusCode, deniedSend.body).toBe(403)
      await expectProtocolDenial(() => limitedClient.callTool({ name: 'agent_chat_send', arguments: {
        workspaceId: aTarget.workspaceId, selection: { workflowId: aTarget.workflowId, runId: aTarget.runId,
          workflowNodeId: aTarget.workflowNodeId, executionId: ax.id },
        message: { expectedConversationId: own.id, requestId: randomUUID(), content: 'Read-only principal must not send.' },
      } }))
      expect(await retainedChatRows(api)).toEqual(chatBefore)
      expect((await conversationPages(api, aTarget, ax.id)).history).toEqual(pagesA.history)
      expect((await conversationPages(api, aTarget, ax.id)).receipts).toEqual(pagesA.receipts)
      expect((await conversationPages(api, bTarget, bx.id)).history).toEqual(pagesB.history)
      expect((await conversationPages(api, bTarget, bx.id)).receipts).toEqual(pagesB.receipts)
      expect(own.native.prompts).toHaveLength(1); expect(other.native.prompts).toHaveLength(1)
      expect(api.native.size).toBe(2)
      // Use the already-connected MCP client after live revocation, not a newly
      // authenticated connection which would test only credential startup.
      await api.pool.query('update management_principals set revoked_at=now() where id=$1', [scoped.principal.id])
      await expect(api.chat.readSelectedRun(scoped.principal, { selection: { ...aTarget, executionId: ax.id } }))
        .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      const revokedHttp = await api.app.inject({ method: 'GET', url: selectedPath(aTarget), headers: { authorization: `Bearer ${scoped.token}` } })
      expect([401, 403]).toContain(revokedHttp.statusCode)
      // Authentication middleware may reject the transport or return an MCP
      // error. Either must be denial, never a successful transcript response.
      let rejectedAtTransport = false
      let revokedResult: Awaited<ReturnType<typeof scopedClient.callTool>> | undefined
      try {
        revokedResult = await scopedClient.callTool({ name: 'agent_chat_read', arguments: {
          workspaceId: aTarget.workspaceId, selection: { workflowId: aTarget.workflowId, runId: aTarget.runId,
            workflowNodeId: aTarget.workflowNodeId, executionId: ax.id },
        } })
      } catch (error) {
        rejectedAtTransport = true
        expect(String(error)).toMatch(/401|403|AUTH_REVOKED|Unauthorized|Forbidden/i)
      }
      if (!rejectedAtTransport) {
        expect(revokedResult).toBeDefined()
        expect(revokedResult!.isError).toBe(true); expect(revokedResult!.structuredContent).toBeUndefined()
      }
      expect(await retainedChatRows(api)).toEqual(chatBefore)
      expect(await historicalRows(f.db.pool, runIds)).toEqual(before)
      expect(f.dispatchErrors).toEqual([])
    } finally { try { await api?.close() } finally { await f.close() } }
  }, 120_000)
})
