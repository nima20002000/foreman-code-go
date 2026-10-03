import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SourceOperationOwner } from '@graphql/contracts/source-operations'
import { SourcePreparationReconcileInputSchema } from '@graphql/contracts/source-admission'
import { PrivateSourceMaterializer, reconcileSourcePreparation } from './materialization.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { sourceBindingHash } from './bindingHash.js'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function fixture(copy = true) {
  const directory = await mkdtemp('/tmp/jobprep-reconcile-'); directories.push(directory)
  const handle = await openPrivateRoot(directory), filesystem = await identity(handle); await handle.close()
  const bytes = Buffer.from('retained source evidence'), manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', entries: [{ path: 'source.txt', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }], deletions: [] })
  const mainId = randomUUID(), operationId = randomUUID()
  const root: SourceOperationOwner['root'] = { version: 1, source: { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
    selection: { hostRef: { kind: 'main', mainId }, rootPolicyId: randomUUID(), rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId, deviceId: null, workerInstallationId: null, workspaceId: 'workspace', rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
      canonicalPath: directory, filesystem, accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
    registration: null, ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner', attestationId: randomUUID(), attestationDigest: 'a'.repeat(64), boundAt: new Date().toISOString() }
  const attempt = { executionId: randomUUID(), attemptId: randomUUID(), keyRevision: null, authorizationRevision: null, placementHash: '' }
  attempt.placementHash = sourceBindingHash(root, attempt, operationId)
  const owner: SourceOperationOwner = { identity: { operationId, ownerPrincipalId: 'cleanup-operator', expiresAt: new Date(Date.now() + 60000).toISOString() },
    root, attempt, source: root.source, record: null, physicalClosureConfirmed: false, preparationClosed: true }
  if (copy) {
    const receipt = await new PrivateSourceMaterializer({ read: async () => bytes }, async () => {}).prepare({ manifest, binding: root.binding, attempt })
    owner.record = { receipt, operationId, reservationId: randomUUID(), rootPolicyId: root.selection.rootPolicyId, rootPolicyRevision: '1', sourceBindingHash: attempt.placementHash,
      finalDispatchBindingHash: null, state: 'prepared' }
    await mkdir(join(directory, receipt.materializationId, 'repository'), { mode: 0o700 })
    await writeFile(join(directory, receipt.materializationId, 'repository', 'partial-object'), 'original incomplete Git evidence', { mode: 0o600 })
  }
  return { directory, owner, bytes, reconciliationId: randomUUID(), nativeClosed: vi.fn(async () => true), reauthorize: vi.fn(async () => {}) }
}
it('archives a closed claim, retains every source/private-repository byte and replays closure without touching a successor', async () => {
  const f = await fixture(), id = f.owner.record!.receipt.materializationId
  const claim = await readFile(join(f.directory, `binding-${f.owner.root.binding.rootId}.lock`))
  const proof = await reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize)
  expect(proof).toMatchObject({ materializationId: id, admissionClosed: true, childrenClosed: true, claimReleased: true, evidencePreserved: true })
  expect(await readFile(join(f.directory, `closed-preparation-${f.reconciliationId}.claim.json`))).toEqual(claim)
  expect(await readFile(join(f.directory, id, 'tree/source.txt'))).toEqual(f.bytes)
  expect(await readFile(join(f.directory, id, 'repository/partial-object'), 'utf8')).toBe('original incomplete Git evidence')
  const successor = Buffer.from('successor claim must remain exact')
  await writeFile(join(f.directory, `binding-${f.owner.root.binding.rootId}.lock`), successor, { mode: 0o600 })
  expect(await reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize)).toEqual(proof)
  expect(await readFile(join(f.directory, `binding-${f.owner.root.binding.rootId}.lock`))).toEqual(successor)
})
it('retains a pre-activation failure with no Main materialization record or local claim', async () => {
  const f = await fixture(false)
  const proof = await reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize)
  expect(proof.materializationId).toBeNull(); expect(proof.evidencePreserved).toBe(true)
})
it('does not accept an empty task set while an original namespace child is still live', async () => {
  const f = await fixture(), child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: f.directory, stdio: 'ignore' })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  try {
    await expect(reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize)).rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
    expect(await readdir(f.directory)).toContain(`binding-${f.owner.root.binding.rootId}.lock`)
  } finally { child.kill('SIGKILL'); await closed }
  expect((await reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize)).childrenClosed).toBe(true)
})
it('preserves uncertain native ownership and rejects missing admission closure, changed roots and caller closure flags', async () => {
  const f = await fixture(); f.nativeClosed.mockResolvedValue(false)
  await expect(reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize)).rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
  const { preparationClosed: _closed, ...unconfirmed } = f.owner; void _closed
  await expect(reconcileSourcePreparation(f.reconciliationId, unconfirmed, f.nativeClosed, f.reauthorize)).rejects.toThrow('admission closure')
  const changed = structuredClone(f.owner); changed.root.binding.filesystem.inode = '999999'
  await expect(reconcileSourcePreparation(f.reconciliationId, changed, f.nativeClosed, f.reauthorize)).rejects.toMatchObject({ code: 'SOURCE_ROOT_CHANGED' })
  expect(SourcePreparationReconcileInputSchema.safeParse({ workspaceId: 'workspace', operationId: f.owner.identity.operationId, commandId: randomUUID(), childrenClosed: true }).success).toBe(false)
})
