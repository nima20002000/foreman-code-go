import { isDeepStrictEqual } from 'node:util'
import { lstat, mkdir, readdir, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkerConversationBinding, WorkerConversationReceipt,
  WorkerOpenCodeFileRoot } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { anchored, identity, openChildDirectory, openPrivateRoot } from '../sources/privateFilesystem.js'
import { workerConversationProcessDigest } from './workerNativeOwner.js'
import type { WorkerConversationJournal } from './workerJournal.js'
import { DomainError } from '../errors.js'

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
type RecoverVersions = (root: WorkerOpenCodeFileRoot, directory: FileHandle, signal: AbortSignal) => Promise<void>
function changed(): never {
  throw new DomainError('WORKER_FILE_CLEANUP_REQUIRED', 'The recorded native file directory changed; cleanup needs review.', 409)
}

async function removeContents(directory: FileHandle, signal: AbortSignal): Promise<void> {
  for (const name of await readdir(anchored(directory))) {
    signal.throwIfAborted()
    const path = anchored(directory, name)
    const stat = await lstat(path)
    if (stat.isDirectory()) {
      const child = await openChildDirectory(directory, name)
      try { await removeContents(child, signal) } finally { await child.close() }
      await rmdir(path)
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      await unlink(path)
    } else changed()
  }
}

async function assertVersionsRecovered(directory: FileHandle, signal: AbortSignal): Promise<void> {
  for (const name of await readdir(anchored(directory))) {
    signal.throwIfAborted()
    const stat = await lstat(anchored(directory, name))
    if (!stat.isDirectory()) continue
    if (/^\.versions-[0-9a-f-]{36}$/.test(name)) {
      throw new DomainError('WORKER_FILE_VERSION_RECOVERY_REQUIRED',
        'Native and file-tool edits must be preserved through their original Main admission before cleanup.', 409)
    }
    const child = await openChildDirectory(directory, name)
    try { await assertVersionsRecovered(child, signal) } finally { await child.close() }
  }
}

/** Keeps native scratch ownership in the existing worker journal, including crash cuts before materialization. */
export class WorkerOpenCodeDirectories {
  private readonly parent: string
  constructor(stateDirectory: string, private readonly journal: WorkerConversationJournal) {
    this.parent = join(stateDirectory, 'opencode-chat-files')
  }

  async reserveDirectory(binding: WorkerConversationBinding) {
    const reserved = await this.journal.reserveFileDirectory(binding)
    return { id: reserved.id, root: this.parent }
  }

  async prepareDirectory(binding: WorkerConversationBinding, id: string, path: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const reserved = await this.journal.reserveFileDirectory(binding)
    if (reserved.id !== id || path !== join(this.parent, id)) changed()
    await mkdir(this.parent, { recursive: true, mode: 0o700 })
    const parent = await openPrivateRoot(this.parent)
    try {
      const child = await openChildDirectory(parent, id, true)
      try {
        await this.journal.fileDirectoryCreated(binding, id, await identity(child))
        await child.sync()
        await parent.sync()
      } finally { await child.close() }
    } finally { await parent.close() }
  }

  private async turnParent(binding: WorkerConversationBinding, directoryId?: string) {
    const parent = await openPrivateRoot(this.parent)
    if (!directoryId) return parent
    try {
      const expected = (await this.journal.read(binding))?.openCodeFileDirectory
      if (expected?.id !== directoryId || !expected.filesystem) changed()
      const directory = await openChildDirectory(parent, directoryId)
      try {
        if (!isDeepStrictEqual(expected.filesystem, await identity(directory))) changed()
        return directory
      } catch (error) {
        await directory.close()
        throw error
      }
    } finally { await parent.close() }
  }

  async create(binding: WorkerConversationBinding, correlationId: string, nativeSessionId: string) {
    const reserved = await this.journal.reserveFileRoot(binding, correlationId, nativeSessionId)
    await mkdir(this.parent, { recursive: true, mode: 0o700 })
    const parent = await this.turnParent(binding, reserved.directoryId)
    try {
      const child = await openChildDirectory(parent, reserved.id, true)
      try {
        const filesystem = await identity(child)
        const root = await this.journal.fileRootCreated(binding, reserved.id, filesystem)
        await child.sync()
        await parent.sync()
        return { path: join(this.parent, ...(reserved.directoryId ? [reserved.directoryId] : []), reserved.id), record: root }
      } finally { await child.close() }
    } finally { await parent.close() }
  }

  async release(binding: WorkerConversationBinding, root: WorkerOpenCodeFileRoot,
    options: { closedProcess: boolean; signal: AbortSignal; recoverVersions?: RecoverVersions | undefined }) {
    options.signal.throwIfAborted()
    let parent: FileHandle
    try { parent = await this.turnParent(binding, root.directoryId) }
    catch (error) {
      if (!missing(error)) throw error
      await this.journal.fileRootRemoved(binding, root.id)
      return
    }
    try {
      let child: FileHandle
      try { child = await openChildDirectory(parent, root.id) }
      catch (error) {
        if (!missing(error)) throw error
        await this.journal.fileRootRemoved(binding, root.id)
        return
      }
      try {
        if (root.filesystem && !isDeepStrictEqual(root.filesystem, await identity(child))) changed()
        // A reserved directory has no materialized bytes; only its empty mkdir can survive this crash cut.
        if (!root.filesystem && (await readdir(anchored(child))).length) changed()
        if (options.closedProcess && root.filesystem) {
          try { await assertVersionsRecovered(child, options.signal) }
          catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'WORKER_FILE_VERSION_RECOVERY_REQUIRED'
              || !options.recoverVersions) throw error
            await options.recoverVersions(root, child, options.signal)
            await assertVersionsRecovered(child, options.signal)
          }
          await removeContents(child, options.signal)
        }
      } finally { await child.close() }
      await rmdir(anchored(parent, root.id))
      await parent.sync()
      await this.journal.fileRootRemoved(binding, root.id)
    } finally { await parent.close() }
  }

  async cleanupClosed(record: WorkerConversationReceipt,
    registry: Pick<NativeProcessRegistry, 'snapshot'>, signal: AbortSignal, recoverVersions?: RecoverVersions) {
    if (!record.openCodeFileDirectory && !record.openCodeFileRoots?.length) return
    const owner = record.nativeOwner
    const launches = registry.snapshot().launches.filter(launch => launch.owner === `conversation:${record.binding.owner.conversationId}`)
    const original = owner && launches.filter(launch => launch.guardian && launch.provider && launch.boundary
      && workerConversationProcessDigest(record.binding, launch) === owner.processIdentityDigest)
    if ((record.openCodeFileRoots?.length && !owner) || (owner && original?.length !== 1) || !launches.length
      || launches.some(launch => launch.lifecycle !== 'closed' || !launch.closureEvidence)) changed()
    for (const root of record.openCodeFileRoots ?? []) {
      if (root.nativeSessionId !== owner?.sessionId) changed()
      await this.release(record.binding, root, { closedProcess: true, signal, recoverVersions })
    }
    const directory = record.openCodeFileDirectory
    if (!directory) return
    if ((await this.journal.read(record.binding))?.openCodeFileRoots?.length) return
    await this.removeDirectory(record.binding, directory)
  }

  private async removeDirectory(binding: WorkerConversationBinding,
    directory: NonNullable<WorkerConversationReceipt['openCodeFileDirectory']>) {
    let parent: FileHandle
    try { parent = await openPrivateRoot(this.parent) }
    catch (error) {
      if (!missing(error)) throw error
      await this.journal.fileDirectoryRemoved(binding, directory.id)
      return
    }
    try {
      let child: FileHandle
      try { child = await openChildDirectory(parent, directory.id) }
      catch (error) {
        if (!missing(error)) throw error
        await this.journal.fileDirectoryRemoved(binding, directory.id)
        return
      }
      try {
        if (directory.filesystem && !isDeepStrictEqual(directory.filesystem, await identity(child))) changed()
        if ((await readdir(anchored(child))).length) changed()
      } finally { await child.close() }
      await rmdir(anchored(parent, directory.id))
      await parent.sync()
      await this.journal.fileDirectoryRemoved(binding, directory.id)
    } finally { await parent.close() }
  }
}
