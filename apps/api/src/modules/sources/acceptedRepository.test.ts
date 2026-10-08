import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { agentWorktree } from './service.js'
import { createSourceManifest } from './manifest.js'

it.each(['another repository', 'removed repository'])('uses the approved repository after the workspace has %s', async change => {
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip',
    git: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1', repository: 'original/site' },
    entries: [], deletions: [] })
  const sql = { query: async () => ({ rows: [{ workflow_name: 'Website', agent_name: 'Coder', run_id: 'run-accepted',
    workspace: { id: 'workspace-one', name: 'Site', ...(change === 'another repository'
      ? { repository: { provider: 'github', owner: 'other', name: 'site', defaultBranch: 'main' } } : {}) } }] }) } as unknown as GraphSqlClient
  expect(await agentWorktree(sql, 'execution-one', manifest)).toMatchObject({ repository: 'original/site' })
})

it('keeps the accepted shared-copy behavior when a repository is configured after source approval', async () => {
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip',
    git: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1' }, entries: [], deletions: [] })
  const sql = { query: async () => ({ rows: [{ workflow_name: 'Website', agent_name: 'Coder', run_id: 'run-accepted',
    workspace: { id: 'workspace-one', name: 'Site',
      repository: { provider: 'github', owner: 'other', name: 'site', defaultBranch: 'main' } } }] }) } as unknown as GraphSqlClient
  expect(await agentWorktree(sql, 'execution-one', manifest)).toBeUndefined()
})
