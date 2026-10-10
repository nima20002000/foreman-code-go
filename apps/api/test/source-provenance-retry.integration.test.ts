import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ManagedWorkspaceCommandResultSchema, ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { ApprovedSourceSchema } from '@foreman-code/contracts/source-admission'
import { expect, it, vi } from 'vitest'
import { CiService } from '../src/modules/jobs/ci.js'
import { RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import type { JobService } from '../src/modules/jobs/service.js'
import type { RegisteredSourceRootPort } from '../src/modules/sources/admissionPorts.js'
import { PostgresSourceService, type SourceExecutionHostPort } from '../src/modules/sources/service.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import { systemGitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { callWorkspaceTool, workspaceMcpFixture } from './helpers/workspaceMcp.js'

it('rejects interrupted CI capture replay after a supported repository edit through authenticated MCP', async () => {
  const enqueue = vi.fn()
  let sources!: PostgresSourceService
  const approvals: unknown[] = []
  let commit = ''
  const f = await workspaceMcpFixture({ configure: async ({ pool, commands, parentPath, services }) => {
    const mainId = (await pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const clone = join(parentPath, 'source-clone')
    await mkdir(clone)
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: clone, encoding: 'utf8', env: gitFixtureEnvironment(),
    }).trim()
    git('init', '-q', '-b', 'main')
    await writeFile(join(clone, 'README.md'), 'Accepted source\n')
    git('add', '.')
    git('commit', '-qm', 'Source')
    commit = git('rev-parse', 'HEAD')
    sources = new PostgresSourceService(pool, commands, services.locations!,
      new PrivateSourceSnapshotStore(join(parentPath, 'source-storage')), mainId,
      {} as RegisteredSourceRootPort, {} as SourceExecutionHostPort, { confirmedClosed: async () => false })
    // Both repositories already contain this commit; provenance must still prevent substitution.
    sources.git = { ...systemGitWorktreePorts(gitFixtureEnvironment()), cloneDirectory: () => clone }
    services.sources = sources
    vi.spyOn(sources, 'approve').mockImplementation(async (...args) => {
      approvals.push(args)
      throw new Error('Interrupted before approval')
    })
    services.ci = new CiService(pool, commands, new RunCiAuthority(pool), sources, { enqueue } as unknown as JobService)
  } })
  try {
    const created = await callWorkspaceTool(f.owner.client, 'workspace_create', ManagedWorkspaceCommandResultSchema,
      { commandId: randomUUID(), name: 'CI provenance' })
    const workspaceId = created.value.workspace.id
    expect(created.value.locationRevision).toBe(0)
    const repository = { provider: 'github', owner: 'octo-owner', name: 'repo-a', defaultBranch: 'main' }
    const saved = await callWorkspaceTool(f.owner.client, 'workspace_update', ManagedWorkspaceCommandResultSchema,
      { workspaceId, commandId: randomUUID(), expectedRevision: created.value.revision, repository })
    const input = { workspaceId, commandId: randomUUID(), commit, suite: 'unit' }
    const reader = await f.issue([{ actions: ['workspaces:read'], scope: { workspaceIds: [workspaceId] } }])
    expect((await reader.client.callTool({ name: 'ci_run', arguments: input })).isError).toBe(true)
    expect(approvals).toHaveLength(0)
    expect((await f.owner.client.callTool({ name: 'ci_run', arguments: input })).isError).toBe(true)
    expect(approvals).toHaveLength(1)
    const receipts = await f.pool.query<{ result: { commit: string; expectedLocationRevision: number } }>(
      "select result from management_command_receipts where operation='source.project.capture'")
    expect(receipts.rows.map(row => row.result.commit)).toEqual([commit])
    expect(receipts.rows.map(row => row.result.expectedLocationRevision)).toEqual([0])
    await callWorkspaceTool(f.owner.client, 'workspace_update', ManagedWorkspaceCommandResultSchema,
      { workspaceId, commandId: randomUUID(), expectedRevision: saved.value.revision,
        repository: { ...repository, name: 'repo-b' } })
    const persisted = await callWorkspaceTool(f.owner.client, 'workspace_get', ManagedWorkspaceSchema, { workspaceId })
    expect(persisted.workspace.repository?.name).toBe('repo-b')
    expect(persisted.locationRevision).toBe(saved.value.locationRevision)
    const retried = await f.owner.client.callTool({ name: 'ci_run', arguments: input })
    expect(retried.isError).toBe(true)
    expect(JSON.stringify(retried)).toContain('COMMAND_ID_CONFLICT')
    expect(approvals).toHaveLength(1)
    expect(enqueue).not.toHaveBeenCalled()
    vi.mocked(sources.approve).mockRestore()
    const approved = await sources.approveProject(f.owner.principal, {
      workspaceId, commandId: randomUUID(), commit,
    })
    expect(approved.locationRevision).toBe(0)
    expect(await callWorkspaceTool(f.owner.client, 'source_get', ApprovedSourceSchema, {
      workspaceId, approvedSourceId: approved.manifest.approvedSourceId,
      snapshotId: approved.manifest.snapshotId, manifestDigest: approved.manifest.manifestDigest,
    })).toEqual(approved)
  } finally {
    vi.restoreAllMocks()
    await f.close()
  }
}, 30_000)
