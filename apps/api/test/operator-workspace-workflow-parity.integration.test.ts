import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { z } from 'zod'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import * as c from '@graphql/contracts/management'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { HarnessDirectoryBrowser } from '../src/modules/harnesses/directoryBrowser.js'
import { GraphDraftService } from '../src/modules/graph-drafts/service.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

it('provides authenticated Operator MCP parity for creation, defaults and workspace/workflow settings', async () => {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'
  const schema = 'mcp_parity_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString })
  const parentPath = await mkdtemp(join(tmpdir(), 'mcp-parity-'))
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  const clients: Client[] = []
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const locations = new WorkspaceLocationService(pool, commands, undefined, 'runner-local', parentPath)
  const settings = new FoundationSettingsManagementService(new PostgresFoundationSettingsRepository(pool, parentPath), commands)
  const services = {
    harnessSettings: { directories: new HarnessDirectoryBrowser([parentPath], pool), mcp: {} },
    commands, locations, settings, workspaces: new WorkspaceManagementService(pool, commands, locations),
    workflows: new WorkflowManagementService(pool, commands), drafts: new GraphDraftService(pool, commands),
  } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: {
    database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
  }, operator: { access, services } })
  try {
    await applyApplicationMigrations(pool)
    const owner = await access.issue({ name: 'Parity owner', audience: 'operator',
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    // Match the native Operator's delegated credential, not just an owner browser token.
    const delegated = await access.issue({ name: 'Parity Operator', audience: 'operator',
      grants: owner.principal.grants, expiresAt: new Date(Date.now() + 120_000) })
    await pool.query('update management_principals set delegated_from=$2 where id=$1', [delegated.principal.id, owner.principal.id])
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'parity-test', version: '1.0.0' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(delegated.token)
    async function call<T>(name: string, schema: z.ZodType<T>, args: Record<string, unknown> = {}) {
      const response = await client.callTool({ name, arguments: args })
      expect(response.isError, JSON.stringify(response)).not.toBe(true)
      return schema.parse(response.structuredContent)
    }
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name)
    expect(toolNames).toEqual(expect.arrayContaining(['workspace_create', 'workspace_update', 'workspace_defaults_update', 'workspace_location_set', 'workflow_create', 'workflow_update', 'workflow_defaults_update', 'graph_draft_apply', 'graph_save']))
    const defaults = await call('workspace_defaults_get', c.ManagedWorkspaceDefaultsSchema)
    await call('workspace_defaults_update', c.WorkspaceDefaultsUpdateResultSchema, {
      commandId: randomUUID(), expectedRevision: defaults.revision, value: { ...defaults.value, parentPath },
    })
    const savedDefaults = await call('workspace_defaults_get', c.ManagedWorkspaceDefaultsSchema)
    expect(savedDefaults.value.parentPath).toBe(parentPath)
    const create = { commandId: randomUUID(), name: 'MCP Project', parentPath: savedDefaults.value.parentPath }
    const workspace = (await call('workspace_create', c.ManagedWorkspaceCommandResultSchema, create)).value
    const workspaceId = workspace.workspace.id
    expect(workspace.executionLocation?.rootPath).toBe(join(parentPath, 'MCP Project'))
    expect(workspace.locationValidation.status).toBe('ready')
    const outside = await client.callTool({ name: 'workspace_location_set', arguments: {
      workspaceId, commandId: randomUUID(), expectedLocationRevision: workspace.locationRevision,
      runnerId: 'runner-local', rootPath: tmpdir(),
    } })
    expect(outside.isError).toBe(true)
    const outsideDefault = await client.callTool({ name: 'workspace_defaults_update', arguments: {
      commandId: randomUUID(), expectedRevision: savedDefaults.revision,
      value: { ...savedDefaults.value, parentPath: tmpdir() },
    } })
    expect(outsideDefault.isError).toBe(true)

    const overview = await call('workspace_list', c.ManagedWorkspacePageSchema, {})
    expect(overview.items.find((item) => item.workspace.id === workspaceId)?.executionLocation).toEqual(workspace.executionLocation)
    const reader = await access.issue({ name: 'Metadata only', audience: 'operator',
      grants: [{ actions: ['workspaces:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const readerClient = await connect(reader.token)
    const restrictedList = c.ManagedWorkspacePageSchema.parse((await readerClient.callTool({ name: 'workspace_list', arguments: {} })).structuredContent)
    expect(restrictedList.items[0]?.locationValidation.status).toBe('restricted')
    expect(restrictedList.items[0]?.executionLocation).toBeNull()
    expect((await call('workspace_create', c.ManagedWorkspaceCommandResultSchema, create)).replayed).toBe(true)
    expect(await readdir(parentPath)).toEqual(['MCP Project'])
    const listed = await call('workspace_folders_list', c.HarnessDirectoryBrowseResultSchema)
    expect(listed.path).toBe(parentPath)
    const folderInput = { parentPath, name: 'Picker folder', commandId: randomUUID() }
    const folder = await call('workspace_folder_create', c.WorkspaceFolderCreateResultSchema, folderInput)
    expect(folder.value.path).toBe(join(parentPath, 'Picker folder'))
    expect((await call('workspace_folder_create', c.WorkspaceFolderCreateResultSchema, folderInput)).replayed).toBe(true)
    expect((await client.callTool({ name: 'workspace_folder_create', arguments: { ...folderInput, commandId: randomUUID() } })).isError).toBe(true)
    expect((await client.callTool({ name: 'workspace_folder_create', arguments: { ...folderInput, parentPath: tmpdir(), commandId: randomUUID() } })).isError).toBe(true)
    expect((await client.callTool({ name: 'workspace_folder_create', arguments: { ...folderInput, name: '../escape', commandId: randomUUID() } })).isError).toBe(true)
    expect((await call('workspace_folders_list', c.HarnessDirectoryBrowseResultSchema)).directories.map((entry) => entry.name)).toContain('Picker folder')
    await call('workspace_update', c.ManagedWorkspaceCommandResultSchema, { workspaceId, commandId: randomUUID(), expectedRevision: workspace.revision, name: 'Renamed project' })
    expect((await call('workspace_get', c.ManagedWorkspaceSchema, { workspaceId })).workspace.name).toBe('Renamed project')
    const alternate = join(parentPath, 'alternate'); await mkdir(alternate)
    await call('workspace_location_set', c.WorkspaceLocationSetResultSchema, {
      workspaceId, commandId: randomUUID(), expectedLocationRevision: workspace.locationRevision, runnerId: 'runner-local', rootPath: alternate,
    })
    expect((await call('workspace_get', c.ManagedWorkspaceSchema, { workspaceId })).executionLocation?.rootPath).toBe(alternate)
    const workflowDefaults = await call('workflow_defaults_get', c.ManagedWorkflowDefaultsSchema)
    await call('workflow_defaults_update', c.WorkflowDefaultsUpdateResultSchema, { commandId: randomUUID(), expectedRevision: workflowDefaults.revision, value: { approvalHandler: 'user' } })
    const workflow = (await call('workflow_create', c.ManagedWorkflowCommandResultSchema, { workspaceId, commandId: randomUUID(), name: 'MCP Workflow' })).value
    const workflowId = workflow.workflow.id
    expect(workflow.workflow.approval?.handler).toBe('user')
    await call('workflow_update', c.ManagedWorkflowCommandResultSchema, { workspaceId, workflowId, commandId: randomUUID(), expectedRevision: workflow.revision, name: 'Renamed workflow' })
    const draft = await call('graph_draft_open', c.GraphDraftSchema, { workspaceId, workflowId })
    const applied = await call('graph_draft_apply', c.GraphDraftCommandResultSchema, {
      workspaceId, workflowId, draftId: draft.id, expectedRevision: draft.revision, commandId: randomUUID(),
      operations: [
        { type: 'agent.add_from_template', template: 'coder', agentId: 'parity-agent', nodeId: 'parity-node', name: 'Coder' },
        { type: 'workflow.set_approval', approval: { handler: 'user' } },
        { type: 'workflow.set_required_agent_count', requiredAgentCount: 1 },
        { type: 'workflow.set_execution_condition', executionCondition: { kind: 'manual', description: 'Operator managed' } },
        { type: 'workflow.set_execution_limits', maxParallelism: 1, maxNodeExecutions: 5 },
      ],
    })
    await call('graph_save', c.GraphSaveCommandResultSchema, { workspaceId, workflowId, draftId: draft.id, expectedRevision: applied.value.draft.revision, commandId: randomUUID() })
    const readback = await call('workflow_get', c.ManagedWorkflowSchema, { workspaceId, workflowId })
    expect(readback.workflow.name).toBe('Renamed workflow')
    expect(readback.workflow.executionPolicy?.maxNodeExecutions).toBe(5)
    expect(readback.workflow.requiredAgentCount).toBe(1)
    expect(readback.workflow.executionCondition.description).toBe('Operator managed')
    const restricted = await access.issue({ name: 'No provisioning', audience: 'operator',
      grants: [{ actions: ['workspaces:create'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const limited = await connect(restricted.token)
    expect((await limited.listTools()).tools.map((tool) => tool.name)).not.toContain('workspace_folder_create')
    const denied = await limited.callTool({ name: 'workspace_create', arguments: { ...create, name: 'Denied', commandId: randomUUID() } })
    expect(denied.isError).toBe(true)
    expect(await readdir(parentPath)).not.toContain('Denied')
    await expect(limited.callTool({ name: 'workflow_create', arguments: { workspaceId, commandId: randomUUID(), name: 'Denied workflow' } })).rejects.toThrow('not found')
    expect((await pool.query("select count(*)::int as count from management_audit where source='mcp' and outcome='succeeded'")).rows[0].count).toBeGreaterThan(5)
  } finally {
    await Promise.all(clients.map((client) => client.close()))
    await app.close(); await pool.end()
    await admin.query(`drop schema "${schema}" cascade`); await admin.end()
    await rm(parentPath, { recursive: true, force: true })
  }
}, 30_000)
