import { constants } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { mkdir, open, rename, type FileHandle } from 'node:fs/promises'
import { SourceManifestSchema, type SourceManifest, type SourceEntry } from '@graphql/contracts/source-materialization'
import { anchored, entryParent, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'
import { SourceError, sourcePath, verifySourceBytes, verifySourceManifest } from './manifest.js'
import type { SourceSnapshotSink } from './capture.js'
import type { SourceByteReader, SourceSnapshotPin } from './ports.js'

/** Dedicated main-owned source namespace. It is not FileByteStorage or a worker DB.
 * Failed/prepared snapshot directories remain quarantined and discoverable;
 * authoritative retention/ownership reconciliation owns reclamation.
 */
export class PrivateSourceSnapshotStore implements SourceSnapshotSink, SourceByteReader {
  constructor(private readonly canonicalRoot: string) {}
  private async directory(id: string, create: boolean): Promise<{ root: FileHandle; snapshot: FileHandle }> {
    SourceManifestSchema.shape.snapshotId.parse(id)
    const root = await openPrivateRoot(this.canonicalRoot)
    try {
      if (create) { try { await mkdir(anchored(root, id), { mode: 0o700 }) } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error } }
      return { root, snapshot: await openChildDirectory(root, id) }
    } catch (error) { await root.close(); throw error }
  }
  async write(id: string, entry: SourceEntry, bytes: Uint8Array): Promise<void> {
    sourcePath(entry.path); verifySourceBytes(entry, bytes)
    const { root, snapshot } = await this.directory(id, true)
    try {
      const existing = await open(anchored(snapshot, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
        throw error
      })
      if (existing) { await existing.close(); throw new SourceError('SOURCE_ALREADY_COMMITTED', 'Committed source snapshots are immutable.') }
      const data = await openChildDirectory(snapshot, 'bytes', true)
      const target = await entryParent(data, entry.path, true).finally(() => data.close())
      const { parent, leaf } = target
      try {
        const file = await open(anchored(parent, leaf), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
        try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
        await parent.sync()
      } finally { await parent.close() }
      await snapshot.sync(); await root.sync()
    } finally { await snapshot.close(); await root.close() }
  }
  async commit(input: SourceManifest): Promise<void> {
    const manifest = verifySourceManifest(input), { root, snapshot } = await this.directory(manifest.snapshotId, true)
    try {
      const aborted = await open(anchored(snapshot, 'capture-aborted'), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
        throw error
      })
      if (aborted) { await aborted.close(); throw new SourceError('SOURCE_CAPTURE_ABORTED', 'An aborted capture cannot become ready.') }
      const claim = await open(anchored(snapshot, 'commit.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
      try { await claim.writeFile(manifest.manifestDigest); await claim.sync() } finally { await claim.close() }
      for (const entry of manifest.entries) await this.readEntry(snapshot, entry)
      const file = await open(anchored(snapshot, 'manifest.pending'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
      try { await file.writeFile(JSON.stringify(manifest)); await file.sync() } finally { await file.close() }
      // Snapshot ID is allocated exclusively by capture. A commit replay cannot
      // acquire commit.lock again, so it cannot replace an accepted manifest.
      await rename(anchored(snapshot, 'manifest.pending'), anchored(snapshot, 'manifest.json'))
      await snapshot.sync(); await root.sync()
    } finally { await snapshot.close(); await root.close() }
  }
  async abort(id: string): Promise<void> {
    const { root, snapshot } = await this.directory(id, true)
    try {
      const marker = await open(anchored(snapshot, 'capture-aborted'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
      try { await marker.writeFile('Source capture failed; not ready.\n'); await marker.sync() } finally { await marker.close() }
      await snapshot.sync(); await root.sync()
    } finally { await snapshot.close(); await root.close() }
  }
  private async readEntry(snapshot: FileHandle, entry: SourceEntry): Promise<Buffer> {
    sourcePath(entry.path)
    const data = await openChildDirectory(snapshot, 'bytes')
    const target = await entryParent(data, entry.path, false).finally(() => data.close())
    const { parent, leaf } = target
    try {
      const file = await open(anchored(parent, leaf), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.byteSize) throw new SourceError('SOURCE_BYTES_INVALID', 'Canonical source kind/size/link count changed.')
        const bytes = await file.readFile(); verifySourceBytes(entry, bytes); return bytes
      } finally { await file.close() }
    } finally { await parent.close() }
  }
  async read(pin: SourceSnapshotPin, entry: SourceEntry, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted()
    const { root, snapshot } = await this.directory(pin.snapshotId, false)
    try {
      const file = await open(anchored(snapshot, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      let manifest: SourceManifest
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new SourceError('SOURCE_MANIFEST_INVALID', 'Invalid canonical manifest record.')
        manifest = verifySourceManifest(JSON.parse(await file.readFile('utf8')))
      } finally { await file.close() }
      if (manifest.snapshotId !== pin.snapshotId || manifest.manifestDigest !== pin.manifestDigest || manifest.approvedSourceId !== pin.approvedSourceId
        || !manifest.entries.some((candidate) => isDeepStrictEqual(candidate, entry))) throw new SourceError('SOURCE_PIN_CONFLICT', 'Canonical source access requires the exact approved snapshot and inclusion.')
      const bytes = await this.readEntry(snapshot, entry); signal.throwIfAborted(); return bytes
    } finally { await snapshot.close(); await root.close() }
  }
}
