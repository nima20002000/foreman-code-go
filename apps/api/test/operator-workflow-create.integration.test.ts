import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult, WorkflowSummaryPageSchema } from '@foreman-code/contracts/operator-mcp'
import {
  CurrentWorkflowCreateInputSchema, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema,
  SavedManagedWorkflowCommandResultSchema, makeCurrentWorkflowFixture,
  type CurrentWorkflowCreateInput, type WorkflowDefinitionV3,
} from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'

function initialSave(graph: WorkflowDefinitionV3, configurations: Record<string, string>) {
  const { id, workspaceId, name, description, defaultWorktree, version, createdAt, updatedAt, ...definition } = graph
  void id
  void workspaceId
  void name
  void description
  void defaultWorktree
  void version
  void createdAt
  void updatedAt
  return { graph: definition, expectedAgentConfigurationVersionIds: configurations, expectedLocationRevision: 1 }
}

it.each(['single', 'repeat'] as const)('publishes an initial $form graph through the shared service', async (form) => {
  const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), form) })
  try {
    const workspaceId = f.f.scope.workspaceId
    const input = CurrentWorkflowCreateInputSchema.parse({
      workspaceId,
      commandId: randomUUID(),
      name: 'Shared service creation',
      defaultWorktree: null,
      initialSave: initialSave(f.f.version.definition, f.f.version.agentConfigurationVersionIds),
    })
    // Call the public service directly so failures retain their original exception and stack.
    const created = SavedManagedWorkflowCommandResultSchema.parse(
      await f.services.workflows.create(f.writer.principal, 'mcp', input),
    )
    expect(created.replayed).toBe(false)
    expect(created.value.revision).toBe(2)
    expect(created.value.currentVersionId).not.toBeNull()
    expect(created.value.workflow).not.toHaveProperty('description')
    expect(created.value.workflow).not.toHaveProperty('defaultWorktree')
    const read = CurrentWorkflowReadResultSchema.parse(await f.services.workflows.current.read(f.writer.principal, {
      workspaceId,
      workflowId: created.value.workflow.id,
    }))
    expect(read.currentVersionId).toBe(created.value.currentVersionId)
    expect(read.version.definition).toEqual(created.value.workflow)
    expect(read.version.agentConfigurationVersionIds).toEqual(input.initialSave!.expectedAgentConfigurationVersionIds)
    expect(SavedManagedWorkflowCommandResultSchema.parse(
      await f.services.workflows.create(f.writer.principal, 'mcp', input),
    )).toEqual({ ...created, replayed: true })
  } finally {
    await f.close()
  }
}, 120_000)

it.each([
  { form: 'single', description: 'Initial graph' },
  { form: 'repeat', description: 'Initial graph' },
  { form: 'single' },
  { form: 'repeat' },
] as const)('creates and replays a saved $form workflow (description: $description)', async (metadata) => {
  const { form } = metadata
  const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), form) })
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await f.client.callTool({ name, arguments: args })
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true)
    return decodeMcpToolResult(reply)
  }
  try {
    const workspaceId = f.f.scope.workspaceId
    const input = CurrentWorkflowCreateInputSchema.parse({
      workspaceId, commandId: randomUUID(), name: 'Saved at creation', defaultWorktree: null,
      ...('description' in metadata ? { description: metadata.description } : {}),
      initialSave: initialSave(f.f.version.definition, f.f.version.agentConfigurationVersionIds),
    })
    const catalog = await f.client.listTools()
    expect(catalog.tools.find(tool => tool.name === 'workflow_create')?.inputSchema.properties)
      .toHaveProperty('initialSave')
    const schema = await call('operator_tool_schema_get', { name: 'workflow_create' })
    expect(schema).toMatchObject({ permissionRequirements: {
      actions: expect.arrayContaining(['workflows:create']),
      detail: expect.stringContaining('graph:read/edit/save'),
    } })
    const capabilities = await call('operator_get_capabilities', {})
    expect(capabilities).toMatchObject({ runtimeLimits: expect.arrayContaining([
      expect.objectContaining({ feature: 'workflow_create_initial_save' }),
    ]) })
    const created = SavedManagedWorkflowCommandResultSchema.parse(await call('workflow_create', input))
    expect(created.replayed).toBe(false)
    expect(created.value.currentVersionId).not.toBeNull()
    expect(created.value.revision).toBe(2)
    const read = CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', {
      workspaceId, workflowId: created.value.workflow.id,
    }))
    expect(read.currentVersionId).toBe(created.value.currentVersionId)
    expect(read.version.definition).toEqual(created.value.workflow)
    expect(read.version.definition.name).toBe(input.name)
    expect(read.version.definition.description).toBe(input.description)
    if (!('description' in metadata)) expect(read.version.definition).not.toHaveProperty('description')
    expect(read.version.definition).not.toHaveProperty('defaultWorktree')
    expect(read.version.agentConfigurationVersionIds).toEqual(input.initialSave!.expectedAgentConfigurationVersionIds)
    expect(read.version.definition.repeat).toEqual(input.initialSave!.graph.repeat)
    expect(read.version.definition).not.toHaveProperty('handoffs')
    expect(SavedManagedWorkflowCommandResultSchema.parse(await call('workflow_create', input)))
      .toEqual({ ...created, replayed: true })

    const saved = CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', {
      workspaceId, workflowId: created.value.workflow.id, commandId: randomUUID(), executionSemanticsVersion: 3,
      expectedRevision: read.revision, expectedWorkflowVersionId: read.currentVersionId,
      expectedLocationRevision: 1, expectedAgentConfigurationVersionIds: read.version.agentConfigurationVersionIds,
      graph: { ...read.version.definition, description: 'Edited after creation' },
    }))
    expect(saved.value.revision).toBe(read.revision + 1)
    expect(SavedManagedWorkflowCommandResultSchema.parse(await call('workflow_create', input)))
      .toEqual({ ...created, replayed: true })
    const persisted = CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', {
      workspaceId, workflowId: created.value.workflow.id,
    }))
    expect(persisted.version).toEqual(saved.value.version)
    const conflict = await f.client.callTool({ name: 'workflow_create', arguments: { ...input, name: 'Changed retry' } })
    expect(conflict.isError).toBe(true)
    expect(decodeMcpToolResult(conflict)).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } })
    const audits = await f.db.pool.query<{ action: string; outcome: string }>(
      'select action,outcome from management_audit where principal_id=$1 and target_key=any($2::text[])',
      [f.writer.principal.id, [`workspace:${workspaceId}:workflows:new`, `workflow:${created.value.workflow.id}:definition`]],
    )
    expect(audits.rows.filter(row => row.action === 'workflow.create' && row.outcome === 'succeeded')).toHaveLength(1)
    expect(audits.rows.filter(row => row.action === 'workflow.save.v3' && row.outcome === 'succeeded')).toHaveLength(2)
    expect(audits.rows).toEqual(expect.arrayContaining([
      { action: 'workflow.create', outcome: 'succeeded' },
      { action: 'workflow.save.v3', outcome: 'succeeded' },
    ]))
  } finally { await f.close() }
}, 120_000)

it('leaves no empty workflow after validation or stale-pin failures and accepts a corrected retry', async () => {
  const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single') })
  try {
    const workspaceId = f.f.scope.workspaceId
    const input: CurrentWorkflowCreateInput = {
      workspaceId, commandId: randomUUID(), name: 'Atomic validation', defaultWorktree: null,
      initialSave: initialSave(f.f.version.definition, f.f.version.agentConfigurationVersionIds),
    }
    const list = async () => {
      const reply = await f.client.callTool({ name: 'workflow_list', arguments: { workspaceId, limit: 100 } })
      expect(reply.isError).not.toBe(true)
      return WorkflowSummaryPageSchema.parse(decodeMcpToolResult(reply))
    }
    const before = await list()
    for (const [save, code] of [
      [{ ...input.initialSave!, graph: { ...input.initialSave!.graph, entryNodeId: 'missing-node' } }, 'GRAPH_INVALID'],
      [{ ...input.initialSave!, expectedLocationRevision: 99 }, 'LOCATION_REVISION_CONFLICT'],
      [{ ...input.initialSave!, expectedAgentConfigurationVersionIds: {} }, 'AGENT_CONFIGURATION_CONFLICT'],
    ] as const) {
      const rejected = await f.client.callTool({ name: 'workflow_create', arguments: { ...input, initialSave: save } })
      expect(rejected.isError).toBe(true)
      expect(decodeMcpToolResult(rejected)).toMatchObject({ error: { code } })
      expect(await list()).toEqual(before)
    }
    // A failed create has no receipt, so its corrected input can use the same command ID.
    const response = await f.client.callTool({ name: 'workflow_create', arguments: input })
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    const created = SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(response))
    expect(created.replayed).toBe(false)
    expect((await list()).items.map(item => item.workflow.id)).toContain(created.value.workflow.id)
    const read = await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
      workspaceId, workflowId: created.value.workflow.id,
    } })
    expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(read)).version.definition)
      .toEqual(created.value.workflow)
  } finally { await f.close() }
}, 120_000)

it('requires save grants for initial graphs while preserving metadata-only creation and HTTP parity', async () => {
  const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single') })
  try {
    const workspaceId = f.f.scope.workspaceId
    const input = {
      workspaceId, commandId: randomUUID(), name: 'Protected creation', defaultWorktree: null,
      initialSave: initialSave(f.f.version.definition, f.f.version.agentConfigurationVersionIds),
    }
    const issue = (actions: Array<(typeof ManagementActionSchema.options)[number]>) => f.access.issue({
      name: 'Restricted creator', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions, scope: { workspaceIds: [workspaceId] } }],
    })
    const createOnly = await issue(['workflows:create'])
    const reader = await issue(['workflows:read', 'graph:read'])
    for (const token of [createOnly.token, reader.token]) {
      const client = await f.connect(token)
      const denied = await client.callTool({ name: 'workflow_create', arguments: input })
      expect(denied.isError).toBe(true)
      expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    }
    const createClient = await f.connect(createOnly.token)
    const empty = await createClient.callTool({ name: 'workflow_create', arguments: {
      workspaceId, commandId: randomUUID(), name: 'Intentionally unsaved', defaultWorktree: null,
    } })
    expect(empty.isError).not.toBe(true)
    expect(SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(empty)).value.currentVersionId).toBeNull()
    const scoped = await f.access.issue({ name: 'Other workflow only', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [
        { actions: ['workflows:create'], scope: { workspaceIds: [workspaceId] } },
        { actions: ManagementActionSchema.options, scope: { workspaceIds: [workspaceId], workflowIds: [f.f.scope.workflowId] } },
      ] })
    const scopedClient = await f.connect(scoped.token)
    const deniedScope = await scopedClient.callTool({ name: 'workflow_create', arguments: input })
    expect(decodeMcpToolResult(deniedScope)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    const list = await f.client.callTool({ name: 'workflow_list', arguments: { workspaceId, limit: 100 } })
    expect(WorkflowSummaryPageSchema.parse(decodeMcpToolResult(list)).items.some(item => item.workflow.name === input.name))
      .toBe(false)

    const http = await f.app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/workflows`,
      headers: { authorization: `Bearer ${f.writer.token}` }, payload: input,
    })
    expect(http.statusCode, http.body).toBe(201)
    const created = SavedManagedWorkflowCommandResultSchema.parse(http.json())
    expect(created.value.workflow).not.toHaveProperty('description')
    expect(created.value.workflow).not.toHaveProperty('defaultWorktree')
    const read = await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
      workspaceId, workflowId: created.value.workflow.id,
    } })
    expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(read)).version.definition)
      .toEqual(created.value.workflow)
    const replay = await f.client.callTool({ name: 'workflow_create', arguments: input })
    expect(SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(replay)))
      .toEqual({ ...created, replayed: true })
    const deniedReplay = await createClient.callTool({ name: 'workflow_create', arguments: input })
    expect(decodeMcpToolResult(deniedReplay)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    const deniedHttp = await f.app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/workflows`,
      headers: { authorization: `Bearer ${createOnly.token}` }, payload: { ...input, commandId: randomUUID() },
    })
    expect(deniedHttp.statusCode).toBe(403)
  } finally { await f.close() }
}, 120_000)
