import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  ManagedWorkspaceCommandResultSchema, ManagedWorkspacePageSchema, ManagedWorkspaceSchema,
  WorkspaceArchiveInputSchema, WorkspaceBatchArchiveInputSchema, WorkspaceBatchArchiveResultSchema,
  WorkspaceCreateInputSchema, WorkspaceUpdateInputSchema,
} from '@foreman-code/contracts/management'
import { WorkspaceSummaryPageSchema } from '@foreman-code/contracts/operator-mcp'
import type { Scenario } from '../../scenario.js'
import { assertResponse } from '../../assertions.js'
import type { McpClient } from '../../clients/mcp.js'
import { assertInvalidCallerDenied, assertReadOnlyDenied, assertToolFailure,
  assertValue, callTool, mcpClaims, operatorClients } from './support.js'

export async function createMcpWorkspace(client: McpClient, name: string) {
  const input = WorkspaceCreateInputSchema.parse({ commandId: randomUUID(), name, description: 'Isolated MCP conformance workspace.' })
  const result = await callTool(client, 'workspace_create', input, ManagedWorkspaceCommandResultSchema)
  assertValue(result, { value: {
    workspace: { id: '<id>', name, description: input.description, createdAt: '<timestamp>', updatedAt: '<timestamp>' },
    revision: 1, archivedAt: null, executionLocation: null, locationRevision: 0, locationValidation: { status: 'restricted' },
  }, replayed: false }, [
    { pointer: '/body/value/workspace/id', kind: 'id' },
    { pointer: '/body/value/workspace/createdAt', kind: 'timestamp' },
    { pointer: '/body/value/workspace/updatedAt', kind: 'timestamp' },
  ])
  assert.equal(result.value.workspace.createdAt, result.value.workspace.updatedAt)
  assert.match(result.value.workspace.id, /^workspace-[0-9a-f-]{36}$/)
  return { input, result }
}

export const workspaceMcpScenarios: Scenario[] = [
  {
    id: 'mcp.workspaces.create-update', title: 'MCP workspace creation and update preserve revisions, receipts and public readback',
    lane: 'A2', authentication: 'operator', covers: mcpClaims('workspace_list', 'workspace_get', 'workspace_create', 'workspace_update'),
    async run(context) {
      const { operator, readOnly } = operatorClients(context)
      assertValue(await callTool(operator, 'workspace_list', {}, WorkspaceSummaryPageSchema), {
        detail: 'compact', items: [], pageInfo: { nextCursor: null },
      })
      const deniedCreate = WorkspaceCreateInputSchema.parse({ commandId: randomUUID(), name: 'Denied workspace' })
      await assertReadOnlyDenied(readOnly, 'workspace_create', deniedCreate)
      const { input, result } = await createMcpWorkspace(operator, 'MCP workspace')
      const workspaceId = result.value.workspace.id
      await assertInvalidCallerDenied(operator, 'workspace_list', {})
      await assertInvalidCallerDenied(operator, 'workspace_get', { workspaceId })
      const readable = { ...result.value, locationValidation: { status: 'unconfigured' as const } }
      assert.deepStrictEqual(await callTool(operator, 'workspace_get', { workspaceId }, ManagedWorkspaceSchema), readable)
      assertValue(await callTool(operator, 'workspace_list', {}, WorkspaceSummaryPageSchema), {
        detail: 'compact', items: [{ workspace: { id: workspaceId, name: input.name }, revision: 1, archivedAt: null,
          locationRevision: 0, locationStatus: 'unconfigured', detailsOmitted: true }], pageInfo: { nextCursor: null },
      })
      const update = WorkspaceUpdateInputSchema.parse({ commandId: randomUUID(), expectedRevision: 1,
        workspaceId, name: 'MCP workspace renamed', description: null })
      await assertReadOnlyDenied(readOnly, 'workspace_update', update)
      const changed = await callTool(operator, 'workspace_update', update, ManagedWorkspaceCommandResultSchema)
      assertValue(changed, { value: { ...readable, revision: 2,
        workspace: { id: workspaceId, name: update.name, createdAt: readable.workspace.createdAt, updatedAt: '<timestamp>' },
      }, replayed: false }, [{ pointer: '/body/value/workspace/updatedAt', kind: 'timestamp' }])
      assertToolFailure(await operator.callTool('workspace_update', { ...update, commandId: randomUUID() }), {
        code: 'REVISION_CONFLICT', message: 'The workspace changed since it was read.', details: { currentRevision: 2 },
      })
      await context.target.restart()
      assert.deepStrictEqual(await callTool(operator, 'workspace_create', input, ManagedWorkspaceCommandResultSchema),
        { ...result, replayed: true })
      assert.deepStrictEqual(await callTool(operator, 'workspace_update', update, ManagedWorkspaceCommandResultSchema),
        { ...changed, replayed: true })
      assert.deepStrictEqual(await callTool(operator, 'workspace_get', { workspaceId }, ManagedWorkspaceSchema), changed.value)
      assertValue(await callTool(operator, 'workspace_list', { detail: 'full' }, ManagedWorkspacePageSchema), {
        items: [changed.value], pageInfo: { nextCursor: null },
      })
      assertResponse(await context.http.request('GET', `/api/management/workspaces/${workspaceId}`),
        { status: 200, body: changed.value })
    },
  },
  {
    id: 'mcp.workspaces.archive', title: 'MCP workspace archive retains durable history and replays exactly once',
    lane: 'A2', authentication: 'operator', covers: mcpClaims('workspace_archive'),
    async run(context) {
      const { operator, readOnly } = operatorClients(context)
      const { result } = await createMcpWorkspace(operator, 'MCP archive workspace')
      const workspaceId = result.value.workspace.id
      const input = WorkspaceArchiveInputSchema.parse({ commandId: randomUUID(), workspaceId, expectedRevision: 1 })
      await assertReadOnlyDenied(readOnly, 'workspace_archive', input)
      const archived = await callTool(operator, 'workspace_archive', input, ManagedWorkspaceCommandResultSchema)
      assertValue(archived, { value: { ...result.value, revision: 2, archivedAt: '<timestamp>' }, replayed: false },
        [{ pointer: '/body/value/archivedAt', kind: 'timestamp' }])
      await context.target.restart()
      const readable = { ...archived.value, locationValidation: { status: 'unconfigured' } }
      assertValue(await callTool(operator, 'workspace_list', { detail: 'full' }, ManagedWorkspacePageSchema), {
        items: [], pageInfo: { nextCursor: null },
      })
      assertValue(await callTool(operator, 'workspace_list', { detail: 'full', includeArchived: true }, ManagedWorkspacePageSchema), {
        items: [readable], pageInfo: { nextCursor: null },
      })
      assertResponse(await context.http.request('GET', `/api/management/workspaces/${workspaceId}`), { status: 200, body: readable })
      assert.deepStrictEqual(await callTool(operator, 'workspace_archive', input, ManagedWorkspaceCommandResultSchema),
        { ...archived, replayed: true })
    },
  },
  {
    id: 'mcp.workspaces.batch-archive', title: 'MCP workspace batch archive persists every selected revision atomically',
    lane: 'A2', authentication: 'operator', covers: mcpClaims('workspace_batch_archive'),
    async run(context) {
      const { operator, readOnly } = operatorClients(context)
      const first = await createMcpWorkspace(operator, 'MCP batch first')
      const second = await createMcpWorkspace(operator, 'MCP batch second')
      const created = [first.result.value, second.result.value]
      const input = WorkspaceBatchArchiveInputSchema.parse({ commandId: randomUUID(),
        workspaces: created.map(value => ({ workspaceId: value.workspace.id, expectedRevision: 1 })) })
      await assertReadOnlyDenied(readOnly, 'workspace_batch_archive', input)
      const result = await callTool(operator, 'workspace_batch_archive', input, WorkspaceBatchArchiveResultSchema)
      assertValue(result, { value: { workspaceIds: created.map(value => value.workspace.id).sort() }, replayed: false })
      await context.target.restart()
      for (const before of created) {
        const response = await context.http.request('GET', `/api/management/workspaces/${before.workspace.id}`)
        assertResponse(response, { status: 200, body: { ...before, revision: 2, archivedAt: '<timestamp>',
          locationValidation: { status: 'unconfigured' },
        } }, [{ pointer: '/body/archivedAt', kind: 'timestamp' }])
      }
      assert.deepStrictEqual(await callTool(operator, 'workspace_batch_archive', input, WorkspaceBatchArchiveResultSchema),
        { ...result, replayed: true })
      assertValue(await callTool(operator, 'workspace_list', { detail: 'full' }, ManagedWorkspacePageSchema), {
        items: [], pageInfo: { nextCursor: null },
      })
    },
  },
]
