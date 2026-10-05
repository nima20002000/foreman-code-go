import { sourceMaterializationClaimName } from './quotaClaims.js'
import type { SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, mkdir, open, readdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JobVerificationQuotaPool } from '@foreman-code/contracts/job-verification-runtime'
import { sourceMaterializationParent, type RootBinding } from '@foreman-code/contracts/source-materialization'
import type { JobQuotaReader } from '../jobs/quotaOwnership.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim, reconcileSourcePreparation } from './materialization.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(slotCount = 2) {
  const root = await mkdtemp(join(tmpdir(), 'job-source-quota-'))
  roots.push(root)
  await chmod(root, 0o700)
  const bytes = Buffer.from('same accepted source')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', deletions: [],
    entries: [{ path: 'src/index.ts', kind: 'file', byteSize: bytes.length,
      sha256: sourceSha256(bytes), executable: false }] })
  const directory = await openPrivateRoot(root)
  const filesystem = await identity(directory)
  await directory.close()
  const binding: RootBinding = { version: 1, mainId: randomUUID(), deviceId: null, workerInstallationId: null,
    workspaceId: randomUUID(), rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: root,
    filesystem, accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const slots = []
  for (const projectId of Array.from({ length: slotCount }, (_, index) => 2 + index)) {
    const namespace = randomUUID()
    const path = join(root, namespace)
    await mkdir(path, { mode: 0o700 })
    const slot = await openPrivateRoot(path)
    slots.push({ namespace, projectId, hardLimitBytes: 8 * 2 ** 20, hardInodes: 100,
      filesystem: await identity(slot) })
    await slot.close()
  }
  const pool: JobVerificationQuotaPool = { queryExecutable: '/protected/quota-query', queryBinarySha256: 'a'.repeat(64),
    blockDevice: '/dev/loop0', volumeCapacityInodes: 1000, slots }
  const retained = new Set<string>()
  // The kernel reader is an external boundary; these tests exercise actual filesystem claims and copies.
  const read: JobQuotaReader = async (_pool, path, signal) => {
    signal.throwIfAborted()
    const slot = pool.slots.find(value => path.startsWith(join(root, value.namespace)))!
    const file = await openPrivateRoot(path)
    const fs = await identity(file)
    await file.close()
    const base = join(root, slot.namespace)
    const stat = await open(base, 'r')
    const allocated = (await stat.stat()).blocks * 512
    await stat.close()
    const occupied = (await readdir(base)).length > 0 || retained.has(slot.namespace)
    return { volumeCapacityBytes: 64 * 2 ** 30, volumeCapacityInodes: 1000,
      projectId: slot.projectId, inheritance: true, hardLimitBytes: slot.hardLimitBytes, hardInodes: slot.hardInodes,
      usedBytes: occupied ? allocated + 4096 : allocated, usedInodes: occupied ? 2 : 1,
      accountingEnabled: true, filesystem: fs }
  }
  const quota = { pool, read }
  const attempt = () => ({ placementHash: 'b'.repeat(64), executionId: randomUUID(), attemptId: randomUUID(),
    keyRevision: null, authorizationRevision: null })
  const materializer = () => new PrivateSourceMaterializer({ read: async () => bytes }, async () => {}, quota)
  return { root, manifest, binding, quota, attempt, materializer, bytes, retained }
}

describe('per-Job source quota ownership', () => {
  it.each([4, 2])('prepares %i concurrent Jobs from one root and recovers their independent quotas after restart', async count => {
    const f = await fixture(count)
    const attempts = Array.from({ length: count }, () => f.attempt())
    const receipts = await Promise.all(attempts.map(attempt =>
      f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt })))
    expect(new Set(receipts.map(receipt => receipt.quota!.projectId)).size).toBe(count)
    expect(new Set(receipts.map(receipt => receipt.quota!.namespace)).size).toBe(count)
    for (const [index, receipt] of receipts.entries()) {
      expect(await f.materializer().recover(f.binding, attempts[index]!)).toEqual(receipt)
      expect(await readFile(join(sourceMaterializationParent(receipt), 'tree/src/index.ts'))).toEqual(f.bytes)
    }
    await expect(f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() }))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
  })

  it('recovers a persisted slot claim when the attempt claim write was interrupted', async () => {
    const f = await fixture()
    const attempt = f.attempt()
    const receipt = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt })
    await rm(join(f.root, sourceMaterializationClaimName(f.binding, attempt, f.quota)))
    expect(await f.materializer().recover(f.binding, attempt)).toEqual(receipt)
    const other = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    expect(other.quota!.projectId).not.toBe(receipt.quota!.projectId)
  })

  it('reclaims an interrupted preparation after restart and keeps its original closure on retry', async () => {
    const f = await fixture()
    const attempt = f.attempt()
    const source = { approvedSourceId: f.manifest.approvedSourceId,
      snapshotId: f.manifest.snapshotId, manifestDigest: f.manifest.manifestDigest }
    const owner: SourceOperationOwner = { identity: { operationId: randomUUID(), ownerPrincipalId: 'operator',
      expiresAt: new Date(Date.now() + 60_000).toISOString() },
      root: { version: 1, source, binding: f.binding, registration: null,
        selection: { hostRef: { kind: 'main', mainId: f.binding.mainId }, rootPolicyId: randomUUID(),
          rootPolicyRevision: '1', locationRevision: '1' }, ownerPrincipalId: 'operator',
        authorizedByPrincipalId: 'operator', attestationId: randomUUID(), attestationDigest: 'a'.repeat(64),
        boundAt: new Date().toISOString() },
      attempt, source, record: null, physicalClosureConfirmed: false, preparationClosed: true }
    const interrupted = new PrivateSourceMaterializer({ read: async () => { throw new Error('connection interrupted') } },
      async () => {}, f.quota)
    await expect(interrupted.prepare({ manifest: f.manifest, binding: f.binding, attempt }))
      .rejects.toThrow('connection interrupted')
    await expect(f.materializer().recover(f.binding, attempt))
      .rejects.toMatchObject({ code: 'SOURCE_MATERIALIZATION_UNCERTAIN' })
    const reconciliationId = randomUUID()
    const closure = await reconcileSourcePreparation(reconciliationId, owner, async () => true, async () => {}, f.quota)
    expect(closure.quotaReclaimed).toBe(true)
    expect(await reconcileSourcePreparation(reconciliationId, owner, async () => true, async () => {}, f.quota))
      .toEqual(closure)
    const prepared = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    expect(prepared.quota!.projectId).toBe(f.quota.pool.slots[0]!.projectId)
  })

  it('retains the original quota when closure or deleted-file accounting remains uncertain', async () => {
    const f = await fixture()
    const first = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    await expect(releaseMaterializationClaim(first, async () => 'uncertain', f.quota))
      .rejects.toMatchObject({ code: 'SOURCE_ROOT_OWNED' })
    f.retained.add(first.quota!.namespace)
    await expect(releaseMaterializationClaim(first, async () => 'released', f.quota))
      .rejects.toMatchObject({ code: 'SOURCE_QUOTA_OWNED' })
    await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    await expect(f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() }))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
    f.retained.clear()
    await releaseMaterializationClaim(first, async () => 'released', f.quota)
    const successor = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    expect(successor.quota).toEqual(first.quota)
    await releaseMaterializationClaim(first, async () => 'released', f.quota)
    expect(await readFile(join(sourceMaterializationParent(successor), 'tree/src/index.ts'))).toEqual(f.bytes)
  })

  it('cleans only the original namespace, including scratch symlinks, and finishes after a lost release acknowledgment', async () => {
    const f = await fixture()
    const first = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    const outside = join(f.root, 'retained-source-snapshot')
    await writeFile(outside, f.bytes, { mode: 0o600 })
    await symlink(outside, join(sourceMaterializationParent(first), 'scratch-link'))
    await releaseMaterializationClaim(first, async () => 'released', f.quota)
    await releaseMaterializationClaim(first, async () => 'released', { ...f.quota })
    expect(await readFile(outside)).toEqual(f.bytes)
    await expect(readFile(join(sourceMaterializationParent(first), 'receipt.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(f.root, first.quota!.namespace))).toEqual([])
  })
})
