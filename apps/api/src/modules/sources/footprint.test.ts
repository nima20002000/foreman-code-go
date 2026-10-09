import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import { sourceMaterializationBytes, sourceStructureBytes } from './footprint.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { PrivateSourceSnapshotStore } from './store.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim } from './materialization.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { measureRetainedMaterializationFootprint } from './retainedDirectoryUsage.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it('covers the complete parent structure of a directory-heavy source through capture and closure', async () => {
  const directory = await mkdtemp('/tmp/source-footprint-')
  directories.push(directory)
  const canonical = join(directory, 'canonical')
  const root = join(directory, 'materializations')
  await mkdir(canonical, { mode: 0o700 })
  await mkdir(root, { mode: 0o700 })
  const bytes = Buffer.from('x')
  const paths = Array.from({ length: 1000 }, (_, index) =>
    [String(index).padStart(4, '0'), ...Array.from({ length: 15 }, (_, depth) => `d${depth}`), 'file.ts'].join('/'))
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', deletions: [],
    entries: paths.map(path => ({ path, kind: 'file', byteSize: bytes.length,
      sha256: sourceSha256(bytes), executable: false })) })
  const store = new PrivateSourceSnapshotStore(canonical)
  for (const entry of manifest.entries) await store.write(manifest.snapshotId, entry, bytes)
  await store.commit(manifest)
  expect(await store.retainedCaptureBytes(manifest.snapshotId))
    .toBeLessThanOrEqual(manifest.totalBytes + sourceStructureBytes(paths))
  const handle = await openPrivateRoot(root)
  const filesystem = await identity(handle)
  await handle.close()
  const binding: RootBinding = { version: 1, mainId: randomUUID(), deviceId: null, workerInstallationId: null,
    workspaceId: randomUUID(), rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
    canonicalPath: root, filesystem, accessMode: 'exclusive-write',
    snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const attempt = { executionId: randomUUID(), attemptId: randomUUID(), placementHash: 'a'.repeat(64),
    keyRevision: null, authorizationRevision: null }
  const materializer = new PrivateSourceMaterializer(store, async () => {})
  const receipt = await materializer.prepare({ manifest, binding, attempt, sharedWritableTree: true })
  expect(await materializer.prepare({ manifest, binding, attempt, sharedWritableTree: true })).toEqual(receipt)
  await releaseMaterializationClaim(receipt, async () => 'released')
  const footprint = await measureRetainedMaterializationFootprint(receipt)
  expect(footprint.retainedBytes).toBeGreaterThan(manifest.totalEntries * 8192 + 2 * 1024 * 1024)
  expect(footprint.retainedBytes + 16 * 1024).toBeLessThanOrEqual(sourceMaterializationBytes(manifest))
  await materializer.verify(receipt, { binding, attempt })
  await releaseMaterializationClaim(receipt, async () => 'released')
  expect(await measureRetainedMaterializationFootprint(receipt)).toEqual(footprint)
}, 120_000)

it('includes the saved Git object bytes in materialization placement', () => {
  const bytes = Buffer.from('source')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip', deletions: [],
    git: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1' },
    entries: [{ path: 'source.ts', kind: 'file', byteSize: bytes.length,
      sha256: sourceSha256(bytes), executable: false }] })
  const metadataBytes = 8 * 1024 * 1024
  const captured = createSourceManifest({ ...manifest,
    git: { ...manifest.git!, metadata: { byteSize: metadataBytes, sha256: 'c'.repeat(64) } } })
  expect(sourceMaterializationBytes(captured) - sourceMaterializationBytes(manifest)).toBe(metadataBytes)
})
