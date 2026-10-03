import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, rename, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { qualifyApprovedRootAllowlist, verifyApprovedRootAllowlist, attestWorkspaceRoot, browseApprovedRoot, createWorkspaceRootWorkerHandler } from './rootAttestation.js'
import type { WorkspaceRootSelection } from '@graphql/contracts/workspace-root-policies'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp('/tmp/root-policy-'); roots.push(root)
  const base = join(root, 'projects'), runtime = join(root, 'runtime'); await mkdir(base, { mode: 0o700 }); await mkdir(runtime, { mode: 0o700 }); await mkdir(join(base, 'project'), { mode: 0o755 })
  const mainId = randomUUID(), baseId = randomUUID()
  const allowlist = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
    configurationRevision: '1', bases: [{ baseId, canonicalPath: base, accessModes: ['read-only', 'read-write'] }], managedRuntimeRoot: runtime })
  const selection: WorkspaceRootSelection = { workspaceId: 'workspace-real', hostRef: allowlist.hostRef, allowedBaseId: baseId,
    configurationRevision: '1', relativePath: 'project', accessMode: 'read-write', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 }
  return { root, base, runtime, allowlist, selection }
}
it('attests actual allowed root identity without a Run, Agent or caller absolute path', async () => {
  const f = await fixture(); const proof = await attestWorkspaceRoot(f.allowlist, f.selection)
  expect(proof.canonicalProjectRoot).toBe(join(f.base, 'project')); expect(proof.applicationInstallationId).toBe(f.allowlist.applicationInstallationId)
  expect(proof.filesystem.mountId).toMatch(/^\d+$/); expect(proof.attestationDigest).toMatch(/^[a-f0-9]{64}$/)
})
it('verifies persisted approved identities on restart and rejects base replacement without refresh', async () => {
  const f = await fixture(); await verifyApprovedRootAllowlist(f.allowlist)
  await rename(f.base, `${f.base}-old`); await mkdir(f.base, { mode: 0o700 })
  await expect(verifyApprovedRootAllowlist(f.allowlist)).rejects.toThrow('changed')
  await expect(attestWorkspaceRoot(f.allowlist, f.selection)).rejects.toThrow('replaced')
})
it('rejects traversal and symlink directories at component operations', async () => {
  const f = await fixture(); await symlink(f.runtime, join(f.base, 'link'))
  await expect(attestWorkspaceRoot(f.allowlist, { ...f.selection, relativePath: '../runtime' })).rejects.toThrow('relative')
  await expect(attestWorkspaceRoot(f.allowlist, { ...f.selection, relativePath: 'link' })).rejects.toThrow()
  expect((await browseApprovedRoot(f.allowlist, f.selection, '')).directories.map(d => d.name)).toEqual(['project'])
})
it('authenticates the actual main/device root request before local allowlist or filesystem work', async () => {
  const f = await fixture(), read = vi.fn(async () => f.allowlist), authorize = vi.fn(async () => { throw new Error('wrong main') })
  const handler = createWorkspaceRootWorkerHandler(read, authorize)
  await expect(handler({ version: 1, operation: 'workspace-roots.attest', selection: f.selection })).rejects.toThrow('wrong main')
  expect(read).not.toHaveBeenCalled()
})
it('supports protected owner-only-write bases with ordinary readable project permissions', async () => {
  const f = await fixture(); await chmod(f.base, 0o755)
  const approved = await qualifyApprovedRootAllowlist({ ...f.allowlist, bases: [{ baseId: f.selection.allowedBaseId, canonicalPath: f.base, accessModes: ['read-only', 'read-write'] }] })
  expect((await attestWorkspaceRoot(approved, f.selection)).canonicalProjectRoot).toBe(join(f.base, 'project'))
  await chmod(join(f.base, 'project'), 0o777)
  await expect(attestWorkspaceRoot(approved, f.selection)).rejects.toThrow('other writers')
})

it('returns only the original allowlist through authenticated configuration adoption', async () => {
  const f = await fixture(), authorize = vi.fn(async () => {}), read = vi.fn(async () => f.allowlist)
  expect(await createWorkspaceRootWorkerHandler(read, authorize)({ version: 1, operation: 'workspace-roots.configuration' })).toEqual(f.allowlist)
  expect(authorize).toHaveBeenCalledBefore(read)
  read.mockClear(); authorize.mockRejectedValue(new Error('denied'))
  await expect(createWorkspaceRootWorkerHandler(read, authorize)({ version: 1, operation: 'workspace-roots.configuration' })).rejects.toThrow('denied')
  expect(read).not.toHaveBeenCalled()
})
