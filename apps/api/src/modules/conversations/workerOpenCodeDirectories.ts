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

/** Keeps native scratch ownership in the existing worker journal, including crash cuts before materialization. */
export class WorkerOpenCodeDirectories {
  private readonly parent: string
  constructor(stateDirectory: string, private readonly journal: WorkerConversationJournal) {
    this.parent = join(stateDirectory, 'opencode-chat-files')
  }

  async create(binding: WorkerConversationBinding, correlationId: string, nativeSessionId: string) {
    const reserved = await this.journal.reserveFileRoot(binding, correlationId, nativeSessionId)
    await mkdir(this.parent, { recursive: true, mode: 0o700 })
    const parent = await openPrivateRoot(this.parent)
    try {
      const child = await openChildDirectory(parent, reserved.id, true)
      try {
        const filesystem = await identity(child)
        const root = await this.journal.fileRootCreated(binding, reserved.id, filesystem)
        await child.sync()
        await parent.sync()
        return { path: join(this.parent, reserved.id), record: root }
      } finally { await child.close() }
    } finally { await parent.close() }
  }

  async release(binding: WorkerConversationBinding, root: WorkerOpenCodeFileRoot,
    options: { closedProcess: boolean; signal: AbortSignal }) {
    options.signal.throwIfAborted()
    let parent: FileHandle
    try { parent = await openPrivateRoot(this.parent) }
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
        if (options.closedProcess && root.filesystem) await removeContents(child, options.signal)
      } finally { await child.close() }
      await rmdir(anchored(parent, root.id))
      await parent.sync()
      await this.journal.fileRootRemoved(binding, root.id)
    } finally { await parent.close() }
  }

  async cleanupClosed(record: WorkerConversationReceipt,
    registry: Pick<NativeProcessRegistry, 'snapshot'>, signal: AbortSignal) {
    if (!record.openCodeFileRoots?.length) return
    const owner = record.nativeOwner
    const launches = registry.snapshot().launches.filter(launch => launch.owner === `conversation:${record.binding.owner.conversationId}`)
    const original = owner && launches.filter(launch => launch.guardian && launch.provider && launch.boundary
      && workerConversationProcessDigest(record.binding, launch) === owner.processIdentityDigest)
    if (!owner || original?.length !== 1 || !launches.length
      || launches.some(launch => launch.lifecycle !== 'closed' || !launch.closureEvidence)) changed()
    for (const root of record.openCodeFileRoots) {
      if (root.nativeSessionId !== owner.sessionId) changed()
      await this.release(record.binding, root, { closedProcess: true, signal })
    }
  }
}
