import { randomUUID } from 'node:crypto'
import * as contracts from '@foreman-code/contracts/management'
import { describe, expect, it } from 'vitest'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { callWorkspaceTool, workspaceMcpFixture } from './helpers/workspaceMcp.js'

describe('repository settings through authenticated MCP', () => {
  it('persists edits and removals, replays retries, and rejects stale or denied writes', async () => {
    const f = await workspaceMcpFixture()
    try {
      const created = await callWorkspaceTool(f.owner.client, 'workspace_create',
        contracts.ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Repository settings' })
      const workspaceId = created.value.workspace.id
      const repository = { provider: 'github', owner: 'octo-owner', name: 'website', defaultBranch: 'main' }
      const input = { workspaceId, commandId: randomUUID(), expectedRevision: created.value.revision, repository }
      const saved = await callWorkspaceTool(f.owner.client, 'workspace_update',
        contracts.ManagedWorkspaceCommandResultSchema, input)
      const read = () => callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema, { workspaceId })
      expect((await read()).workspace.repository).toEqual(repository)
      expect(await callWorkspaceTool(f.owner.client, 'workspace_update',
        contracts.ManagedWorkspaceCommandResultSchema, input)).toEqual({ ...saved, replayed: true })
      expect((await read()).revision).toBe(saved.value.revision)

      const reader = await f.issue([{ actions: ['workspaces:read'], scope: { workspaceIds: [workspaceId] } }])
      await expectMcpAccessDenied(reader.client.callTool({ name: 'workspace_update', arguments: {
        workspaceId, commandId: randomUUID(), expectedRevision: saved.value.revision, repository: null,
      } }))
      expect((await read()).workspace.repository).toEqual(repository)

      const changed = { ...repository, defaultBranch: 'release' }
      expect(await f.owner.client.callTool({ name: 'workspace_update', arguments: {
        ...input, commandId: randomUUID(), repository: changed,
      } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('REVISION_CONFLICT') }] })
      expect((await read()).workspace.repository).toEqual(repository)
      const updated = await callWorkspaceTool(f.owner.client, 'workspace_update',
        contracts.ManagedWorkspaceCommandResultSchema, {
          workspaceId, commandId: randomUUID(), expectedRevision: saved.value.revision, repository: changed,
        })
      expect((await read()).workspace.repository).toEqual(changed)
      await callWorkspaceTool(f.owner.client, 'workspace_update', contracts.ManagedWorkspaceCommandResultSchema, {
        workspaceId, commandId: randomUUID(), expectedRevision: updated.value.revision, repository: null,
      })
      expect((await read()).workspace.repository).toBeUndefined()
    } finally {
      await f.close()
    }
  }, 30_000)
})
