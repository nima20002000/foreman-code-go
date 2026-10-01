import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { SourceFilesystemOperationSchema } from '@graphql/contracts/source-operations'
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
