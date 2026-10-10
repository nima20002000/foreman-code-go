import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApprovedSourceSchema } from '@foreman-code/contracts/source-admission'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import { releaseUnusedSourceSnapshots } from '../src/modules/sources/snapshotRetention.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { mixedComputerPlacement } from './helpers/mixedComputerPlacement.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

async function fixture() {
  const base = await currentOperatorIntegration()
  const directory = await privateFixtureDirectory('workflow-retention-')
  try {
    const placement = await mixedComputerPlacement(base, directory, { sourceAccessMode: 'exclusive-write',
      git: { commit: 'b'.repeat(40), tree: 'c'.repeat(40), objectFormat: 'sha1', repository: 'octo/site' } })
    const repository = { provider: 'github' as const, owner: 'octo', name: 'site', defaultBranch: 'main' }
    const workspace = (await base.db.pool.query<{ revision: string }>(
      'select revision from workspaces where id=$1', [base.f.scope.workspaceId])).rows[0]!
    const configured = await base.services.workspaces.update(base.writer.principal, 'http', {
      workspaceId: base.f.scope.workspaceId, commandId: randomUUID(), expectedRevision: Number(workspace.revision), repository,
    })
    base.services.workflows = new WorkflowManagementService(base.db.pool, base.commands, {
      worktrees: { readyRoot: async () => undefined, sources: placement.sources, roots: placement.policies },
    })
    const input = await base.create()
    input.expectedLocationRevision = placement.locationRevision
    const source = await placement.sources.get(base.writer.principal, 'http', {
      workspaceId: input.workspaceId, ...placement.source,
    })
    const canonical = join(directory, 'snapshots')
    await mkdir(canonical, { mode: 0o700 })
    const store = new PrivateSourceSnapshotStore(canonical)
    await store.write(source.manifest.snapshotId, source.manifest.entries[0]!, Buffer.from('export const approved = true\n'))
    await store.commit(source.manifest)
    const scopeId = randomUUID()
    const reservation = await placement.sources.reservations.reserve(base.db.pool, {
      scopeId, ownerKind: 'capture', ownerId: source.manifest.snapshotId, reservedBytes: 16 * 1024,
    })
    await placement.sources.reservations.retain(base.db.pool, reservation, 'retained')
    const release = () => releaseUnusedSourceSnapshots(base.db.pool, store, scopeId, undefined, true)
    const read = () => placement.sources.get(base.writer.principal, 'http', {
      workspaceId: input.workspaceId, ...placement.source,
    })
    return { base, placement, source, store, input, configured, repository, release, read,
      async close() { await base.close(); await rm(directory, { recursive: true, force: true }) } }
  } catch (error) {
    await base.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

describe.skipIf(!postgresEnabled)('current workspace and workflow source retention', () => {
  it.each(['default', 'node override'] as const)('retains a current %s and releases bytes after replacement', async selection => {
    const f = await fixture()
    try {
      if (selection === 'default') {
        f.input.graph.defaultWorktree = { rootBinding: f.placement.local.rootBinding! }
      } else agentWorkflowNode(f.input.graph.nodes[0]).placement = f.placement.local
      const saved = (await f.base.services.workflows.current.save(f.base.writer.principal, 'http', f.input)).value
      await f.release()
      expect((await f.read()).availability).toBe('retained')
      expect(await f.store.retainedCaptureBytes(f.source.manifest.snapshotId)).toBeGreaterThan(0)
      const graph = structuredClone(saved.version.definition)
      delete graph.defaultWorktree
      delete agentWorkflowNode(graph.nodes[0]).placement
      await f.base.services.workflows.current.save(f.base.writer.principal, 'http', { ...f.input,
        commandId: randomUUID(), graph, expectedRevision: saved.revision,
        expectedWorkflowVersionId: saved.currentVersionId })
      await f.release()
      await expect(f.read()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
      expect(await f.store.retainedCaptureBytes(f.source.manifest.snapshotId)).toBe(0)
      const historical = await f.base.services.workflows.current.read(f.base.writer.principal, {
        workspaceId: f.input.workspaceId, workflowId: f.input.workflowId, workflowVersionId: saved.version.id,
      })
      expect(historical.version).toEqual(saved.version)
    } finally { await f.close() }
  }, 120_000)

  it('retains the current prepared project and expires it after repository configuration is removed', async () => {
    const f = await fixture()
    try {
      await f.base.db.pool.query(`insert into workspace_repository_imports
        (import_id,principal_id,workspace_id,command_id,input_hash,input,phase,preparation,results,finished_at)
        values($1,$2,$3,$4,$5,$6::jsonb,'ready','{}',$7::jsonb,now())`,
      [randomUUID(), f.base.writer.principal.id, f.input.workspaceId, randomUUID(), 'sha256:' + 'a'.repeat(64),
        JSON.stringify({ repository: f.repository }), JSON.stringify({ approvedSource: f.source,
          location: { locationRevision: f.placement.locationRevision }, rootBinding: f.placement.local.rootBinding })])
      await f.release()
      expect((await f.read()).availability).toBe('retained')
      expect(await f.store.retainedCaptureBytes(f.source.manifest.snapshotId)).toBeGreaterThan(0)
      await f.base.services.workspaces.update(f.base.writer.principal, 'http', {
        workspaceId: f.input.workspaceId, commandId: randomUUID(), expectedRevision: f.configured.value.revision,
        repository: null,
      })
      await f.release()
      await expect(f.read()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
      const listed = await f.placement.sources.list(f.base.writer.principal, 'http', { workspaceId: f.input.workspaceId })
      expect(ApprovedSourceSchema.parse(listed.items[0]).manifest).toEqual(f.source.manifest)
      expect(ApprovedSourceSchema.parse(listed.items[0]).availability).toBe('unavailable')
    } finally { await f.close() }
  }, 120_000)
})
