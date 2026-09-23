import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type pg from 'pg'
import { AgentConfigurationVersionSchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@graphql/contracts'
import {
  GraphDraftSchema, GraphDraftCommandResultSchema, GraphDraftDiscardResultSchema, ManagementActionSchema,
} from '@graphql/contracts/management'
import {
  GraphDraftV2Schema, GraphDraftCommandV2ResultSchema, GraphSaveCommandV2ResultSchema,
  WorkflowVersionV2Schema, WAVE25_ADMISSION_ENABLED, makeWave25Fixture,
} from '@graphql/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { GraphDraftService } from '../src/modules/graph-drafts/service.js'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import type { HarnessConfigurationQualifier } from '../src/modules/harnesses/port.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import type { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { AgentManagementService } from '../src/modules/workspaces/agents.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { agent3Database, seedAgent3, postgresEnabled } from './helpers/wave25Agent3.js'

const DraftSchema = GraphDraftSchema.or(GraphDraftV2Schema)
const ApplyResultSchema = GraphDraftCommandResultSchema.or(GraphDraftCommandV2ResultSchema)
type Draft = z.infer<typeof DraftSchema>
type Scope = { workspaceId: string; workflowId: string }
type Transport = 'http' | 'mcp'
type Tool = 'graph_draft_open' | 'graph_draft_get' | 'graph_draft_apply' | 'graph_draft_discard' | 'graph_save'
type ApplyInput = Parameters<GraphDraftService['apply']>[2]
type DiscardInput = Parameters<GraphDraftService['discard']>[2]

/** WR4-003: real migrated PostgreSQL, real common service/command coordinator,
 * authenticated HTTP and loopback Operator MCP. The helper requires explicit
 * opt-in to a loopback test database and owns only its random schema.
 * No service or SQL guard is mocked. Only unused engine/qualifier ports are
 * synthetic. Cookie enrollment deliberately uses the existing test composition
 * without BrowserAuthentication; this is not an owner-account browser test.
 * Neither v2 admission nor a native provider is enabled by this suite. */
describe.skipIf(!postgresEnabled)('WR4-003 durable draft instance replacement', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  let app: ReturnType<typeof buildApp>
  let address: string
  let access: PostgresAccessService
  let drafts: GraphDraftService
  let managed: WorkflowManagementService
  const clients: Client[] = []
  const start = vi.fn(async () => undefined)
  const qualify = vi.fn<HarnessConfigurationQualifier['qualify']>(async () => {
    throw new Error('Draft lifecycle must not call a native qualifier')
  })

  beforeAll(async () => {
    db = await agent3Database()
    access = new PostgresAccessService(db.pool)
    const commands = new PostgresCommandCoordinator(db.pool)
    drafts = new GraphDraftService(db.pool, commands)
    managed = new WorkflowManagementService(db.pool, commands)
    const locations = new WorkspaceLocationService(db.pool, commands, db.directory)
    const workflows = new PostgresWorkflowRepository(db.pool)
    const runs = new PostgresRunRepository(db.pool, workflows, locations)
    const settings = new PostgresSettingsRepository(db.pool)
    const engine = { start, cancel: vi.fn(async () => false) } as unknown as LangGraphWorkflowEngine
    app = buildApp({
      readiness: { database: { ping: async () => { await db.pool.query('select 1') } }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: {
        commands, locations, drafts, workflows: managed,
        runs: new RunManagementService(db.pool, commands, runs, engine, locations),
        agents: new AgentManagementService(db.pool), workspaces: new WorkspaceManagementService(db.pool, commands, locations),
        harnesses: new HarnessCatalogService({ qualify }, settings, commands, db.directory),
      } },
    })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60000)

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined)
    await app?.close()
    await db?.close()
  })

  async function actor(grants: Parameters<PostgresAccessService['issue']>[0]['grants']) {
    const issued = await access.issue({ name: 'WR4-003 test principal', audience: 'operator', grants,
      expiresAt: new Date(Date.now() + 600_000) })
    const client = new Client({ name: 'wr4-003-draft-lifecycle', version: '1.0.0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address), {
        authProvider: { token: async () => issued.token },
      }))
    } catch (error) { await client.close().catch(() => undefined); throw error }
    clients.push(client)
    const enrolled = await app.inject({ method: 'POST', url: '/api/auth/enroll',
      headers: { host: 'localhost' }, payload: { token: issued.token } })
    expect(enrolled.statusCode, enrolled.body).toBe(200)
    const cookie = String(enrolled.headers['set-cookie']).split(';')[0]!
    return { ...issued, client, cookie }
  }
  type Actor = Awaited<ReturnType<typeof actor>>

  function route(tool: Tool, input: Record<string, unknown>) {
    const root = `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/drafts`
    switch (tool) {
      case 'graph_draft_open': return { method: 'POST' as const, url: root }
      case 'graph_draft_get': return { method: 'GET' as const, url: `${root}/${input.draftId}` }
      case 'graph_draft_apply': return { method: 'POST' as const, url: `${root}/${input.draftId}/operations`, payload: input }
      case 'graph_draft_discard': return { method: 'DELETE' as const, url: `${root}/${input.draftId}`, payload: input }
      case 'graph_save': return { method: 'POST' as const, url: `${root}/${input.draftId}/save`, payload: input }
    }
  }
  function headers(who: Actor) { return { host: 'localhost', origin: 'http://localhost', cookie: who.cookie } }
  async function call<T>(transport: Transport, who: Actor, tool: Tool, schema: z.ZodType<T>, input: Record<string, unknown>): Promise<T> {
    if (transport === 'mcp') {
      const result = await who.client.callTool({ name: tool, arguments: input })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return schema.parse(result.structuredContent)
    }
    const response = await app.inject({ ...route(tool, input), headers: headers(who) })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    return schema.parse(response.json())
  }
  async function failure(transport: Transport, who: Actor, tool: Tool, input: Record<string, unknown>, code: string, status: number) {
    if (transport === 'mcp') {
      const result = await who.client.callTool({ name: tool, arguments: input })
      expect(result.isError, JSON.stringify(result)).toBe(true)
      expect(result.structuredContent).toMatchObject({ error: { code } })
    } else {
      const response = await app.inject({ ...route(tool, input), headers: headers(who) })
      expect(response.statusCode, response.body).toBe(status)
      expect(response.json()).toMatchObject({ error: { code } })
    }
  }
  async function deniedWrite(who: Actor, tool: 'graph_draft_apply' | 'graph_draft_discard' | 'graph_save', input: Record<string, unknown>) {
    await failure('http', who, tool, input, 'ACCESS_DENIED', 403)
    const available = (await who.client.listTools()).tools.some((item) => item.name === tool)
    if (available) {
      await failure('mcp', who, tool, input, 'ACCESS_DENIED', 403)
    } else {
      // Permission-filtered discovery may omit the tool entirely. Invoking the
      // authenticated endpoint must still fail; arbitrary server errors do not count.
      let result: Awaited<ReturnType<Client['callTool']>>
      try { result = await who.client.callTool({ name: tool, arguments: input }) }
      catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toMatch(/tool.*(not found|unknown|not available)|unknown tool/i)
        return
      }
      expect(result.isError, JSON.stringify(result)).toBe(true)
      expect(JSON.stringify(result)).toMatch(/tool.*(not found|unknown|not available)|unknown tool|ACCESS_DENIED/i)
    }
  }

  async function draftRow(scope: Scope) {
    const result = await db.pool.query<{ id: string; revision: string; base_workflow_version_id: string | null; record: unknown; discarded_at: Date | null }>(
      'select id,revision::text,base_workflow_version_id,record,discarded_at from graph_drafts where workspace_id=$1 and workflow_id=$2',
      [scope.workspaceId, scope.workflowId])
    expect(result.rowCount).toBe(1)
    return result.rows[0]!
  }
  async function accepted(scope: Scope) {
    const workflow = (await db.pool.query<{ row: Record<string, unknown> }>(
      'select to_jsonb(w) as row from workflows w where w.workspace_id=$1 and w.id=$2', [scope.workspaceId, scope.workflowId])).rows[0]!.row
    const versions = (await db.pool.query<{ row: unknown }>(
      'select to_jsonb(v) as row from workflow_versions v where workspace_id=$1 and workflow_id=$2 order by version,id',
      [scope.workspaceId, scope.workflowId])).rows.map((item) => item.row)
    return { workflow, versions }
  }
  async function oldReceipts(who: Actor, draftId: string) {
    return (await db.pool.query<{ row: unknown }>(
      'select to_jsonb(r) as row from management_command_receipts r where principal_id=$1 and target_key=$2 order by operation,command_id',
      [who.principal.id, `draft:${draftId}`])).rows.map((item) => item.row)
  }
  async function noExecution() {
    for (const table of ['runs', 'harness_executions', 'review_jobs', 'run_graph_heads']) {
      expect((await db.pool.query(`select 1 from ${table}`)).rowCount, table).toBe(0)
    }
    expect(start).not.toHaveBeenCalled()
    expect(qualify).not.toHaveBeenCalled()
    expect(WAVE25_ADMISSION_ENABLED).toBe(true)
  }
  async function rejectsSql(code: string, work: (client: pg.PoolClient) => Promise<unknown>, writer = '') {
    const client = await db.pool.connect()
    try {
      await client.query('begin')
      // Reset on this exact connection: do not let an unrelated test's setting
      // accidentally qualify a forbidden write. This setting is transaction-local.
      await client.query("select set_config('graphql.approval_writer',$1,true)", [writer])
      await expect(work(client)).rejects.toMatchObject({ code })
    } finally { await client.query('rollback'); client.release() }
  }
  async function sameInstanceGuards(draft: Draft) {
    const before = await draftRow(draft)
    for (const writer of ['', 'v2']) {
      await rejectsSql('PGA01', (client) => client.query(
        `update graph_drafts set record=jsonb_set(record,'{graph}',(record->'graph')-'executionSemanticsVersion'-'entryNodeId') where id=$1`,
        [draft.id]), writer)
    }
    const typed = GraphDraftV2Schema.parse(draft)
    const edge = typed.graph.edges[0]!
    const replacement = GraphDraftV2Schema.parse({ ...typed, graph: { ...typed.graph,
      edges: typed.graph.edges.some((item) => item.kind === 'approval')
        ? typed.graph.edges.filter((item) => item.kind !== 'approval')
        : [...typed.graph.edges, { id: `guard-${randomUUID()}`, kind: 'approval', source: edge.source, target: edge.target }],
    } })
    await rejectsSql('PGA04', (client) => client.query('update graph_drafts set record=$2::jsonb where id=$1',
      [typed.id, JSON.stringify(replacement)]))
    expect(await draftRow(draft)).toEqual(before)
  }

  async function fixture(variant: 'unpublished' | 'approval', transport: Transport) {
    const candidate = makeWave25Fixture(randomUUID())
    if (variant === 'approval') {
      candidate.configurations[0] = AgentConfigurationVersionSchema.parse({ ...candidate.configurations[0], productRole: 'orchestrator',
        harness: { ...candidate.configurations[0]!.harness, advanced: {
          ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
        } } })
      const approval = { handler: 'orchestrator', designatedOrchestratorAgentId: candidate.configurations[0]!.agentId }
      candidate.version = WorkflowVersionV2Schema.parse({ ...candidate.version, approval,
        definition: { ...candidate.version.definition, approval } })
    }
    // Neither the converted draft nor the accepted v2 workflow is inserted by
    // hand. Both start from a saved legacy source and use common apply/save.
    const f = await seedAgent3(db.pool, db.directory, candidate, { run: false, legacy: true })
    const scope = { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId }
    const owner = await actor([{ actions: ManagementActionSchema.options, scope: { workspaceIds: [scope.workspaceId] } }])
    const opened = await call(transport, owner, 'graph_draft_open', GraphDraftSchema, scope)
    const legacy = await accepted(scope)
    const approvalEdge = { id: `approval-${randomUUID()}`, kind: 'approval' as const,
      source: f.version.definition.edges[0]!.source, target: f.version.definition.edges[0]!.target }
    const applyInput: ApplyInput = { ...scope, draftId: opened.id, expectedRevision: opened.revision, commandId: randomUUID(),
      executionSemanticsVersion: 2, operations: [
        { type: 'workflow.set_entry', entryNodeId: f.version.entryNodeId },
        ...(variant === 'approval' ? [{ type: 'relationship.put' as const, relationship: approvalEdge }] : []),
      ] }
    const applied = await call(transport, owner, 'graph_draft_apply', GraphDraftCommandV2ResultSchema, applyInput)
    expect(await accepted(scope)).toEqual(legacy)
    let current: Draft = applied.value.draft
    if (variant === 'approval') {
      const saved = await call(transport, owner, 'graph_save', GraphSaveCommandV2ResultSchema, {
        ...scope, draftId: current.id, expectedRevision: current.revision, commandId: randomUUID(), executionSemanticsVersion: 2,
      })
      expect(saved.value.version.definition.edges).toContainEqual(approvalEdge)
      expect(saved.value.version.approval).toEqual(candidate.version.approval)
      expect((await accepted(scope)).versions).toHaveLength(2)
      const removed = await call(transport, owner, 'graph_draft_apply', GraphDraftCommandV2ResultSchema, {
        ...scope, draftId: current.id, expectedRevision: saved.value.draft.revision, commandId: randomUUID(), executionSemanticsVersion: 2,
        operations: [{ type: 'edge.disconnect', edgeId: approvalEdge.id }],
      })
      current = removed.value.draft
      expect(GraphDraftV2Schema.parse(current).graph.edges.some((item) => item.id === approvalEdge.id)).toBe(false)
    }
    return { f, scope, owner, opened, current, legacy, applyInput, applied, approvalEdge, baseline: await accepted(scope) }
  }

  it('uses the registered migrated guards and has no cascading draft identity dependents', async () => {
    expect((await db.pool.query('select 1 from application_migrations where version=250003')).rowCount).toBe(1)
    const trigger = await db.pool.query<{ tgenabled: string; definition: string }>(
      `select tgenabled,pg_get_triggerdef(oid) as definition from pg_trigger
       where tgrelid='graph_drafts'::regclass and tgname='wave25_approval_draft_writer' and not tgisinternal`)
    expect(trigger.rowCount).toBe(1)
    expect(trigger.rows[0]!.tgenabled).toBe('O')
    expect(trigger.rows[0]!.definition).toContain('BEFORE UPDATE OF record')
    expect(trigger.rows[0]!.definition).toContain('wave25_approval_no_downgrade')
    // Deliberately fail if a future migration introduces an ID-dependent child
    // (including ON DELETE CASCADE) that would need an explicit retention policy.
    expect((await db.pool.query(
      "select conname from pg_constraint where contype='f' and confrelid='graph_drafts'::regclass")).rows).toEqual([])
    expect((await db.pool.query(
      "select tgname from pg_trigger where tgrelid='graph_drafts'::regclass and not tgisinternal and (tgtype::integer & 8)<>0")).rows).toEqual([])
  })

  for (const transport of ['http', 'mcp'] as const) for (const variant of ['unpublished', 'approval'] as const) {
    it(`${transport}: ${variant} discard/reopen preserves source, receipts, permissions and strict guards`, async () => {
      const x = await fixture(variant, transport)
      const { scope, owner, current, baseline } = x
      const other: Transport = transport === 'http' ? 'mcp' : 'http'
      expect(await draftRow(scope)).toMatchObject({ id: current.id, revision: String(current.revision), record: current, discarded_at: null })
      expect(baseline.versions[0]).toEqual(x.legacy.versions[0])
      if (variant === 'unpublished') expect(baseline).toEqual(x.legacy)
      await sameInstanceGuards(current)

      const discardInput: DiscardInput = { ...scope, draftId: current.id, expectedRevision: current.revision, commandId: randomUUID() }
      const editInput: ApplyInput = { ...scope, draftId: current.id, expectedRevision: current.revision, commandId: randomUUID(),
        executionSemanticsVersion: 2, operations: [{ type: 'node.rename', nodeId: x.f.version.entryNodeId, name: 'Unauthorized edit' }] }
      const saveInput = { ...scope, draftId: current.id, expectedRevision: current.revision, commandId: randomUUID(), executionSemanticsVersion: 2 }
      const sibling = (await managed.create(owner.principal, 'http', {
        workspaceId: scope.workspaceId, commandId: randomUUID(), name: 'Other workflow',
      })).value.workflow
      const siblingScope = { workspaceId: scope.workspaceId, workflowId: sibling.id }
      const siblingBefore = await accepted(siblingScope)
      const readOnly = await actor([{ actions: ['graph:read'], scope: { workspaceIds: [scope.workspaceId] } }])
      const wrongWorkspace = await actor([{ actions: ManagementActionSchema.options, scope: { workspaceIds: ['not-this-workspace'] } }])
      const wrongWorkflow = await actor([{ actions: ManagementActionSchema.options,
        scope: { workspaceIds: [scope.workspaceId], workflowIds: [sibling.id] } }])
      for (const channel of ['http', 'mcp'] as const) {
        expect((await call(channel, readOnly, 'graph_draft_open', DraftSchema, scope)).id).toBe(current.id)
        expect((await call(channel, readOnly, 'graph_draft_get', DraftSchema, { ...scope, draftId: current.id })).id).toBe(current.id)
        for (const outsider of [wrongWorkspace, wrongWorkflow]) {
          for (const [tool, input] of [
            ['graph_draft_open', scope], ['graph_draft_get', { ...scope, draftId: current.id }],
            ['graph_draft_apply', editInput], ['graph_draft_discard', discardInput], ['graph_save', saveInput],
          ] as const) await failure(channel, outsider, tool, input, 'ACCESS_DENIED', 403)
        }
        // An authorized sibling scope still cannot resolve this workflow's ID.
        await failure(channel, owner, 'graph_draft_get', { ...siblingScope, draftId: current.id }, 'GRAPH_DRAFT_NOT_FOUND', 404)
        await failure(channel, owner, 'graph_draft_apply', { ...editInput, ...siblingScope }, 'GRAPH_DRAFT_NOT_FOUND', 404)
        await failure(channel, owner, 'graph_draft_discard', { ...discardInput, commandId: randomUUID(), expectedRevision: current.revision - 1 }, 'REVISION_CONFLICT', 409)
        await failure(channel, owner, 'graph_draft_apply', { ...editInput, commandId: randomUUID(), expectedRevision: current.revision - 1 }, 'REVISION_CONFLICT', 409)
      }
      for (const [tool, input] of [
        ['graph_draft_apply', editInput], ['graph_draft_discard', discardInput], ['graph_save', saveInput],
      ] as const) await deniedWrite(readOnly, tool, input)
      for (const tool of ['graph_draft_open', 'graph_draft_get', 'graph_draft_apply', 'graph_draft_discard', 'graph_save'] as const) {
        const input = tool === 'graph_save' ? saveInput : tool === 'graph_draft_apply' ? editInput : discardInput
        expect((await app.inject({ ...route(tool, input), headers: { host: 'localhost' } })).statusCode).toBe(401)
        expect((await app.inject({ method: 'POST', url: '/mcp/operator',
          headers: { host: 'localhost', accept: 'application/json, text/event-stream' },
          payload: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: tool, arguments: input } },
        })).statusCode).toBe(401)
      }
      expect(await draftRow(scope)).toMatchObject({ record: current, discarded_at: null })
      const discarded = await call(transport, owner, 'graph_draft_discard', GraphDraftDiscardResultSchema, discardInput)
      expect(discarded.replayed).toBe(false)
      expect(discarded.value).toMatchObject({ draftId: current.id, revision: current.revision, discarded: true })
      expect(await call(other, owner, 'graph_draft_discard', GraphDraftDiscardResultSchema, discardInput))
        .toEqual({ ...discarded, replayed: true })
      const discardedRow = await draftRow(scope)
      expect(discardedRow.record).toEqual(current)
      expect(discardedRow.discarded_at).not.toBeNull()
      const receipts = await oldReceipts(owner, current.id)
      expect(receipts.length).toBeGreaterThanOrEqual(2)
      await failure(transport, owner, 'graph_draft_get', { ...scope, draftId: current.id }, 'GRAPH_DRAFT_NOT_FOUND', 404)

      // Independently exercise the ORIGINAL failing statement against the actual
      // service-produced discarded row and installed migration. Both probes roll
      // back. A successful probe would mean this regression is no longer testing
      // the reported guard, even if the new open happened to return successfully.
      const replacement = DraftSchema.parse({ ...current, id: `probe-${randomUUID()}`, revision: 0,
        baseWorkflowVersionId: baseline.workflow.current_version_id,
        publishedRevision: 0, graph: baseline.workflow.record, stagedAgents: [], sourceAgentPins: [] })
      await rejectsSql(variant === 'unpublished' ? 'PGA01' : 'PGA04', (client) => client.query(
        `update graph_drafts set id=$1,revision=0,base_workflow_version_id=$2,
          record=$3::jsonb,discarded_at=null,updated_at=now() where workflow_id=$4 and workspace_id=$5`,
        [replacement.id, replacement.baseWorkflowVersionId, JSON.stringify(replacement), scope.workflowId, scope.workspaceId]))
      expect(await draftRow(scope)).toEqual(discardedRow)

      // The actual open/get chain used by editor context loading, through both
      // authenticated transports and a separate committed-row read.
      const reopened = await call(transport, owner, 'graph_draft_open', DraftSchema, scope)
      expect(reopened.id).not.toBe(current.id)
      expect(reopened.revision).toBe(0)
      expect(reopened.publishedRevision).toBe(0)
      expect(reopened.baseWorkflowVersionId).toBe(baseline.workflow.current_version_id)
      expect(reopened.graph).toEqual(baseline.workflow.record)
      expect(reopened.stagedAgents).toEqual([])
      expect(reopened.sourceAgentPins ?? []).toEqual([])
      if (variant === 'unpublished') expect(GraphDraftSchema.safeParse(reopened).success).toBe(true)
      else {
        const typed = GraphDraftV2Schema.parse(reopened)
        expect(typed.graph.edges).toContainEqual(x.approvalEdge)
        expect(typed.graph.approval).toEqual(x.f.version.approval)
        await sameInstanceGuards(typed)
        // Saved workflow and immutable version guards are unaffected as well.
        await rejectsSql('PGA01', (client) => client.query(
          "update workflows set record=record-'executionSemanticsVersion'-'entryNodeId' where id=$1", [scope.workflowId]), 'v2')
        await rejectsSql('PGA04', (client) => client.query(
          `update workflows set record=jsonb_set(record,'{edges}',
            (select coalesce(jsonb_agg(e),'[]'::jsonb) from jsonb_array_elements(record->'edges') e where e->>'kind'<>'approval')) where id=$1`, [scope.workflowId]))
        await rejectsSql('PGA02', (client) => client.query(
          `update workflow_versions set record=jsonb_set(record,'{definition,name}','"Unqualified version edit"'::jsonb) where id=$1`,
          [reopened.baseWorkflowVersionId]), 'v2')
      }
      const committed = await draftRow(scope)
      expect(committed).toMatchObject({ id: reopened.id, revision: '0', record: reopened, discarded_at: null })
      for (const channel of ['http', 'mcp'] as const) {
        expect(await call(channel, owner, 'graph_draft_get', DraftSchema, { ...scope, draftId: reopened.id })).toEqual(reopened)
        expect(await call(channel, owner, 'graph_draft_open', DraftSchema, scope)).toEqual(reopened)
        await failure(channel, owner, 'graph_draft_get', { ...scope, draftId: current.id }, 'GRAPH_DRAFT_NOT_FOUND', 404)
        await failure(channel, owner, 'graph_draft_apply', { ...editInput, commandId: randomUUID() }, 'GRAPH_DRAFT_NOT_FOUND', 404)
        await failure(channel, owner, 'graph_draft_discard', { ...discardInput, commandId: randomUUID() }, 'GRAPH_DRAFT_NOT_FOUND', 404)
        await failure(channel, owner, 'graph_save', { ...saveInput, commandId: randomUUID() }, 'GRAPH_DRAFT_NOT_FOUND', 404)
      }
      expect((await db.pool.query('select 1 from graph_drafts where id=$1', [current.id])).rowCount).toBe(0)
      expect(await oldReceipts(owner, current.id)).toEqual(receipts)
      expect(await call(other, owner, 'graph_draft_discard', GraphDraftDiscardResultSchema, discardInput))
        .toEqual({ ...discarded, replayed: true })
      expect(await call(other, owner, 'graph_draft_apply', GraphDraftCommandV2ResultSchema, x.applyInput))
        .toEqual({ ...x.applied, replayed: true })
      await failure(other, owner, 'graph_draft_discard', { ...discardInput, draftId: reopened.id }, 'COMMAND_ID_CONFLICT', 409)
      expect(await draftRow(scope)).toEqual(committed)
      for (const operation of ['graph.apply', 'graph.discard']) {
        const commandId = operation === 'graph.apply' ? x.applyInput.commandId : discardInput.commandId
        expect((await db.pool.query(
          `select 1 from management_audit where principal_id=$1 and action=$2 and outcome='succeeded' and details->>'commandId'=$3`,
          [owner.principal.id, operation, commandId])).rowCount).toBe(1)
      }

      const nextEdit: ApplyInput = { ...scope, draftId: reopened.id, expectedRevision: 0, commandId: randomUUID(), executionSemanticsVersion: 2,
        operations: [{ type: 'workflow.set_entry', entryNodeId: x.f.version.entryNodeId },
          { type: 'node.rename', nodeId: x.f.version.entryNodeId, name: 'Edited reopened instance' }] }
      const edited = await call(other, owner, 'graph_draft_apply', ApplyResultSchema, nextEdit)
      expect(edited.value.draft.id).toBe(reopened.id)
      expect(edited.value.draft.revision).toBe(1)
      expect(edited.value.draft.graph.nodes.find((node) => node.id === x.f.version.entryNodeId)?.name).toBe('Edited reopened instance')
      expect((await draftRow(scope)).record).toEqual(edited.value.draft)
      expect(await call(transport, owner, 'graph_draft_get', DraftSchema, { ...scope, draftId: reopened.id })).toEqual(edited.value.draft)
      expect((await call(transport, owner, 'graph_draft_apply', ApplyResultSchema, nextEdit)).replayed).toBe(true)
      await failure(transport, owner, 'graph_draft_apply', { ...nextEdit, commandId: randomUUID() }, 'REVISION_CONFLICT', 409)
      await failure(transport, owner, 'graph_draft_discard', { ...scope, draftId: reopened.id, expectedRevision: 0, commandId: randomUUID() }, 'REVISION_CONFLICT', 409)
      await deniedWrite(readOnly, 'graph_draft_apply', { ...nextEdit, commandId: randomUUID(), expectedRevision: 1 })
      await sameInstanceGuards(edited.value.draft)
      expect(await accepted(scope)).toEqual(baseline)
      expect(await accepted(siblingScope)).toEqual(siblingBefore)
      expect(await oldReceipts(owner, current.id)).toEqual(receipts)
      await noExecution()

      // A once-authorized receipt is not permission to replay after revocation.
      const beforeRevocation = await draftRow(scope)
      await db.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [owner.principal.id])
      expect((await app.inject({ ...route('graph_draft_discard', discardInput), headers: headers(owner) })).statusCode).toBe(401)
      await expect(owner.client.callTool({ name: 'graph_draft_discard', arguments: discardInput })).rejects.toThrow(/401|unauthoriz|auth|revoked/i)
      expect(await draftRow(scope)).toEqual(beforeRevocation)
      expect(await oldReceipts(owner, current.id)).toEqual(receipts)
    }, 120000)
  }

  for (const variant of ['unpublished', 'approval'] as const) {
    it(`${variant}: a failed replacement INSERT restores the discarded instance and its receipts`, async () => {
      const x = await fixture(variant, 'http')
      const discardInput = { ...x.scope, draftId: x.current.id, expectedRevision: x.current.revision, commandId: randomUUID() }
      const discarded = await drafts.discard(x.owner.principal, 'http', discardInput)
      const before = await draftRow(x.scope)
      const receipts = await oldReceipts(x.owner, x.current.id)
      // Additional fault injection in this helper's isolated random schema only.
      // No production trigger is removed, replaced or disabled. The injected
      // INSERT trigger proves the deletion happened in the same transaction,
      // then fails; the service must restore the old tuple on rollback.
      await db.pool.query(`create function wr4_003_reject_insert() returns trigger language plpgsql as $$
        begin
          if NEW.workflow_id=TG_ARGV[0] then
            if exists(select 1 from graph_drafts where id=TG_ARGV[1]) then
              raise exception 'WR4_003_OLD_INSTANCE_STILL_PRESENT' using errcode='PW302';
            end if;
            if NEW.record#>>'{graph,executionSemanticsVersion}'='2'
              and current_setting('graphql.approval_writer',true) is distinct from 'v2' then
              raise exception 'WR4_003_TYPED_INSERT_NOT_QUALIFIED' using errcode='PW303';
            end if;
            raise exception 'WR4_003_INJECTED_INSERT_FAILURE' using errcode='PW301';
          end if;
          return NEW;
        end $$`)
      const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
      try {
        await db.pool.query(`create trigger wr4_003_insert_fault before insert on graph_drafts for each row
          execute function wr4_003_reject_insert(${literal(x.scope.workflowId)},${literal(x.current.id)})`)
        await expect(drafts.open(x.owner.principal, x.scope.workspaceId, x.scope.workflowId)).rejects.toMatchObject({ code: 'PW301', message: 'WR4_003_INJECTED_INSERT_FAILURE' })
        expect(await draftRow(x.scope)).toEqual(before)
        expect(await oldReceipts(x.owner, x.current.id)).toEqual(receipts)
        expect(await accepted(x.scope)).toEqual(x.baseline)
        expect(await drafts.discard(x.owner.principal, 'mcp', discardInput)).toEqual({ ...discarded, replayed: true })
      } finally {
        await db.pool.query('drop trigger if exists wr4_003_insert_fault on graph_drafts')
        await db.pool.query('drop function wr4_003_reject_insert()')
      }
      const reopened = await call('mcp', x.owner, 'graph_draft_open', DraftSchema, x.scope)
      expect(reopened.id).not.toBe(x.current.id)
      expect(reopened.graph).toEqual(x.baseline.workflow.record)
      expect((await draftRow(x.scope)).record).toEqual(reopened)
      expect(await oldReceipts(x.owner, x.current.id)).toEqual(receipts)
      expect(await accepted(x.scope)).toEqual(x.baseline)
      await noExecution()
    }, 120000)

    it(`${variant}: concurrent common-service opens converge on one fresh instance`, async () => {
      const x = await fixture(variant, 'mcp')
      const discardInput = { ...x.scope, draftId: x.current.id, expectedRevision: x.current.revision, commandId: randomUUID() }
      const discarded = await drafts.discard(x.owner.principal, 'mcp', discardInput)
      const receipts = await oldReceipts(x.owner, x.current.id)
      // Separate service instances acquire actual pooled PostgreSQL connections.
      // This checks convergence, not a deterministic database deadlock schedule.
      const readers = Array.from({ length: 4 }, () => new GraphDraftService(db.pool, new PostgresCommandCoordinator(db.pool)))
      const opened = await Promise.all(readers.map((service) => service.open(x.owner.principal, x.scope.workspaceId, x.scope.workflowId)))
      const current = opened[0]!
      for (const item of opened) expect(item).toEqual(current)
      expect(current.id).not.toBe(x.current.id)
      expect(current.revision).toBe(0)
      expect(current.graph).toEqual(x.baseline.workflow.record)
      expect((await draftRow(x.scope)).record).toEqual(current)
      expect(await drafts.discard(x.owner.principal, 'http', discardInput)).toEqual({ ...discarded, replayed: true })
      expect(await oldReceipts(x.owner, x.current.id)).toEqual(receipts)
      expect(await accepted(x.scope)).toEqual(x.baseline)
      await noExecution()
    }, 120000)
  }

  it('retains null source markers and read-only open permission for an unversioned legacy workflow', async () => {
    const f = await seedAgent3(db.pool, db.directory, makeWave25Fixture(randomUUID()), { run: false, legacy: true })
    const owner = await actor([{ actions: ManagementActionSchema.options, scope: { workspaceIds: [f.scope.workspaceId] } }])
    const sibling = (await managed.create(owner.principal, 'http', {
      workspaceId: f.scope.workspaceId, commandId: randomUUID(), name: 'Unversioned draft source',
    })).value.workflow
    const scope = { workspaceId: f.scope.workspaceId, workflowId: sibling.id }
    const baseline = await accepted(scope)
    expect(baseline.workflow.current_version_id).toBeNull()
    expect(baseline.versions).toEqual([])
    const opened = await call('http', owner, 'graph_draft_open', GraphDraftSchema, scope)
    await call('http', owner, 'graph_draft_discard', GraphDraftDiscardResultSchema, {
      ...scope, draftId: opened.id, commandId: randomUUID(), expectedRevision: opened.revision,
    })
    const readOnly = await actor([{ actions: ['graph:read'], scope: { workspaceIds: [scope.workspaceId] } }])
    const reopened = await call('mcp', readOnly, 'graph_draft_open', GraphDraftSchema, scope)
    expect(reopened).toMatchObject({ revision: 0, baseWorkflowVersionId: null, publishedRevision: null, stagedAgents: [] })
    expect(reopened.id).not.toBe(opened.id)
    expect(reopened.graph).toEqual(baseline.workflow.record)
    expect((await draftRow(scope)).record).toEqual(reopened)
    await deniedWrite(readOnly, 'graph_draft_apply', {
      ...scope, draftId: reopened.id, commandId: randomUUID(), expectedRevision: 0,
      operations: [{ type: 'workflow.set_required_agent_count', requiredAgentCount: 2 }],
    })
    await deniedWrite(readOnly, 'graph_draft_discard', {
      ...scope, draftId: reopened.id, commandId: randomUUID(), expectedRevision: 0,
    })
    expect(await accepted(scope)).toEqual(baseline)
    await noExecution()
  }, 120000)
})
