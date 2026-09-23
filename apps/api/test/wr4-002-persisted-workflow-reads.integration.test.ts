import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  AgentConfigurationVersionSchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION, GetWorkflowResponseSchema, WorkflowDefinitionSchema,
  WorkflowDefinitionV2Schema, WorkspaceDetailsResponseSchema,
} from '@graphql/contracts'
import {
  GraphDraftSchema, ManagedWorkflowSchema, ManagedWorkflowPageSchema, ManagementActionSchema,
} from '@graphql/contracts/management'
import {
  GraphDraftCommandV2ResultSchema, GraphSaveCommandV2ResultSchema, WorkflowVersionV2Schema,
  WAVE25_ADMISSION_ENABLED, makeWave25Fixture,
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
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { agent3Database, seedAgent3, postgresEnabled } from './helpers/wave25Agent3.js'

/** WR4-002: opt-in, real migrated PostgreSQL and loopback authenticated MCP/HTTP.
 * The existing helper requires a loopback, explicitly named test database and
 * creates/drops only its random schema. No native session, Run, or admission is
 * enabled. Only the unused engine/qualifier ports are synthetic. Enrollment uses
 * the existing test composition (no BrowserAuthentication), not production owner
 * account sign-in; the latter still requires terminal browser qualification. */
describe.skipIf(!postgresEnabled)('WR4-002 committed mixed-v1/v2 workflow read parity', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  let app: ReturnType<typeof buildApp>
  let access: PostgresAccessService
  let commands: PostgresCommandCoordinator
  let workflows: PostgresWorkflowRepository
  let managed: WorkflowManagementService
  let workspaces: PostgresWorkspaceRepository
  let address: string
  const clients: Client[] = []
  const start = vi.fn(async () => undefined)

  beforeAll(async () => {
    db = await agent3Database()
    access = new PostgresAccessService(db.pool)
    commands = new PostgresCommandCoordinator(db.pool)
    const locations = new WorkspaceLocationService(db.pool, commands, db.directory)
    workflows = new PostgresWorkflowRepository(db.pool)
    const runs = new PostgresRunRepository(db.pool, workflows, locations)
    workspaces = new PostgresWorkspaceRepository(db.pool, workflows, runs)
    managed = new WorkflowManagementService(db.pool, commands)
    const settings = new PostgresSettingsRepository(db.pool)
    const engine = { start, cancel: vi.fn(async () => false) } as unknown as LangGraphWorkflowEngine
    const qualifier: HarnessConfigurationQualifier = { async qualify(configuration) {
      return { harness: configuration.harness, version: 'synthetic-no-native-call', authenticated: true, ready: true,
        structuredEvents: true, supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true,
        supportsStartupPrompt: true, supportedNativeTools: [], supportedSettings: ['model'], unsupportedCapabilities: [] }
    } }
    const services = {
      commands, locations, drafts: new GraphDraftService(db.pool, commands),
      runs: new RunManagementService(db.pool, commands, runs, engine, locations), workflows: managed,
      agents: new AgentManagementService(db.pool), workspaces: new WorkspaceManagementService(db.pool, commands, locations),
      harnesses: new HarnessCatalogService(qualifier, settings, commands, db.directory),
    }
    app = buildApp({
      readiness: { database: { ping: async () => { await db.pool.query('select 1') } }, checkpoints: { ping: async () => undefined } },
      operator: { access, services }, product: { workspaces, workflows, runs, settings, engine },
    })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60000)

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined)
    await app?.close()
    await db?.close()
  })

  async function connect(token: string) {
    const client = new Client({ name: 'wr4-002-persisted-read', version: '1.0.0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address), {
        authProvider: { token: async () => token },
      }))
    } catch (error) { await client.close().catch(() => undefined); throw error }
    clients.push(client)
    return client
  }
  async function call<T>(client: Client, name: string, schema: z.ZodType<T>, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    return schema.parse(result.structuredContent)
  }
  async function denied(client: Client, name: string, args: Record<string, unknown>, emptyPageAllowed = false) {
    let result: Awaited<ReturnType<Client['callTool']>>
    try { result = await client.callTool({ name, arguments: args }) }
    catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/401|403|unauthoriz|forbidden|auth|revoked|denied|not found/i)
      return
    }
    if (emptyPageAllowed && result.isError !== true) {
      expect(ManagedWorkflowPageSchema.parse(result.structuredContent).items).toEqual([])
    } else {
      expect(result.isError, JSON.stringify(result)).toBe(true)
    }
  }
  async function enroll(token: string) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/enroll', headers: { host: 'localhost' }, payload: { token } })
    expect(response.statusCode).toBe(200)
    return String(response.headers['set-cookie']).split(';')[0]!
  }
  async function read<T>(url: string, cookie: string, schema: z.ZodType<T>) {
    const response = await app.inject({ method: 'GET', url, headers: { host: 'localhost', cookie } })
    expect(response.statusCode, response.body).toBe(200)
    return schema.parse(response.json())
  }

  for (const handler of ['user', 'orchestrator'] as const) {
    it(`publishes via the common service and preserves ${handler} topology across persisted reads and revocation`, async () => {
      expect(WAVE25_ADMISSION_ENABLED).toBe(false)
      const candidate = makeWave25Fixture(randomUUID())
      if (handler === 'orchestrator') {
        // The initialized entry is the actual pinned Orchestrator, not a label.
        candidate.configurations[0] = AgentConfigurationVersionSchema.parse({ ...candidate.configurations[0],
          productRole: 'orchestrator',
          harness: { ...candidate.configurations[0]!.harness, advanced: {
            ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
          } },
        })
        const approval = { handler, designatedOrchestratorAgentId: candidate.configurations[0]!.agentId }
        candidate.version = WorkflowVersionV2Schema.parse({ ...candidate.version, approval,
          definition: { ...candidate.version.definition, approval } })
      }
      // Seed legacy source/version only. The v2 current record MUST come from save.
      const f = await seedAgent3(db.pool, db.directory, candidate, { run: false, legacy: true })
      const scope = { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId }
      const owner = await access.issue({ name: 'WR4-002 owner', audience: 'operator',
        grants: [{ actions: ManagementActionSchema.options, scope: { workspaceIds: [scope.workspaceId] } }],
        expiresAt: new Date(Date.now() + 600_000) })
      const client = await connect(owner.token)
      const cookie = await enroll(owner.token)
      const sibling = (await managed.create(owner.principal, 'http', {
        workspaceId: scope.workspaceId, commandId: randomUUID(), name: 'Untouched legacy sibling',
      })).value
      const siblingId = sibling.workflow.id
      const legacyVersion = (await db.pool.query<{ record: unknown }>('select record from workflow_versions where id=$1', [f.version.id])).rows[0]!.record
      const opened = await call(client, 'graph_draft_open', GraphDraftSchema, scope)
      const edge = f.version.definition.edges[0]!
      const choice = { outcomes: [
        { outcome: 'pass', target: { kind: 'branch_end' as const } },
        { outcome: 'issues', target: { kind: 'edge' as const, relationshipId: edge.id } },
      ] }
      const approvalEdge = { id: `approval-${randomUUID()}`, kind: 'approval' as const, source: edge.source, target: edge.target }
      const applyInput = { ...scope, draftId: opened.id, commandId: randomUUID(), expectedRevision: opened.revision,
        executionSemanticsVersion: 2, operations: [
          { type: 'workflow.set_entry', entryNodeId: f.version.entryNodeId },
          { type: 'relationship.put', relationship: { ...edge, label: 'Execution only' } },
          ...(handler === 'orchestrator' ? [{ type: 'relationship.put', relationship: approvalEdge }] : []),
          { type: 'node.set_choice', nodeId: f.version.entryNodeId, choice },
        ] }
      const applied = await call(client, 'graph_draft_apply', GraphDraftCommandV2ResultSchema, applyInput)
      expect((await call(client, 'graph_draft_apply', GraphDraftCommandV2ResultSchema, applyInput)).replayed).toBe(true)
      const saveInput = { ...scope, draftId: opened.id, commandId: randomUUID(), expectedRevision: applied.value.draft.revision, executionSemanticsVersion: 2 }
      const saved = await call(client, 'graph_save', GraphSaveCommandV2ResultSchema, saveInput)
      const replay = await call(client, 'graph_save', GraphSaveCommandV2ResultSchema, saveInput)
      expect(replay.replayed).toBe(true)
      expect(replay.value).toEqual(saved.value)
      // A fresh pool query follows the common command's COMMIT, not a response echo.
      const current = (await db.pool.query<{ record: unknown; revision: string; current_version_id: string }>(
        'select record,revision::text,current_version_id from workflows where workspace_id=$1 and id=$2',
        [scope.workspaceId, scope.workflowId])).rows[0]!
      const expected = WorkflowDefinitionV2Schema.parse(current.record)
      expect(expected).toEqual(saved.value.version.definition)
      expect(expected.executionSemanticsVersion).toBe(2)
      expect(expected.entryNodeId).toBe(f.version.entryNodeId)
      expect(expected.nodes.find((node) => node.id === expected.entryNodeId)?.choice).toEqual(choice)
      expect(expected.edges.find((item) => item.id === edge.id)?.kind).toBe('execution')
      if (handler === 'orchestrator') expect(expected.edges.find((item) => item.id === approvalEdge.id)).toEqual(approvalEdge)
      expect(current.current_version_id).toBe(saved.value.version.id)
      expect(saved.value.draft.revision).toBe(applied.value.draft.revision + 1)
      expect((await db.pool.query('select 1 from workflow_versions where workflow_id=$1', [scope.workflowId])).rowCount).toBe(2)
      expect((await db.pool.query<{ record: unknown }>('select record from workflow_versions where id=$1', [f.version.id])).rows[0]!.record).toEqual(legacyVersion)
      expect((await db.pool.query('select 1 from management_command_receipts where principal_id=$1 and operation=$2 and command_id=$3',
        [owner.principal.id, 'graph.save', saveInput.commandId])).rowCount).toBe(1)
      expect((await db.pool.query("select 1 from management_audit where principal_id=$1 and action='graph.save' and source='mcp' and outcome='succeeded' and details->>'commandId'=$2",
        [owner.principal.id, saveInput.commandId])).rowCount).toBe(1)

      // Repository/aggregate and fresh common management service read persisted rows.
      expect(await workflows.get(scope.workspaceId, scope.workflowId)).toEqual(expected)
      expect((await workspaces.getDetails(scope.workspaceId))!.workflows).toEqual(expect.arrayContaining([expected, sibling.workflow]))
      const fresh = new WorkflowManagementService(db.pool, commands)
      const freshGet = await fresh.get(owner.principal, scope.workspaceId, scope.workflowId)
      expect(freshGet).toMatchObject({ workflow: expected, revision: Number(current.revision), currentVersionId: saved.value.version.id })
      expect((await fresh.list(owner.principal, { workspaceId: scope.workspaceId, limit: 100, includeArchived: false })).items.map((item) => item.workflow))
        .toEqual(expect.arrayContaining([expected, sibling.workflow]))
      const workspacePath = `/api/workspaces/${scope.workspaceId}`
      const productPath = `${workspacePath}/workflows/${scope.workflowId}`
      const managedListPath = `/api/management/workspaces/${scope.workspaceId}/workflows`
      const managedPath = `${managedListPath}/${scope.workflowId}`
      const workspaceRead = await read(workspacePath, cookie, WorkspaceDetailsResponseSchema)
      expect(workspaceRead.workflows).toEqual(expect.arrayContaining([expected, sibling.workflow]))
      expect((await read(productPath, cookie, GetWorkflowResponseSchema)).workflow).toEqual(expected)
      expect(WorkflowDefinitionSchema.parse((await read(`${workspacePath}/workflows/${siblingId}`, cookie, GetWorkflowResponseSchema)).workflow)).toEqual(sibling.workflow)
      expect((await read(managedPath, cookie, ManagedWorkflowSchema)).workflow).toEqual(expected)
      expect((await read(managedListPath, cookie, ManagedWorkflowPageSchema)).items.map((item) => item.workflow))
        .toEqual(expect.arrayContaining([expected, sibling.workflow]))
      expect((await call(client, 'workflow_get', ManagedWorkflowSchema, scope)).workflow).toEqual(expected)
      expect((await call(client, 'workflow_get', ManagedWorkflowSchema, { ...scope, workflowId: siblingId })).workflow).toEqual(sibling.workflow)
      expect((await call(client, 'workflow_list', ManagedWorkflowPageSchema, { workspaceId: scope.workspaceId, limit: 100 })).items.map((item) => item.workflow))
        .toEqual(expect.arrayContaining([expected, sibling.workflow]))

      // Existing metadata commands retain the tag/entry/choice/kinds and exact replay.
      const renameInput = { ...scope, commandId: randomUUID(), expectedRevision: freshGet.revision, name: 'Renamed typed workflow' }
      const renamed = await fresh.update(owner.principal, 'http', renameInput)
      expect({ ...renamed.value.workflow, name: expected.name, updatedAt: expected.updatedAt }).toEqual(expected)
      expect((await fresh.update(owner.principal, 'http', renameInput)).replayed).toBe(true)
      await expect(fresh.update(owner.principal, 'http', { ...renameInput, commandId: randomUUID() })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
      await expect(fresh.update(owner.principal, 'http', { ...renameInput, name: 'Conflicting replay' })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
      expect((await call(client, 'workflow_get', ManagedWorkflowSchema, scope)).workflow).toEqual(renamed.value.workflow)
      const beforeDenied = (await db.pool.query<{ record: unknown; revision: string }>('select record,revision::text from workflows where id=$1', [scope.workflowId])).rows[0]!

      // Missing, wrong-scope and insufficient-grant principals cannot read it.
      for (const url of [workspacePath, productPath, managedPath, managedListPath]) {
        expect((await app.inject({ method: 'GET', url, headers: { host: 'localhost' } })).statusCode).toBe(401)
      }
      for (const grants of [
        [{ actions: ManagementActionSchema.options, scope: { workspaceIds: ['not-this-workspace'] } }],
        [{ actions: ['capabilities:read' as const], scope: { workspaceIds: [scope.workspaceId] } }],
      ]) {
        const outsider = await access.issue({ name: 'WR4-002 denied caller', audience: 'operator', grants, expiresAt: new Date(Date.now() + 600_000) })
        const outsiderClient = await connect(outsider.token)
        const outsiderCookie = await enroll(outsider.token)
        for (const url of [workspacePath, productPath, managedPath]) {
          expect((await app.inject({ method: 'GET', url, headers: { host: 'localhost', cookie: outsiderCookie } })).statusCode).toBe(403)
        }
        await denied(outsiderClient, 'workflow_get', scope)
        await denied(outsiderClient, 'workflow_list', { workspaceId: scope.workspaceId }, true)
      }
      // Revoke the exact previously successful principal, using its established
      // MCP transport and cookie again; cached authentication is not authority.
      await db.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [owner.principal.id])
      for (const url of [workspacePath, productPath, managedPath, managedListPath]) {
        expect((await app.inject({ method: 'GET', url, headers: { host: 'localhost', cookie } })).statusCode).toBe(401)
      }
      await denied(client, 'workflow_get', scope)
      await denied(client, 'workflow_list', { workspaceId: scope.workspaceId })
      expect((await db.pool.query<{ record: unknown; revision: string }>('select record,revision::text from workflows where id=$1', [scope.workflowId])).rows[0]!).toEqual(beforeDenied)
      expect((await db.pool.query<{ record: unknown }>('select record from workflows where id=$1', [siblingId])).rows[0]!.record).toEqual(sibling.workflow)
      expect((await db.pool.query('select 1 from runs where workspace_id=$1', [scope.workspaceId])).rowCount).toBe(0)
      expect(start).not.toHaveBeenCalled()
      expect(WAVE25_ADMISSION_ENABLED).toBe(false)
    }, 120000)
  }
})
