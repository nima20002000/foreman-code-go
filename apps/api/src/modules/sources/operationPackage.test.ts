import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { SourceFilesystemOperationSchema } from '@foreman-code/contracts/source-operations'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { sourcePackageHeader, sourcePackageStream, VerifiedSourcePackageReader } from './operationPackage.js'
function fixture() {
  const bytes = Buffer.from([0, 255, 17])
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(), capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', deletions: [],
    entries: [{ path: 'binary.dat', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }] })
  const packageBytes = Buffer.concat([sourcePackageHeader(manifest), bytes]), signal = new AbortController().signal
  return { bytes, manifest, packageBytes, signal }
}
it('streams a single exact nonarchive source object with bounded reads and binary bytes', async () => {
  const f = fixture(), chunks: Buffer[] = []
  for await (const value of sourcePackageStream(f.manifest, { read: async () => f.bytes }, f.signal)) chunks.push(value as Buffer)
  expect(Buffer.concat(chunks)).toEqual(f.packageBytes)
  const reader = new VerifiedSourcePackageReader(Readable.from(chunks), f.packageBytes.length, f.signal)
  expect(await reader.open(f.manifest)).toEqual(f.manifest)
  expect(await reader.read(f.manifest, f.manifest.entries[0]!, f.signal)).toEqual(f.bytes)
  await reader.complete(); await reader.complete(); reader.close()
})
it('rejects wrong source identity, trailing extents and incomplete packages without archive fallback', async () => {
  const f = fixture()
  await expect(new VerifiedSourcePackageReader(Readable.from([f.packageBytes]), f.packageBytes.length, f.signal).open({ ...f.manifest, manifestDigest: 'a'.repeat(64) })).rejects.toThrow('exact snapshot')
  await expect(new VerifiedSourcePackageReader(Readable.from([f.packageBytes.subarray(0, 8)]), f.packageBytes.length, f.signal).open(f.manifest)).rejects.toThrow('truncated')
  await expect(new VerifiedSourcePackageReader(Readable.from([Buffer.concat([f.packageBytes, Buffer.from('extra')])]), f.packageBytes.length + 5, f.signal).open(f.manifest)).rejects.toThrow('extent')
})
it('rejects source RPC caller filesystem overrides and invented bootstrap members', () => {
  expect(SourceFilesystemOperationSchema.safeParse({ version: 1, operation: 'sources.prepare', path: '/home/secret', bytes: 'shortcut', runId: 'fake' }).success).toBe(false)
})


it('transfers approved Git metadata with its source pin and rejects corrupted metadata', async () => {
  const f = fixture()
  const metadata = Buffer.from('approved commit and trees')
  const manifest = createSourceManifest({ ...f.manifest, capturePolicy: 'git-tree-v1',
    git: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1', repository: 'octo/site',
      metadata: { byteSize: metadata.length, sha256: sourceSha256(metadata) } } })
  const chunks: Buffer[] = []
  for await (const chunk of sourcePackageStream(manifest,
    { read: async () => f.bytes, readGitMetadata: async () => metadata }, f.signal)) chunks.push(chunk as Buffer)
  const packageBytes = Buffer.concat(chunks)
  const reader = new VerifiedSourcePackageReader(Readable.from(chunks), packageBytes.length, f.signal)
  await reader.open(manifest)
  expect(await reader.read(manifest, manifest.entries[0]!, f.signal)).toEqual(f.bytes)
  expect(reader.readyToComplete).toBe(false)
  expect(await reader.readGitMetadata(manifest, f.signal)).toEqual(metadata)
  await reader.complete()
  const corrupt = Buffer.from(packageBytes)
  corrupt[corrupt.length - 1] = 0
  const rejected = new VerifiedSourcePackageReader(Readable.from([corrupt]), corrupt.length, f.signal)
  await rejected.open(manifest)
  await rejected.read(manifest, manifest.entries[0]!, f.signal)
  await expect(rejected.readGitMetadata(manifest, f.signal)).rejects.toMatchObject({ code: 'SOURCE_BYTES_INVALID' })
})


it('keeps the source digest stable when Git metadata fields arrive in another order', () => {
  const f = fixture()
  const git = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1' as const }
  const first = createSourceManifest({ ...f.manifest, capturePolicy: 'git-tree-v1',
    git: { ...git, metadata: { byteSize: 123, sha256: 'c'.repeat(64) } } })
  const reordered = createSourceManifest({ ...f.manifest, capturePolicy: 'git-tree-v1',
    git: { ...git, metadata: { sha256: 'c'.repeat(64), byteSize: 123 } } })
  expect(reordered.manifestDigest).toBe(first.manifestDigest)
})
