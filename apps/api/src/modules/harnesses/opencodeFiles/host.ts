import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, link, lstat, mkdir, open, readFile, readdir, readlink, rename, rmdir, unlink,
  type FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, normalize, sep } from 'node:path'
import type { FileRevision } from '@foreman-code/contracts/files'
import { sha256 } from './attachments.js'
import { checkFileCondition, OpenCodeFileError, type OpenCodeExecutionFiles,
  type OpenCodeRegisteredFile } from './types.js'

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const at = (directory: FileHandle, name: string) => `/proc/self/fd/${directory.fd}/${name}`
const opaque = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code

/** Linux openat-style traversal. Every component is anchored to an already-open descriptor.
 * A user-owned ancestor cannot race a path check and redirect a snapshot into the API byte vault.
 */
export async function openDirectory(path: string): Promise<FileHandle> {
  checkFileCondition(process.platform === 'linux' && isAbsolute(path) && normalize(path) === path,
    'FILE_HOST_UNSUPPORTED', 'Registered local file delivery requires a canonical Linux execution-host directory.')
  let fd = await open('/', directoryFlags)
  try {
    for (const part of path.split('/').filter(Boolean)) {
      const next = await open(at(fd, part), directoryFlags)
      await fd.close()
      fd = next
    }
    return fd
  } catch (error) { await fd.close(); throw error }
}

async function assertDirectoryEntry(parent: FileHandle, name: string, directory: FileHandle): Promise<void> {
  const held = await directory.stat({ bigint: true })
  const named = await lstat(at(parent, name), { bigint: true })
  checkFileCondition(held.ino === named.ino && held.dev === named.dev && named.isDirectory(),
    'FILE_CLEANUP_REQUIRED', 'The owned directory moved; do not remove an unregistered replacement.')
}

async function removeDirectoryContents(directory: FileHandle): Promise<void> {
  const parent = await directory.stat({ bigint: true })
  for (const name of await readdir(at(directory, '.'))) {
    const path = at(directory, name)
    const named = await lstat(path, { bigint: true })
    if (!named.isDirectory()) {
      // unlink removes links themselves, without opening their targets.
      await unlink(path)
      continue
    }
    checkFileCondition(named.dev === parent.dev, 'FILE_CLEANUP_REQUIRED',
      'Do not traverse a mounted filesystem while cleaning an owned directory.')
    const child = await open(path, directoryFlags)
    try {
      const held = await child.stat({ bigint: true })
      checkFileCondition(held.dev === named.dev && held.ino === named.ino,
        'FILE_CLEANUP_REQUIRED', 'The child directory changed before cleanup.')
      await removeDirectoryContents(child)
      await assertDirectoryEntry(directory, name, child)
      await rmdir(path)
    } finally {
      await child.close()
    }
  }
}

interface Registered {
  file: OpenCodeRegisteredFile
  directory: FileHandle
  filename: string
  inputHash: string
  writable: boolean
  cleanup?: { name: string; directory: FileHandle; moved: boolean; emptied: boolean }
}
interface LocalFileOptions {
  executionHostId: string
  /** Provisioned before launch; never selected by a model or browser. */
  root: string
  maxFileBytes: number
  /** Must execute on this host as the native identity, including its mount namespace.
   * Use assertProtectedSourcePaths or an equivalent runner-side isolation check, not chmod(0444).
   */
  assertSourceIsolation(signal: AbortSignal): Promise<void>
}

/** Runner-side only. Instantiate where OpenCode actually executes, not in a remote API process. */
export class LocalOpenCodeExecutionFiles implements OpenCodeExecutionFiles {
  readonly executionHostId: string
  private root: FileHandle | undefined
  private entries = new Map<string, Registered>()
  private operations: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: LocalFileOptions) {
    this.executionHostId = options.executionHostId
    checkFileCondition(options.executionHostId && Number.isSafeInteger(options.maxFileBytes)
      && options.maxFileBytes > 0, 'FILE_HOST_INVALID', 'An execution-host identity and bounded file limit are required.')
  }
  assertSourceIsolation(signal: AbortSignal): Promise<void> { return this.options.assertSourceIsolation(signal) }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operations.then(work)
    this.operations = result.catch(() => undefined)
    return result
  }
  private async rootDirectory(): Promise<FileHandle> {
    this.root ??= await openDirectory(this.options.root)
    return this.root
  }

  materialize(input: { handle: string; revision: FileRevision; bytes: Uint8Array; writable: boolean }, signal: AbortSignal) {
    return this.exclusive(async () => {
      signal.throwIfAborted()
      checkFileCondition(opaque(input.handle) && input.revision.filename === basename(input.revision.filename)
        && !['.', '..', ''].includes(input.revision.filename) && !/[\\\u0000-\u001f\u007f]/u.test(input.revision.filename),
      'FILE_HOST_INPUT_INVALID', 'Materialize a registered handle and a validated filename, never a host path.')
      checkFileCondition(input.bytes.byteLength <= this.options.maxFileBytes
        && input.bytes.byteLength === input.revision.byteSize && sha256(input.bytes) === input.revision.sha256,
      'FILE_ATTACHMENT_CHANGED', 'Materialization requires complete verified bytes.')
      const old = this.entries.get(input.handle)
      const inputHash = sha256(JSON.stringify([input.revision, input.writable]))
      if (old) {
        checkFileCondition(!old.cleanup, 'FILE_CLEANUP_REQUIRED', 'The registered handle is being removed.')
        checkFileCondition(old.inputHash === inputHash, 'FILE_ARTIFACT_CONFLICT', 'A registered handle cannot change its source.')
        return { ...old.file } // Never overwrite native edits when preparation is retried.
      }
      const root = await this.rootDirectory()
      // mkdir is deliberately non-recursive/exclusive; preexisting directories are not adopted.
      await mkdir(at(root, input.handle), { mode: 0o700 })
      const directory = await open(at(root, input.handle), directoryFlags)
      // Contract filenames are Unicode character-bounded; POSIX filenames are byte-bounded.
      // Preserve the display name in the revision, not by creating an overlong native filename.
      const filename = Buffer.byteLength(input.revision.filename, 'utf8') <= 200 ? input.revision.filename
        : `attachment${extname(input.revision.filename).slice(0, 12)}`
      const entry: Registered = { directory, filename, inputHash, writable: input.writable,
        file: { handle: input.handle, executionHostId: this.executionHostId,
          path: join(this.options.root, input.handle, filename) } }
      this.entries.set(input.handle, entry)
      let file: FileHandle | undefined
      try {
        file = await open(at(directory, entry.filename), constants.O_CREAT | constants.O_EXCL
          | constants.O_WRONLY | constants.O_NOFOLLOW, input.writable ? 0o600 : 0o400)
        await file.writeFile(input.bytes)
        await file.sync()
        signal.throwIfAborted()
        return { ...entry.file }
      } finally { await file?.close() }
    })
  }

  snapshot(handle: string, signal: AbortSignal): Promise<Uint8Array> {
    return this.exclusive(() => this.snapshotReady(handle, signal))
  }

  private async snapshotReady(handle: string, signal: AbortSignal): Promise<Uint8Array> {
    const entry = this.entries.get(handle)
    checkFileCondition(entry?.writable && !entry.cleanup, 'FILE_ARTIFACT_NOT_FOUND', 'Snapshot only a registered writable artifact handle.')
    signal.throwIfAborted()
    const file = await open(at(entry.directory, entry.filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await file.stat({ bigint: true })
      checkFileCondition(before.isFile() && before.nlink === 1n && before.size <= BigInt(this.options.maxFileBytes),
        'FILE_ARTIFACT_INVALID', 'Publish a bounded regular file, never a link, device, FIFO or directory.')
      const length = Number(before.size)
      const read = async () => {
        const data = Buffer.alloc(length)
        let offset = 0
        while (offset < length) {
          signal.throwIfAborted()
          const next = await file.read(data, offset, Math.min(65_536, length - offset), offset)
          checkFileCondition(next.bytesRead > 0, 'FILE_ARTIFACT_CHANGED', 'The working copy changed while being read.')
          offset += next.bytesRead
        }
        return data
      }
      const first = await read(), second = await read()
      const after = await file.stat({ bigint: true })
      checkFileCondition(before.dev === after.dev && before.ino === after.ino && before.size === after.size
        && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && after.nlink === 1n
        && sha256(first) === sha256(second), 'FILE_ARTIFACT_CHANGED', 'Finish native writes before publishing the working copy.')
      // Detect rename-based edits too; the FD must still be the currently registered directory entry.
      const current = await lstat(at(entry.directory, entry.filename), { bigint: true })
      checkFileCondition(current.dev === after.dev && current.ino === after.ino
        && current.mtimeNs === after.mtimeNs && current.ctimeNs === after.ctimeNs,
      'FILE_ARTIFACT_CHANGED', 'The working copy was replaced during publication.')
      signal.throwIfAborted()
      return first
    } finally { await file.close() }
  }

  async replace(handle: string, bytes: Uint8Array, expectedSha256: string, signal: AbortSignal): Promise<void> {
    checkFileCondition(sha256(await this.snapshot(handle, signal)) === expectedSha256,
      'FILE_ARTIFACT_CONFLICT', 'The native working copy changed during the file-tool edit.')
    return this.exclusive(async () => {
      const entry = this.entries.get(handle)
      checkFileCondition(entry?.writable && !entry.cleanup,
        'FILE_ARTIFACT_NOT_FOUND', 'Replace only a registered writable working copy.')
      checkFileCondition(bytes.byteLength <= this.options.maxFileBytes,
        'FILE_ARTIFACT_TOO_LARGE', 'The edited working copy exceeds the file limit.')
      const root = await this.rootDirectory()
      await assertDirectoryEntry(root, handle, entry.directory)
      const versionName = `.versions-${randomUUID()}`
      await mkdir(at(entry.directory, versionName), { mode: 0o700 })
      const versions = await open(at(entry.directory, versionName), directoryFlags)
      try {
        const edited = await open(at(versions, 'edited'),
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        try {
          await edited.writeFile(bytes)
          await edited.sync()
        } finally {
          await edited.close()
        }
        signal.throwIfAborted()
        await assertDirectoryEntry(root, handle, entry.directory)
        await assertDirectoryEntry(entry.directory, versionName, versions)
        // Keep the displaced inode: native writers may still have it open, or rename a new version here.
        await rename(at(entry.directory, entry.filename), at(versions, 'native'))
        await versions.sync()
        await entry.directory.sync()
        try {
          const displaced = await open(at(versions, 'native'), constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const stat = await displaced.stat()
            checkFileCondition(stat.isFile() && stat.nlink === 1 && stat.size <= this.options.maxFileBytes,
              'FILE_ARTIFACT_INVALID', 'The displaced working copy must remain a bounded regular file.')
            checkFileCondition(sha256(await displaced.readFile()) === expectedSha256,
              'FILE_ARTIFACT_CONFLICT', 'The native edit and file-tool edit are retained in the versions directory.')
          } finally {
            await displaced.close()
          }
          // link is create-only: a concurrent native rename or write at the leaf is never overwritten.
          await link(at(versions, 'edited'), at(entry.directory, entry.filename))
          await unlink(at(versions, 'edited'))
          await entry.directory.sync()
        } catch (error) {
          try {
            await link(at(versions, 'native'), at(entry.directory, entry.filename))
            await unlink(at(versions, 'native'))
          } catch (restoreError) {
            if (code(restoreError) !== 'EEXIST') {
              throw new AggregateError([error, restoreError], 'Working-copy versions are retained for recovery.')
            }
          }
          if (code(error) === 'EEXIST') {
            throw new OpenCodeFileError('FILE_ARTIFACT_CONFLICT',
              'A concurrent native edit remains at the working-copy path; both other versions are retained.')
          }
          throw error
        }
        await assertDirectoryEntry(root, handle, entry.directory)
      } finally {
        await versions.close()
      }
    })
  }

  remove(handle: string): Promise<void> {
    return this.exclusive(async () => {
      const entry = this.entries.get(handle)
      if (!entry) return
      const root = await this.rootDirectory()
      if (!entry.cleanup) {
        await assertDirectoryEntry(root, handle, entry.directory)
        // Detach the native path before deletion; failed cleanup keeps its descriptors and ownership.
        const name = `.cleanup-${randomUUID()}`
        await mkdir(at(root, name), { mode: 0o700 })
        entry.cleanup = { name, directory: await open(at(root, name), directoryFlags), moved: false, emptied: false }
      }
      const cleanup = entry.cleanup
      await assertDirectoryEntry(root, cleanup.name, cleanup.directory)
      if (!cleanup.moved) {
        await assertDirectoryEntry(root, handle, entry.directory)
        await rename(at(root, handle), at(cleanup.directory, 'files'))
        cleanup.moved = true
      }
      if (!cleanup.emptied) {
        await assertDirectoryEntry(cleanup.directory, 'files', entry.directory)
        await removeDirectoryContents(entry.directory)
        await assertDirectoryEntry(cleanup.directory, 'files', entry.directory)
        await rmdir(at(cleanup.directory, 'files'))
        cleanup.emptied = true
      }
      await assertDirectoryEntry(root, cleanup.name, cleanup.directory)
      await rmdir(at(root, cleanup.name))
      await entry.directory.close()
      await cleanup.directory.close()
      this.entries.delete(handle)
      if (!this.entries.size && this.root) { await this.root.close(); this.root = undefined }
    })
  }
}

/** Verify exact immutable source paths AND their parents. Call from the native host/OS identity.
 * Same-UID "chmod 0444" fails: its owner can chmod it back or replace a writable ancestor.
 * The composition root must provide ALL vault paths/aliases, not merely selected reference files.
 * For a directory vault, deny traversal or prove an entirely read-only filesystem separately.
 */
export async function assertProtectedSourcePaths(nativePid: number, paths: readonly string[], signal: AbortSignal): Promise<void> {
  checkFileCondition(process.platform === 'linux' && Number.isSafeInteger(nativePid) && nativePid > 0
    && paths.length > 0, 'FILE_SOURCE_ISOLATION_REQUIRED', 'Verify native identity and all protected source paths.')
  const status = await readFile(`/proc/${nativePid}/status`, 'utf8')
  const ids = (text: string, field: string) => new RegExp(`^${field}:\\s+(.*)$`, 'm').exec(text)?.[1]?.trim().split(/\s+/).map(Number) ?? []
  const uids = ids(status, 'Uid'), uid = uids[1]
  const group = (text: string) => /^Groups:\s*(.*)$/m.exec(text)?.[1]?.trim().split(/\s+/).filter(Boolean).sort().join(',')
  const self = await readFile('/proc/self/status', 'utf8')
  checkFileCondition(uids.length === 4 && uids.every((value) => value === uid)
    && uid !== 0 && uid === process.geteuid?.()
    && JSON.stringify(ids(status, 'Gid')) === JSON.stringify(ids(self, 'Gid'))
    && /^CapEff:\s+0+$/m.test(status) && /^CapPrm:\s+0+$/m.test(status)
    && group(status) === group(self)
    && await readlink(`/proc/${nativePid}/ns/mnt`) === await readlink('/proc/self/ns/mnt'),
  'FILE_SOURCE_ISOLATION_REQUIRED', 'Source checks must use the non-root native UID, groups and mount namespace without DAC capabilities.')
  const visited = new Set<string>()
  for (const source of paths) {
    checkFileCondition(isAbsolute(source) && normalize(source) === source,
      'FILE_SOURCE_ISOLATION_REQUIRED', 'Protected sources must be canonical absolute paths.')
    let path = source
    let leaf = true
    while (leaf || !visited.has(path)) {
      leaf = false
      signal.throwIfAborted()
      const stat = await lstat(path)
      checkFileCondition(!stat.isSymbolicLink() && stat.uid !== uid
        && ((stat.isFile() && stat.nlink === 1) || stat.isDirectory()),
        'FILE_SOURCE_WRITABLE', 'The native identity can replace or chmod a source path.')
      try {
        await access(path, constants.W_OK)
        throw new OpenCodeFileError('FILE_SOURCE_WRITABLE', 'A source or its ancestor is writable by OpenCode.')
      } catch (error) {
        if (!['EACCES', 'EPERM', 'EROFS'].includes(code(error) ?? '')) throw error
      }
      if (path === source && stat.isDirectory()) {
        // A non-writable directory alone says nothing about mutable children.
        try {
          await access(path, constants.X_OK)
          throw new OpenCodeFileError('FILE_SOURCE_ISOLATION_REQUIRED', 'Use an inaccessible vault or audit each immutable source file.')
        } catch (error) { if (!['EACCES', 'EPERM'].includes(code(error) ?? '')) throw error }
      }
      visited.add(path)
      if (path === sep) break
      path = dirname(path)
    }
  }
}
