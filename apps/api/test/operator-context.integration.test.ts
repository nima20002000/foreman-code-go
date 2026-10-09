import { randomUUID } from 'node:crypto'
import {
  decodeMcpToolResult, OperatorCompactCapabilitiesSchema, OperatorToolSchemaResultSchema,
  WorkspaceSummaryPageSchema, WorkflowSummaryPageSchema,
} from '@foreman-code/contracts/operator-mcp'
import { ManagedWorkspacePageSchema, ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { SavedManagedWorkflowPageSchema, SavedManagedWorkflowSchema } from '@foreman-code/contracts/wave25'
import { describe, expect, it } from 'vitest'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('Operator context over authenticated MCP', () => {
  it('looks up available schemas without prior discovery, rejects denied targets and audits denied callers', async () => {
    const f = await currentOperatorIntegration()
    try {
      const lookup = async (name: string, includeOutputSchema = false) => {
        const result = await f.client.callTool({ name: 'operator_tool_schema_get', arguments: { name, includeOutputSchema } })
        expect(result.isError).not.toBe(true)
        expect(result.structuredContent).toBeUndefined()
        return OperatorToolSchemaResultSchema.parse(decodeMcpToolResult(result))
      }
      const input = await lookup('workspace_update')
      expect(input).not.toHaveProperty('outputSchema')
      expect(input.inputSchema.required).toEqual(expect.arrayContaining(['commandId', 'expectedRevision', 'workspaceId']))
      expect(input.permissionRequirements.actions).toContain('workspaces:update')
      expect((await lookup('workspace_update', true)).outputSchema).toBeDefined()
      expect((await f.client.listTools()).tools.every((tool) => tool.outputSchema === undefined)).toBe(true)

      const issued = await f.access.issue({ name: 'Schema reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['capabilities:read'], scope: {} }] })
      const reader = await f.connect(issued.token)
      const denied = await reader.callTool({ name: 'operator_tool_schema_get', arguments: { name: 'workspace_update' } })
      expect(denied.isError).toBe(true)
      expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      expect(denied).not.toHaveProperty('structuredContent')
      const noGrant = await f.access.issue({ name: 'No capability grant', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workspaces:read'], scope: {} }] })
      const restricted = await f.connect(noGrant.token)
      expect((await restricted.callTool({ name: 'operator_tool_schema_get', arguments: { name: 'workspace_get' } })).isError)
        .toBe(true)
      for (const principalId of [issued.principal.id, noGrant.principal.id]) {
        const audit = await f.db.pool.query('select sequence from management_audit where principal_id=$1', [principalId])
        expect(audit.rowCount).toBeGreaterThan(0)
      }
      const compact = OperatorCompactCapabilitiesSchema.parse(decodeMcpToolResult(
        await reader.callTool({ name: 'operator_get_capabilities', arguments: {} }),
      ))
      expect(compact.tools).toContain('operator_tool_schema_get')
      expect(compact.tools).not.toContain('workspace_update')
      expect(compact.grants).toEqual(issued.principal.grants)
      expect(compact.runtimeLimits).toEqual(expect.arrayContaining([
        expect.objectContaining({ feature: 'native_mcp_provisioning', detail: expect.stringContaining('human') }),
        expect.objectContaining({ feature: 'trusted_device_owner_approval', detail: expect.stringContaining('human-only') }),
      ]))
    } finally { await f.close() }
  }, 60000)

  it('pages compact persisted workspaces and workflows and returns complete explicit full records', async () => {
    const f = await currentOperatorIntegration()
    try {
      const ids: string[] = []
      for (let index = 0; index < 11; index++) {
        const created = decodeMcpToolResult(await f.client.callTool({ name: 'workspace_create', arguments: {
          commandId: randomUUID(), name: `Context workspace ${index}`, description: 'Persisted workspace description',
        } }))
        ids.push(ManagedWorkspaceSchema.parse(created.value).workspace.id)
      }
      const first = WorkspaceSummaryPageSchema.parse(decodeMcpToolResult(
        await f.client.callTool({ name: 'workspace_list', arguments: {} }),
      ))
      expect(first.items).toHaveLength(10)
      expect(first.pageInfo.nextCursor).not.toBeNull()
      expect(first.items.every((item) => item.detailsOmitted && item.revision === 1)).toBe(true)
      const second = WorkspaceSummaryPageSchema.parse(decodeMcpToolResult(await f.client.callTool({
        name: 'workspace_list', arguments: { cursor: first.pageInfo.nextCursor, limit: 100 },
      })))
      const listed = [...first.items, ...second.items].map((item) => item.workspace.id)
      expect(new Set(listed).size).toBe(listed.length)
      expect(listed).toEqual(expect.arrayContaining(ids))
      const full = ManagedWorkspacePageSchema.parse(decodeMcpToolResult(await f.client.callTool({
        name: 'workspace_list', arguments: { limit: 100, detail: 'full' },
      })))
      expect(full.items.find((item) => item.workspace.id === ids[0])?.workspace.description)
        .toBe('Persisted workspace description')
      const persisted = await f.services.workspaces.get(f.writer.principal, ids[0]!)
      expect(full.items.find((item) => item.workspace.id === ids[0])).toEqual(persisted)

      const workflow = decodeMcpToolResult(await f.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId: ids[0], commandId: randomUUID(), name: 'Context workflow', description: 'Persisted workflow description',
      } }))
      const saved = SavedManagedWorkflowSchema.parse(workflow.value)
      const summary = WorkflowSummaryPageSchema.parse(decodeMcpToolResult(await f.client.callTool({
        name: 'workflow_list', arguments: { workspaceId: ids[0] },
      })))
      expect(summary.items).toEqual([{ workflow: {
        id: saved.workflow.id, workspaceId: ids[0], name: 'Context workflow',
      }, revision: saved.revision, currentVersionId: saved.currentVersionId,
      archivedAt: null, detailsOmitted: true }])
      const workflows = SavedManagedWorkflowPageSchema.parse(decodeMcpToolResult(await f.client.callTool({
        name: 'workflow_list', arguments: { workspaceId: ids[0], detail: 'full' },
      })))
      expect(workflows.items).toEqual([saved])
      expect((await f.client.callTool({ name: 'workspace_list', arguments: { limit: 101 } })).isError).toBe(true)
    } finally { await f.close() }
  }, 60000)
})
