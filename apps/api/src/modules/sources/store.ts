import { constants } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { basename, dirname } from 'node:path'
import { lstat, mkdir, open, readdir, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { SourceManifestSchema, type SourceManifest, type SourceEntry, type RootBinding } from '@foreman-code/contracts/source-materialization'
import { anchored, entryParent, identity, openChildDirectory, openPrivateRoot,
  withPrivateDirectoryLock } from './privateFilesystem.js'
import { readSourceStorageCapacity } from './storageCapacity.js'
import { SourceError, sourcePath, verifySourceBytes, verifySourceManifest } from './manifest.js'
import { measureRetainedSourceDirectory } from './retainedDirectoryUsage.js'
import type { SourceSnapshotSink } from './capture.js'
import type { SourceByteReader, SourceSnapshotPin } from './ports.js'

async function removeSnapshotDirectory(parent: FileHandle, name: string): Promise<void> {
  let directory: FileHandle
  try {
    directory = await openChildDirectory(parent, name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    for (const entry of await readdir(anchored(directory), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await removeSnapshotDirectory(directory, entry.name)
      } else {
        const path = anchored(directory, entry.name)
        const stat = await lstat(path)
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) {
          throw new SourceError('SOURCE_BYTES_INVALID', 'Snapshot cleanup requires private regular files.')
        }
        await unlink(path)
      }
    }
    await directory.sync()
  } finally { await directory.close() }
  await rmdir(anchored(parent, name))
  await parent.sync()
}

/** Dedicated main-owned source namespace. It is not FileByteStorage or a worker DB.
 * Failed/prepared snapshot directories remain quarantined and discoverable;
 * authoritative retention/ownership reconciliation owns reclamation.
 */
export class PrivateSourceSnapshotStore implements SourceSnapshotSink, SourceByteReader {
  private readonly manifests = new Map<string, {
    identity: string
    manifest: SourceManifest
    entries: Map<string, SourceEntry>
  }>()

  constructor(private readonly canonicalRoot: string) {}
  async storageCapacity() {
    await this.storageIdentity()
    return readSourceStorageCapacity(this.canonicalRoot)
  }
  async withCaptureLock<T>(snapshotId: string, work: () => Promise<T>,
    options: { nonBlocking?: boolean } = {}): Promise<T> {
    const { root, snapshot } = await this.directory(snapshotId, true)
    try {
      return await withPrivateDirectoryLock(snapshot, work, options)
    } finally {
      await snapshot.close()
      await root.close()
    }
  }
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
  async writeGitMetadata(snapshotId: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > 16 * 1024 * 1024) throw new SourceError('SOURCE_CAPACITY', 'Git metadata exceeds its source budget.')
    const { root, snapshot } = await this.directory(snapshotId, true)
    try {
      const file = await open(anchored(snapshot, 'git-objects.json'),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      await snapshot.sync()
    } finally { await snapshot.close(); await root.close() }
  }
  async readGitMetadata(input: SourceManifest, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted()
    const { root, snapshot } = await this.directory(input.snapshotId, false)
    try {
      const { manifest } = await this.readManifest(snapshot, input.snapshotId)
      if (!isDeepStrictEqual(input, manifest) || !manifest.git?.metadata) {
        throw new SourceError('SOURCE_PIN_CONFLICT', 'Git metadata requires the approved source manifest.')
      }
      const file = await open(anchored(snapshot, 'git-objects.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== manifest.git.metadata.byteSize) {
          throw new SourceError('SOURCE_BYTES_INVALID', 'Git metadata changed.')
        }
        const bytes = await file.readFile({ signal })
        verifySourceBytes({ ...manifest.git.metadata, path: 'git-objects.json', kind: 'file', executable: false }, bytes)
        return bytes
      } finally { await file.close() }
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
      if (manifest.git?.metadata) {
        const file = await open(anchored(snapshot, 'git-objects.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          verifySourceBytes({ ...manifest.git.metadata, path: 'git-objects.json', kind: 'file', executable: false }, await file.readFile())
        } finally { await file.close() }
      }
      const entries = manifest.entries.values()
      let failed: { error: unknown } | undefined
      await Promise.all(Array.from({ length: Math.min(8, manifest.entries.length) }, async () => {
        for (const entry of entries) {
          if (failed) break
          try { await this.readEntry(snapshot, entry) } catch (error) { failed ??= { error } }
        }
      }))
      if (failed) throw failed.error
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
  async manifest(snapshotId: string): Promise<SourceManifest> {
    const { root, snapshot } = await this.directory(snapshotId, false)
    try {
      const file = await open(anchored(snapshot, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new SourceError('SOURCE_MANIFEST_INVALID', 'Invalid canonical manifest record.')
        const manifest = verifySourceManifest(JSON.parse(await file.readFile('utf8')))
        if (manifest.snapshotId !== snapshotId) throw new SourceError('SOURCE_PIN_CONFLICT', 'Canonical source snapshot identity changed.')
        return manifest
      } finally { await file.close() }
    } finally { await snapshot.close(); await root.close() }
  }
  async storageIdentity(): Promise<RootBinding['filesystem']> {
    let root: FileHandle
    try {
      root = await openPrivateRoot(this.canonicalRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = await openPrivateRoot(dirname(this.canonicalRoot), false)
      try {
        const directory = await openChildDirectory(parent, basename(this.canonicalRoot), true)
        await directory.close()
        await parent.sync()
      } finally {
        await parent.close()
      }
      root = await openPrivateRoot(this.canonicalRoot)
    }
    try {
      return await identity(root)
    } finally {
      await root.close()
    }
  }

  /** The caller has persisted unavailability and excludes capture writers until deletion completes. */
  async remove(snapshotId: string): Promise<void> {
    SourceManifestSchema.shape.snapshotId.parse(snapshotId)
    const root = await openPrivateRoot(this.canonicalRoot)
    try {
      await removeSnapshotDirectory(root, snapshotId)
      this.manifests.delete(snapshotId)
    } finally { await root.close() }
  }

  /** Measure while capture writers are excluded. Files remain quarantined. */
  async retainedCaptureBytes(snapshotId: string): Promise<number> {
    return measureRetainedSourceDirectory(this.canonicalRoot, snapshotId)
  }

  private async readManifest(snapshot: FileHandle, snapshotId: string) {
    const file = await open(anchored(snapshot, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat({ bigint: true })
      if (!before.isFile() || before.nlink !== 1n || before.size > 2n * 1024n * 1024n) {
        throw new SourceError('SOURCE_MANIFEST_INVALID', 'Invalid canonical manifest record.')
      }
      const identity = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(':')
      const cached = this.manifests.get(snapshotId)
      // Every entry reopens the protected file; unchanged manifests need parsing only once.
      if (cached?.identity === identity) return cached

      const manifest = verifySourceManifest(JSON.parse(await file.readFile('utf8')))
      const after = await file.stat({ bigint: true })
      if (identity !== [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(':')) {
        throw new SourceError('SOURCE_MANIFEST_INVALID', 'Canonical manifest changed while reading.')
      }
      const record = { identity, manifest, entries: new Map(manifest.entries.map(entry => [entry.path, entry])) }
      if (!this.manifests.has(snapshotId) && this.manifests.size >= 8) {
        this.manifests.delete(this.manifests.keys().next().value!)
      }
      this.manifests.set(snapshotId, record)
      return record
    } finally {
      await file.close()
    }
  }

  async read(pin: SourceSnapshotPin, entry: SourceEntry, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted()
    const { root, snapshot } = await this.directory(pin.snapshotId, false)
    try {
      const { manifest, entries } = await this.readManifest(snapshot, pin.snapshotId)
      if (manifest.snapshotId !== pin.snapshotId || manifest.manifestDigest !== pin.manifestDigest || manifest.approvedSourceId !== pin.approvedSourceId
        || !isDeepStrictEqual(entries.get(entry.path), entry)) throw new SourceError('SOURCE_PIN_CONFLICT', 'Canonical source access requires the exact approved snapshot and inclusion.')
      const bytes = await this.readEntry(snapshot, entry); signal.throwIfAborted(); return bytes
    } finally { await snapshot.close(); await root.close() }
  }
}
