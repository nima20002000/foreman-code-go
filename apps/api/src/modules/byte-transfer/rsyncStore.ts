import { constants } from 'node:fs'
import { open, mkdir, lstat, unlink, rmdir, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, parse, sep } from 'node:path'
import { BYTE_TRANSFER_POLICY as POLICY, TransferIntentSchema, type TransferIntent } from '@graphql/contracts/byte-transfer'
import type { RsyncReceiverLease, RsyncSnapshot, RsyncStagedBytes } from './rsync.js'

export interface RsyncQuota {
  /** Existing app supervisor persists aggregate/device reservations, retries and TTL. No second ledger. */
  reserve(intent: TransferIntent): Promise<() => Promise<void>>
  /** Idempotent supervisor release after trusted retirement, including retained source/partial bytes. */
  retire(intent: TransferIntent): Promise<void>
}
async function regular(path: string, flags: number) {
  const handle = await open(path, flags | constants.O_NOFOLLOW, 0o600)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('Unsafe staging file')
    return handle
  } catch (error) { await handle.close(); throw error }
}
async function verify(handle: FileHandle, intent: TransferIntent, signal: AbortSignal) {
  const size = (await handle.stat()).size
  if (size !== intent.byteSize) throw new Error('Rsync byte length mismatch')
  const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(POLICY.maxChunkBytes, Math.max(1, size)))
  for (let offset = 0; offset < size;) {
    signal.throwIfAborted()
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
    if (!bytesRead) throw new Error('Missing staging bytes')
    hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
  }
  signal.throwIfAborted()
  if (hash.digest('hex') !== intent.sha256) throw new Error('Rsync SHA-256 mismatch')
}
/** Linux app-private store. Same-uid peers must not have access to this directory.
 * Local helpers also run on the worker through its existing authenticated control port.
 * No SSH grants, daemon, canonical storage, scheduler or publication state is created. */
export class RsyncPrivateStore {
  constructor(readonly root: string, private readonly quota: RsyncQuota) {}
  private async directory() {
    if (!this.root.startsWith('/') || this.root.split('/').some(x => x === '..' || x === '.')) throw new Error('Unsafe staging root')
    let path = parse(this.root).root
    for (const part of this.root.slice(path.length).split(sep).filter(Boolean)) {
      path = join(path, part)
      await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== process.getuid?.())
        || ((stat.mode & 0o022) && !(stat.mode & 0o1000))) throw new Error('Unsafe staging ancestor')
    }
    const stat = await lstat(this.root)
    if ((stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('Staging root must be private')
    const handle = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const pinned = await handle.stat()
    if (pinned.ino !== stat.ino || pinned.dev !== stat.dev) { await handle.close(); throw new Error('Staging root changed') }
    return handle
  }
  private async identity(directory: FileHandle, input: TransferIntent) {
    const intent = TransferIntentSchema.parse(input), path = `/proc/self/fd/${directory.fd}/${intent.transferId}.intent`
    let handle: FileHandle
    try {
      handle = await regular(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
      try { await handle.writeFile(JSON.stringify(intent)); await handle.sync(); await directory.sync() }
      finally { await handle.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      handle = await regular(path, constants.O_RDONLY)
      try {
        if ((await handle.stat()).size > 16384 || JSON.stringify(TransferIntentSchema.parse(JSON.parse(await handle.readFile('utf8')))) !== JSON.stringify(intent)) throw new Error('Transfer immutable identity conflicts', { cause: error })
      } finally { await handle.close() }
    }
    return intent
  }
  /** Copy from an already authorized source FD; verify expected hash before exposing snapshot. */
  async freeze(input: TransferIntent, source: FileHandle, signal: AbortSignal): Promise<RsyncSnapshot> {
    const directory = await this.directory(), intent = TransferIntentSchema.parse(input)
    const path = `/proc/self/fd/${directory.fd}/${intent.transferId}.snapshot`
    let handle: FileHandle | undefined
    try {
      await this.identity(directory, intent)
      await this.quota.reserve(intent)
      try { handle = await regular(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        handle = await regular(path, constants.O_RDONLY)
        await verify(handle, intent, signal)
        return { verify: bounded => verify(handle!, intent, bounded), close: async () => { await handle!.close(); await directory.close() } }
      }
      const buffer = Buffer.alloc(Math.min(POLICY.maxChunkBytes, Math.max(1, intent.byteSize)))
      for (let offset = 0; offset < intent.byteSize;) {
        signal.throwIfAborted()
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, intent.byteSize - offset), offset)
        if (!bytesRead) throw new Error('Source length changed')
        let written = 0
        while (written < bytesRead) {
          const result = await handle.write(buffer, written, bytesRead - written, offset + written)
          if (!result.bytesWritten) throw new Error('Snapshot write stalled')
          written += result.bytesWritten
        }
        offset += bytesRead
      }
      if ((await source.stat()).size !== intent.byteSize) throw new Error('Source length changed')
      await verify(handle, intent, signal); await handle.chmod(0o400); await handle.sync(); await directory.sync()
      return { verify: bounded => verify(handle!, intent, bounded), close: async () => { await handle!.close(); await directory.close() } }
    } catch (error) {
      await handle?.close(); await directory.close()
      // Failed snapshots remain fail-closed. Trusted cleanup after stopped-owner reconciliation can retire them.
      throw error
    }
  }
  async receive(input: TransferIntent, signal: AbortSignal): Promise<RsyncReceiverLease> {
    signal.throwIfAborted()
    const directory = await this.directory(), intent = TransferIntentSchema.parse(input)
    const base = `/proc/self/fd/${directory.fd}/${intent.transferId}`
    let reserved: (() => Promise<void>) | undefined, locked = false
    try {
      await mkdir(`${base}.lock`, { mode: 0o700 }); locked = true
      await this.identity(directory, intent)
      const partial = `/proc/self/fd/${directory.fd}/.rsync-partial`
      await mkdir(partial, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      const partialStat = await lstat(partial)
      if (!partialStat.isDirectory() || partialStat.isSymbolicLink() || (partialStat.mode & 0o077)
        || partialStat.uid !== process.getuid?.()) throw new Error('Unsafe rsync partial directory')
      reserved = await this.quota.reserve(intent)
      let handle: FileHandle
      try { handle = await regular(`${base}.part`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; handle = await regular(`${base}.part`, constants.O_RDONLY) }
      await handle.close(); await directory.sync()
      let closed = false
      const unlock = async () => { await rmdir(`${base}.lock`); await directory.sync(); await directory.close() }
      return {
        interrupt: async () => { if (closed) return; closed = true; await unlock() },
        verify: async bounded => {
          if (closed) throw new Error('Receiver lease closed')
          bounded.throwIfAborted()
          const current = await lstat(this.root), pinned = await directory.stat()
          if (current.ino !== pinned.ino || current.dev !== pinned.dev || current.isSymbolicLink()) throw new Error('Staging root changed')
          const bytes = await regular(`${base}.part`, constants.O_RDONLY)
          try { await verify(bytes, intent, bounded); await bytes.sync(); await directory.sync() }
          catch (error) { await bytes.close(); throw error }
          closed = true
          let disposed = false
          const staged: RsyncStagedBytes = { intent, sha256: intent.sha256, byteSize: intent.byteSize,
            read: async (offset, length, readSignal) => {
              if (disposed) throw new Error('Staging bytes closed')
              if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1
                || length > POLICY.maxChunkBytes || offset + length > intent.byteSize) throw new Error('Invalid staging read')
              await verify(bytes, intent, readSignal)
              const buffer = Buffer.alloc(length), result = await bytes.read(buffer, 0, length, offset)
              if (result.bytesRead !== length) throw new Error('Staging bytes changed')
              return buffer
            },
            close: async () => {
              if (disposed) return; disposed = true
              try { await bytes.close(); await unlink(`${base}.part`); await reserved!() }
              finally { await unlock() }
            } }
          return staged
        },
      }
    } catch (error) {
      try { await reserved?.() } finally { if (locked) await rmdir(`${base}.lock`); await directory.close() }
      throw error
    }
  }
  /** Called only by the existing cleanup supervisor after writer-death/expiry or canonical acknowledgment.
   * Locks are never stolen by age. Partial reservations are released by the same quota supervisor. */
  async retire(input: TransferIntent) {
    const directory = await this.directory()
    try {
      const intent = await this.identity(directory, input), base = `/proc/self/fd/${directory.fd}/${intent.transferId}`
      await mkdir(`${base}.lock`, { mode: 0o700 })
      try {
        for (const suffix of ['part', 'snapshot', ...(Date.now() >= Date.parse(intent.expiresAt) ? ['intent'] : [])]) await unlink(`${base}.${suffix}`).catch(error => { if (error.code !== 'ENOENT') throw error })
        await unlink(`/proc/self/fd/${directory.fd}/.rsync-partial/${intent.transferId}.part`).catch(error => { if (error.code !== 'ENOENT') throw error })
        await directory.sync(); await this.quota.retire(intent)
      } finally { await rmdir(`${base}.lock`) }
    } finally { await directory.close() }
  }
}
