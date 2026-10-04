import { childHistoryEvent } from '../src/modules/subagents/nativeReadback.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import Fastify from 'fastify'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RunSubagentSchema, RunSubagentsPageSchema, RunSubagentMessagesPageSchema, RunSubagentCommandReceiptSchema } from '@graphql/contracts/subagents'
import type { ManagementAction } from '@graphql/contracts/management'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'
import { RunSubagentService } from '../src/modules/subagents/service.js'
import { backfillRunSubagents, recoverSubagentCommands } from '../src/modules/subagents/recovery.js'
import type { SubagentControlLease } from '../src/modules/subagents/types.js'
import { registerRunSubagentRoutes } from '../src/routes/runSubagents.js'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { DomainError } from '../src/modules/errors.js'
import { SubagentDispatchRejectedError } from '../src/modules/subagents/controlErrors.js'

// Explicit loopback admin connection and a random OWNED schema. Never read TEST_DATABASE_URL or migrate public.
describe('durable per-Run children over SQL and authenticated MCP', () => {
  let admin: pg.Pool, pool: pg.Pool, schema: string
  beforeAll(async () => {
    const connectionString = process.env.SUBAGENT_CORE_ADMIN_DATABASE_URL ?? process.env.TEST_DATABASE_URL
    if (!connectionString || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('An explicit loopback TEST_DATABASE_URL (or SUBAGENT_CORE_ADMIN_DATABASE_URL) is required.')
    admin = new pg.Pool({ connectionString, max: 1 })
    schema = `subagent_core_${randomUUID().replaceAll('-', '')}`
    await admin.query(`create schema "${schema}"`)
    pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` })
    await applyApplicationMigrations(pool)
  }, 60000)
  afterAll(async () => { await pool?.end(); if (schema) await admin.query(`drop schema "${schema}" cascade`); await admin?.end() })
  async function fixture(provider: 'codex' | 'opencode' | 'claude' = 'codex') {
    const suffix = randomUUID(), workspaceId = `w-${suffix}`, workflowId = `wf-${suffix}`, version = `v-${suffix}`, runId = `r-${suffix}`, executionId = `e-${suffix}`, agentId = `a-${suffix}`, configurationId = `cfg-${suffix}`
    await pool.query("insert into workspaces(id,record) values($1,'{}')", [workspaceId])
    await pool.query("insert into agents(id,workspace_id,record) values($1,$2,'{}')", [agentId, workspaceId])
    await pool.query("insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,'{}')", [configurationId, workspaceId, agentId])
    await pool.query("insert into workflows(id,workspace_id,record) values($1,$2,'{}')", [workflowId, workspaceId])
    const versionRecord = { id: version, workspaceId, workflowId, executionSemanticsVersion: 3, agentConfigurationVersionIds: { [agentId]: configurationId }, definition: { executionSemanticsVersion: 3, nodes: [{ id: 'node', agentId }] } }
    await pool.query("insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record) values($1,$2,$3,1,'node',$4::jsonb)", [version, workspaceId, workflowId, JSON.stringify(versionRecord)])
    const runRecord = { id: runId, workspaceId, workflowId, workflowVersionId: version, executionSemanticsVersion: 3, executionState: 'running', agentConfigurationVersionIds: { [agentId]: configurationId } }
    await pool.query("insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record) values($1,$2,$3,$4,'running',$5::jsonb)", [runId, workspaceId, workflowId, version, JSON.stringify(runRecord)])
    const executionRecord = { id: executionId, runId, workflowNodeId: 'node', agentId, attempt: 1, agentConfigurationVersionId: configurationId, nativeSessionId: 'root', state: 'running', input: {} }
    await pool.query("insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,'node',$3,1,$4::jsonb)", [executionId, runId, agentId, JSON.stringify(executionRecord)])
    await pool.query('insert into execution_native_sessions(execution_id,reference) values($1,$2::jsonb)', [executionId, JSON.stringify({ harness: provider, providerVersion: provider === 'codex' ? '0.154.0' : provider === 'opencode' ? '1.18.33' : '2.1.284', nativeSessionId: 'root' })])
    const access = new PostgresAccessService(pool)
    const issue = (actions: ManagementAction[]) => access.issue({ name: 'Child integration fixture', audience: 'operator', grants: [{ actions, scope: { workspaceIds: [workspaceId], runIds: [runId] } }], expiresAt: new Date(Date.now() + 600000) })
    const writer = await issue(['runs:read', 'runs:subagents:input', 'runs:stop'])
    const reader = await issue(['runs:read'])
    const denied = await issue(['workspaces:read'])
    const service = new RunSubagentService(pool)
    let sequence = 0
    const event = async (type: string, payload: Record<string, unknown>, at = '2026-10-02T20:00:00.000Z') => {
      const value = { executionId, connectionId: 'connection', sequence: sequence++, type, payload, occurredAt: at }
      await appendNativeEvent(pool, value)
      return value
    }
    const discover = (id = 'child', parent = 'root') => event('item.completed', { threadId: parent, item: { type: 'subAgentActivity', id: `spawn-${id}`, agentThreadId: id, agentPath: `/root/${id}`, kind: 'started' } })
    const input = { workspaceId, runId }
    return { access, writer, reader, denied, service, input, event, discover, executionId, versionRecord, runRecord }
  }
  it('joins late and nested children, paginates, and replays after a new service instance without duplication', async () => {
    const f = await fixture()
    await f.event('native.unlinked_notification', { threadId: 'child', method: 'item/completed', params: { threadId: 'child', turnId: 't', item: { type: 'agentMessage', id: 'm', text: 'CHILD ONLY' } } })
    await f.discover(); await f.discover('other'); await f.discover('nested', 'child')
    const page = await f.service.list(f.reader.principal, { ...f.input, limit: 2 })
    expect(page.items).toHaveLength(2); expect(page.nextCursor).not.toBeNull()
    expect((await f.service.list(f.reader.principal, { ...f.input, limit: 2, cursor: page.nextCursor! })).items).toHaveLength(1)
    const all = await new RunSubagentService(pool).list(f.reader.principal, f.input)
    expect(all.items).toHaveLength(3)
    const child = all.items.find(item => item.subagent.native.childSessionId === 'child')!.subagent
    expect(all.items.find(item => item.subagent.native.childSessionId === 'nested')!.subagent.parentSubagentId).toBe(child.id)
    const messages = await f.service.messages(f.reader.principal, { ...f.input, subagentId: child.id })
    expect(messages.items).toMatchObject([{ text: 'CHILD ONLY', role: 'assistant' }])
    expect((await pool.query('select record from workflow_versions where id=$1', [child.workflowVersionId])).rows[0].record).toEqual(f.versionRecord)
    expect((await pool.query('select record from runs where id=$1', [child.runId])).rows[0].record).toEqual(f.runRecord)
    expect((await f.service.list(f.reader.principal, f.input)).items.map(item => item.subagent.revision)).toEqual(all.items.map(item => item.subagent.revision))
  })
  it('keeps tool output, transcript truncation and final lifecycle through replay and scopes every cursor', async () => {
    const f = await fixture(); await f.discover()
    await f.event('native.unlinked_notification', { method: 'item/completed', params: { threadId: 'child', item: { type: 'commandExecution', id: 'tool', command: 'read sentinel', status: 'completed', aggregatedOutput: 'TOOL_OK', durationMs: 25 } } })
    for (const [id, text] of [['m1', 'x'.repeat(25000)], ['m2', 'SECOND']]) await f.event('native.unlinked_notification', { method: 'item/completed', params: { threadId: 'child', item: { type: 'agentMessage', id, text } } })
    await f.event('native.unlinked_notification', { method: 'turn/completed', params: { threadId: 'child', turn: { id: 't1', status: 'completed', items: [] } } }, '2026-10-02T20:01:00.000Z')
    const child = (await f.service.list(f.reader.principal, f.input)).items[0]!.subagent
    expect(child.status).toBe('completed'); expect(child.finishedAt).not.toBeNull()
    const first = await f.service.messages(f.reader.principal, { ...f.input, subagentId: child.id, limit: 1 })
    expect(first.items[0]!.truncation).toEqual({ truncated: true, originalBytes: 25000 })
    expect(first.coverage).toMatchObject({ transcript: 'partial', gaps: true })
    expect((await f.service.messages(f.reader.principal, { ...f.input, subagentId: child.id, cursor: first.nextCursor!, limit: 1 })).items[0]!.text).toBe('SECOND')
    expect((await f.service.tools(f.reader.principal, { ...f.input, subagentId: child.id })).items).toMatchObject([{ output: 'TOOL_OK', durationMs: 25 }])
    await expect(f.service.tools(f.reader.principal, { ...f.input, subagentId: child.id, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'SUBAGENT_CURSOR_INVALID' })
    await f.event('native.unlinked_notification', { method: 'turn/started', params: { threadId: 'child', turn: { id: 't0', status: 'inProgress', items: [] } } }, '2026-10-02T19:59:00.000Z')
    expect((await f.service.get(f.reader.principal, { ...f.input, subagentId: child.id })).subagent.status).toBe('completed')
    await f.event('native.unlinked_notification', { method: 'turn/started', params: { threadId: 'child', turn: { id: 't2', status: 'inProgress', items: [] } } }, '2026-10-02T20:02:00.000Z')
    expect((await f.service.get(f.reader.principal, { ...f.input, subagentId: child.id })).subagent).toMatchObject({ status: 'running', finishedAt: null, native: { currentTurnId: 't2' } })
    expect((await pool.query('select count(*)::int as count from run_subagent_lifecycle where subagent_id=$1', [child.id])).rows[0].count).toBe(4)
  })
  it('keeps disconnected children reconciling until fresh lifecycle evidence and retains terminal children', async () => {
    const f = await fixture(); await f.discover(); await f.discover('finished')
    await f.event('native.unlinked_notification', { method: 'turn/completed', params: { threadId: 'finished', turn: { id: 't', status: 'completed', items: [] } } })
    await f.event('transport.disconnected', {})
    const children = (await f.service.list(f.reader.principal, f.input)).items
    expect(children.find(item => item.subagent.native.childSessionId === 'child')!.subagent).toMatchObject({ status: 'unknown', evidence: 'reconciling' })
    expect(children.find(item => item.subagent.native.childSessionId === 'finished')!.subagent.status).toBe('completed')
    await f.event('native.unlinked_notification', { method: 'turn/started', params: { threadId: 'child', turn: { id: 'fresh', status: 'inProgress', items: [] } } }, '2026-10-02T20:02:00.000Z')
    expect((await f.service.list(f.reader.principal, f.input)).items.find(item => item.subagent.native.childSessionId === 'child')!.subagent).toMatchObject({ status: 'running', evidence: 'confirmed' })
  })
  it('persists OpenCode roles arriving after parts and does not fabricate tools from text', async () => {
    const f = await fixture('opencode')
    await f.event('message.part.updated', { part: { id: 'p', messageID: 'm', sessionID: 'oc', type: 'text', text: '<tool>Read</tool>', time: { end: 10 } } })
    await f.event('session.created', { info: { id: 'oc', parentID: 'root', title: 'Worker' } })
    await f.event('message.updated', { info: { id: 'm', sessionID: 'oc', role: 'user' } })
    const child = (await f.service.list(f.reader.principal, f.input)).items[0]!.subagent
    expect((await f.service.messages(f.reader.principal, { ...f.input, subagentId: child.id })).items).toMatchObject([{ role: 'user', text: '<tool>Read</tool>' }])
    expect((await f.service.tools(f.reader.principal, { ...f.input, subagentId: child.id })).items).toEqual([])
    expect(child.capabilities.sendInput).toMatchObject({ support: 'supported', qualification: 'unverified' })
    expect((await f.service.get(f.writer.principal, { ...f.input, subagentId: child.id })).availableActions.sendInput).toBe(false)
  })
  it('quarantines Claude hook-only identity, verifies nesting and enriches native aliases before linking child messages/tools', async () => {
    const f = await fixture('claude')
    await f.event('claude.subagent', { nativeSessionId: 'root', agentId: 'outer', status: 'running' })
    expect((await f.service.list(f.reader.principal, f.input)).items).toEqual([])
    await f.event('claude.subagent', { nativeSessionId: 'root', agentId: 'inner', parentAgentId: 'outer', ancestry: 'verified', status: 'unknown', spawnToolUseId: 'spawn-inner', taskId: 'task-inner' })
    await f.event('claude.subagent', { nativeSessionId: 'root', agentId: 'outer', ancestry: 'verified', status: 'unknown' })
    await f.event('claude.text', { nativeSessionId: 'root', parentToolUseId: 'spawn-outer', itemId: 'text-user', messageId: 'user-message', role: 'user', operation: 'replace', text: 'CHILD USER', final: true })
    await f.event('claude.subagent', { nativeSessionId: 'root', agentId: 'outer', ancestry: 'verified', status: 'unknown', spawnToolUseId: 'spawn-outer', taskId: 'task-outer' })
    await f.event('claude.subagent', { nativeSessionId: 'root', agentId: 'inner', status: 'running' })
    await f.event('claude.subagent', { nativeSessionId: 'root', agentId: 'inner', parentAgentId: 'outer', ancestry: 'verified', status: 'unknown', spawnToolUseId: 'spawn-inner', taskId: 'task-inner' })
    await f.event('claude.tool', { nativeSessionId: 'root', agentId: 'inner', toolUseId: 'read', name: 'Read', input: { file_path: 'sentinel', OPENAI_API_KEY: 'secret' }, status: 'running' })
    await f.event('claude.tool', { nativeSessionId: 'root', agentId: 'inner', toolUseId: 'read', name: 'Read', output: 'OK', status: 'completed' })
    await f.event('claude.task', { nativeSessionId: 'root', taskId: 'task-inner', status: 'completed' })
    const all = (await f.service.list(f.reader.principal, f.input)).items
    const outer = all.find(item => item.subagent.native.agentId === 'outer')!.subagent
    const inner = all.find(item => item.subagent.native.agentId === 'inner')!.subagent
    expect(inner).toMatchObject({ parentSubagentId: outer.id, status: 'completed', native: { taskId: 'task-inner' } })
    expect((await f.service.messages(f.reader.principal, { ...f.input, subagentId: outer.id })).items).toMatchObject([{ role: 'user', text: 'CHILD USER' }])
    expect((await f.service.tools(f.reader.principal, { ...f.input, subagentId: inner.id })).items).toMatchObject([{ input: { OPENAI_API_KEY: '[redacted]' }, output: 'OK' }])
    expect(inner.capabilities.toolCalls.qualification).toBe('unverified')
  })
  it('keeps the same provider-native child identity distinct across technical execution attempts', async () => {
    const f = await fixture(); await f.discover()
    const first = (await f.service.list(f.reader.principal, f.input)).items[0]!.subagent
    const executionId = randomUUID()
    const old = (await pool.query('select * from harness_executions where id=$1', [f.executionId])).rows[0]
    await pool.query('insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,2,$5::jsonb)',
      [executionId, old.run_id, old.workflow_node_id, old.agent_id, JSON.stringify({ ...old.record, id: executionId, attempt: 2 })])
    await pool.query('insert into execution_native_sessions(execution_id,reference) select $1,reference from execution_native_sessions where execution_id=$2', [executionId, f.executionId])
    await appendNativeEvent(pool, { executionId, sequence: 0, connectionId: 'connection', type: 'item.completed', occurredAt: '2026-10-02T20:00:00.000Z', payload: { threadId: 'root', item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child' } } })
    const all = (await f.service.list(f.reader.principal, f.input)).items
    expect(all).toHaveLength(2); expect(all[0]!.subagent.id).not.toBe(all[1]!.subagent.id)
    expect(all.find(item => item.subagent.id !== first.id)!.subagent.parentAttemptKey).toBe(`${executionId}:2`)
  })
  async function qualifiedFixture() {
    const f = await fixture('opencode')
    await f.event('session.created', { info: { id: 'oc', parentID: 'root' } })
    const child = (await f.service.list(f.writer.principal, f.input)).items[0]!.subagent
    // Synthetic native qualification fixture tests the command protocol; it is never app/provider qualification evidence.
    child.status = 'waiting'; child.capabilities.sendInput = { support: 'supported', qualification: 'passed' }
    child.capabilities.interrupt = { support: 'supported', qualification: 'passed' }
    await pool.query('update run_subagents set record=$2::jsonb where id=$1', [child.id, JSON.stringify(child)])
    const send = vi.fn(async () => {}), interrupt = vi.fn(async () => {})
    const lease: SubagentControlLease = { generation: 'lease-1', nativeTurnId: null, matches: value => value.id === child.id && value.profile.harnessInstanceId === child.profile.harnessInstanceId,
      assertCurrent: () => {}, sendInput: send, interrupt }
    const service = new RunSubagentService(pool, () => lease)
    const command = { ...f.input, subagentId: child.id, commandId: randomUUID(), expectedRevision: child.revision, text: 'follow up' }
    return { ...f, service, child, send, interrupt, lease, command }
  }
  it('stores one idempotent receipt, checks current grants on retry, and binds changed input to conflict', async () => {
    const f = await qualifiedFixture()
    const [a, b] = await Promise.all([f.service.input(f.writer.principal, 'mcp', f.command), f.service.input(f.writer.principal, 'mcp', f.command)])
    expect(a.id).toBe(b.id); expect(f.send).toHaveBeenCalledTimes(1)
    const retry = await f.service.input(f.writer.principal, 'http', f.command)
    expect(retry.state).toBe('acknowledged'); expect(retry.id).toBe(a.id)
    await expect(f.service.input(f.writer.principal, 'mcp', { ...f.command, text: 'different' })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    await pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.writer.principal.id, JSON.stringify(f.reader.principal.grants)])
    await expect(f.service.input(f.writer.principal, 'mcp', f.command)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('does not hold Run SQL locks while the native dispatch callback records evidence', async () => {
    const f = await qualifiedFixture()
    f.send.mockImplementationOnce(async () => {
      const sql = await pool.connect()
      try { await sql.query('begin'); await sql.query('select id from runs where id=$1 for update', [f.input.runId]); await sql.query('commit') }
      finally { sql.release() }
    })
    expect((await f.service.input(f.writer.principal, 'mcp', f.command)).state).toBe('acknowledged')
  }, 15000)
  it('retains uncertain delivery and recovers pre-crash dispatch receipts without resubmission', async () => {
    const f = await qualifiedFixture(); f.send.mockRejectedValueOnce(new Error('lost native response'))
    const receipt = await f.service.input(f.writer.principal, 'mcp', f.command)
    expect(receipt.state).toBe('uncertain')
    expect(await f.service.input(f.writer.principal, 'mcp', f.command)).toEqual(receipt)
    await pool.query("update run_subagent_command_receipts set record=jsonb_set(record,'{state}','\"dispatching\"') where id=$1", [receipt.id])
    expect(await recoverSubagentCommands(pool)).toBe(1)
    const readback = await new RunSubagentService(pool).input(f.writer.principal, 'mcp', f.command)
    expect(readback).toMatchObject({ id: receipt.id, state: 'uncertain', reasonCode: 'MAIN_RESTART_DELIVERY_UNCERTAIN' })
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('ACKs interrupt without changing lifecycle and respects the Run stop fence', async () => {
    const f = await qualifiedFixture(); f.child.status = 'running'
    await pool.query('update run_subagents set record=$2::jsonb where id=$1', [f.child.id, JSON.stringify(f.child)])
    const input = { ...f.input, subagentId: f.child.id, commandId: f.command.commandId, expectedRevision: f.command.expectedRevision }
    expect((await f.service.interrupt(f.writer.principal, 'mcp', input)).state).toBe('acknowledged')
    expect(f.interrupt).toHaveBeenCalledTimes(1)
    expect((await f.service.get(f.reader.principal, { ...f.input, subagentId: f.child.id })).subagent.status).toBe('running')
    await pool.query('update runs set stop_requested_at=clock_timestamp() where id=$1', [f.input.runId])
    await expect(f.service.interrupt(f.writer.principal, 'http', { ...input, commandId: randomUUID() })).rejects.toMatchObject({ code: 'RUN_STOPPED' })
  })
  it('rechecks uncertain delivery using exact readback without resending or holding the Run transaction', async () => {
    const f = await qualifiedFixture()
    f.send.mockRejectedValueOnce(new Error('lost ACK'))
    const first = await f.service.input(f.writer.principal, 'http', f.command)
    expect(first.state).toBe('uncertain')
    const reconcile = vi.fn(async () => {
      // This second scoped connection needs the same advisory lock. It must
      // not deadlock behind a transaction held over native IO.
      await f.service.get(f.reader.principal, { ...f.input, subagentId: f.child.id })
      return 'acknowledged' as const
    })
    f.lease.reconcile = reconcile
    const retry = await f.service.input(f.writer.principal, 'mcp', f.command)
    expect(retry).toMatchObject({ id: first.id, state: 'acknowledged' })
    expect(retry.reasonCode).toBeUndefined()
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(first)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect((await f.service.input(f.writer.principal, 'http', f.command)).state).toBe('acknowledged')
    expect(reconcile).toHaveBeenCalledTimes(1)
  })
  it('does not accept readback from a replacement control generation', async () => {
    const f = await qualifiedFixture()
    f.send.mockRejectedValueOnce(new Error('lost ACK'))
    const first = await f.service.input(f.writer.principal, 'http', f.command)
    f.lease.reconcile = async () => { f.lease.generation = 'replacement'; return 'acknowledged' }
    expect((await f.service.input(f.writer.principal, 'mcp', f.command)).state).toBe('uncertain')
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(first.state).toBe('uncertain')
  })
  it('persists definite native refusal as rejected and never retries it', async () => {
    const f = await qualifiedFixture()
    f.send.mockRejectedValueOnce(new SubagentDispatchRejectedError())
    const first = await f.service.input(f.writer.principal, 'http', f.command)
    expect(first).toMatchObject({ state: 'rejected', reasonCode: 'SUBAGENT_NATIVE_REJECTED' })
    expect(await f.service.input(f.writer.principal, 'mcp', f.command)).toEqual(first)
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('rechecks authorization even when native receipt readback fails', async () => {
    const f = await qualifiedFixture()
    f.send.mockRejectedValueOnce(new Error('lost ACK'))
    await f.service.input(f.writer.principal, 'http', f.command)
    f.lease.reconcile = async () => {
      await pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.writer.principal.id,
        JSON.stringify([{ actions: ['runs:read'], scope: { runIds: [f.input.runId] } }])])
      throw new Error('native readback disconnected')
    }
    await expect(f.service.input(f.writer.principal, 'mcp', f.command)).rejects.toMatchObject({ status: 403 })
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('rejects cross-Run/workspace ownership and conflicting source identities', async () => {
    const f = await fixture(); const original = await f.discover()
    const child = (await f.service.list(f.reader.principal, f.input)).items[0]!.subagent
    await expect(f.service.get(f.reader.principal, { ...f.input, runId: 'foreign', subagentId: child.id })).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    await expect(f.service.get(f.reader.principal, { ...f.input, workspaceId: 'foreign', subagentId: child.id })).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    const other = await fixture()
    await expect(other.service.get(other.reader.principal, { ...other.input, subagentId: child.id })).rejects.toMatchObject({ code: 'SUBAGENT_NOT_FOUND' })
    await expect(appendNativeEvent(pool, { ...original, payload: { changed: true } })).rejects.toMatchObject({ code: 'NATIVE_EVENT_IDENTITY_CONFLICT' })
    await f.event('item.completed', { threadId: 'root', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'] } })
    await expect(f.service.list(f.reader.principal, f.input)).rejects.toMatchObject({ code: 'SUBAGENT_SOURCE_CONFLICT' })
  })
  it('commits native backfill cursor with its received events and reads through a fresh pool after reconnect', async () => {
    const f = await fixture()
    const read = vi.fn(async (executionId: string, session: { nativeSessionId: string }, cursor: string | undefined) => {
      expect(executionId).toBe(f.executionId); expect(session.nativeSessionId).toBe('root')
      return cursor === undefined ? { events: [childHistoryEvent('item.completed', { threadId: 'root', item: { type: 'subAgentActivity', id: 'history-spawn', kind: 'started', agentThreadId: 'history-child', agentPath: '/root/history' } })], nextCursor: 'child-page' }
        : { events: [childHistoryEvent('native.unlinked_notification', { method: 'item/completed', params: { threadId: 'history-child', item: { type: 'agentMessage', id: 'history-message', text: 'RECOVERED HISTORY' } } })], nextCursor: null }
    })
    const recovering = new RunSubagentService(pool, undefined, read)
    await backfillRunSubagents(recovering, f.reader.principal, f.input)
    expect((await pool.query('select child_cursor,complete from run_subagent_backfill_state where execution_id=$1', [f.executionId])).rows[0]).toEqual({ child_cursor: 'child-page', complete: false })
    await backfillRunSubagents(recovering, f.reader.principal, f.input)
    const freshPool = new pg.Pool({ ...pool.options, max: 2 })
    try {
      const reader = new RunSubagentService(freshPool)
      const children = await reader.list(f.reader.principal, f.input)
      const child = children.items[0]!.subagent
      expect((await reader.messages(f.reader.principal, { ...f.input, subagentId: child.id })).items).toMatchObject([{ text: 'RECOVERED HISTORY' }])
      await backfillRunSubagents(recovering, f.reader.principal, f.input)
      expect(read).toHaveBeenCalledTimes(2)
      expect((await pool.query('select count(*)::int as count from harness_native_events where execution_id=$1', [f.executionId])).rows[0].count).toBe(2)
    } finally { await freshPool.end() }
  })
  it('serves authenticated MCP/HTTP reads and commands with denied caller audit and persisted readback', async () => {
    const f = await qualifiedFixture()
    const commands = new PostgresCommandCoordinator(pool)
    const services = { commands, runs: { subagents: f.service }, workspaces: {}, workflows: {}, agents: {}, locations: {}, harnesses: {} } as unknown as OperatorServices
    const app = Fastify()
    app.setErrorHandler((error, _request, reply) => {
      const domain = error instanceof DomainError ? error : new DomainError('INTERNAL_ERROR', 'Request failed.', 500)
      reply.code(domain.status).send({ error: { code: domain.code, message: domain.message } })
    })
    registerOperatorHttpSecurity(app, f.access)
    registerRunSubagentRoutes(app, services)
    registerGraphqlMcp(app, { access: f.access, operator: services })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const clients: Client[] = []
    const connect = async (token: string) => { const client = new Client({ name: 'subagent-core', version: '1' }); clients.push(client); await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } })); return client }
    try {
      const allowed = await connect(f.writer.token), reader = await connect(f.reader.token), denied = await connect(f.denied.token)
      expect((await reader.listTools()).tools.map(tool => tool.name)).toContain('run_subagents_list_v1')
      expect((await reader.listTools()).tools.map(tool => tool.name)).not.toContain('run_subagent_input_v1')
      const deniedWrite = await reader.callTool({ name: 'run_subagent_input_v1', arguments: f.command })
      expect(deniedWrite.isError).toBe(true)
      expect((await denied.callTool({ name: 'run_subagents_list_v1', arguments: f.input })).isError).toBe(true)
      const listed = RunSubagentsPageSchema.parse((await reader.callTool({ name: 'run_subagents_list_v1', arguments: f.input })).structuredContent)
      expect(listed.items[0]!.subagent.id).toBe(f.child.id)
      const receipt = RunSubagentCommandReceiptSchema.parse((await allowed.callTool({ name: 'run_subagent_input_v1', arguments: f.command })).structuredContent)
      expect(receipt.state).toBe('acknowledged')
      const persisted = RunSubagentCommandReceiptSchema.parse((await pool.query('select record from run_subagent_command_receipts where id=$1', [receipt.id])).rows[0].record)
      expect(persisted).toEqual(receipt)
      const http = await app.inject({ method: 'GET', url: `/api/management/workspaces/${f.input.workspaceId}/runs/${f.input.runId}/subagents`, headers: { host: '127.0.0.1', authorization: `Bearer ${f.reader.token}` } })
      expect(http.statusCode).toBe(200); expect(RunSubagentsPageSchema.parse(http.json()).items[0]!.subagent.id).toBe(f.child.id)
      const httpRetry = await app.inject({ method: 'POST', url: `/api/management/workspaces/${f.input.workspaceId}/runs/${f.input.runId}/subagents/${f.child.id}/input`, payload: f.command, headers: { host: '127.0.0.1', authorization: `Bearer ${f.writer.token}` } })
      expect(httpRetry.statusCode).toBe(200); expect(httpRetry.json()).toEqual(receipt); expect(f.send).toHaveBeenCalledTimes(1)
      const deniedAudit = await pool.query('select count(*)::int as count from management_audit where principal_id=$1 and outcome=\'denied\'', [f.reader.principal.id])
      expect(deniedAudit.rows[0].count).toBeGreaterThanOrEqual(1)
      expect(RunSubagentSchema.parse((await f.service.get(f.reader.principal, { ...f.input, subagentId: f.child.id })).subagent).id).toBe(f.child.id)
      expect(RunSubagentMessagesPageSchema.parse((await reader.callTool({ name: 'run_subagent_messages_list_v1', arguments: { ...f.input, subagentId: f.child.id } })).structuredContent).items).toEqual([])
    } finally { for (const client of clients) await client.close(); await app.close() }
  }, 30000)
})
