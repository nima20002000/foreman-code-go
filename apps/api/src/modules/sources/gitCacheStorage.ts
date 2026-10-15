import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, statfs, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { SOURCE_GIT_CACHE_LIMITS, GitCacheStorageSchema, type GitCacheStorage }
  from '@foreman-code/contracts/source-materialization'
import { DomainError } from '../errors.js'
import { anchored, identity, openPrivateRoot, withPrivateDirectoryLock } from './privateFilesystem.js'
import { measureRetainedDirectory } from './retainedDirectoryUsage.js'
import { writeSourceClaim } from './quotaClaims.js'
import type { GitProcessOptions, GitProcessResult } from './gitProcess.js'

type GitRunner = (args: string[], options: GitProcessOptions) => Promise<GitProcessResult>

function commandIndex(args: string[]): number {
  let index = 0
  while (args[index]?.startsWith('-')) {
    index += ['-c', '-C', '--git-dir', '--work-tree'].includes(args[index]!) ? 2 : 1
  }
  return index
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || !suffix.startsWith('..') && !isAbsolute(suffix)
}

async function writeStorage(root: FileHandle, storage: GitCacheStorage): Promise<void> {
  const name = `storage-${randomUUID()}.pending`
  await writeSourceClaim(root, name, JSON.stringify(GitCacheStorageSchema.parse(storage)))
  await rename(anchored(root, name), anchored(root, 'storage.json'))
  await root.sync()
}

async function measureStorage(root: FileHandle, signal?: AbortSignal): Promise<GitCacheStorage> {
  const filesystem = await identity(root)
  for (;;) {
    signal?.throwIfAborted()
    let retainedBytes: number
    try {
      retainedBytes = await measureRetainedDirectory(root, filesystem)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // Clone publication and cleanup can rename or remove staging entries outside the transfer lock.
      // Rescan the whole cache so published bytes are still counted under their new names.
      continue
    }
    const disk = await statfs(anchored(root), { bigint: true })
    return GitCacheStorageSchema.parse({ version: 1, filesystem, retainedBytes,
      reservedBytes: 0, limitBytes: Math.min(SOURCE_GIT_CACHE_LIMITS.bytes, Number(disk.blocks * disk.bsize / 4n)),
      availableBytes: Number(disk.bavail * disk.bsize), observedAt: new Date().toISOString() })
  }
}

async function packFiles(common: string): Promise<string[]> {
  try { return await readdir(resolve(common, 'objects', 'pack')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Failed fetches retain published objects and branches; only this transfer's incomplete pack files are removed. */
async function removeIncompletePacks(common: string, before: string[]): Promise<void> {
  for (const name of await packFiles(common)) {
    if (!before.includes(name) && /^tmp_(?:pack|idx|rev)_/u.test(name)) {
      await unlink(resolve(common, 'objects', 'pack', name))
    }
  }
}

function boundedArgs(args: string[], index: number): string[] {
  const command = args[index]!
  const flags = command === 'clone'
    ? ['--no-local', '--no-checkout', '--depth=1', '--single-branch', '--no-tags']
    : ['--no-auto-maintenance', '--recurse-submodules=no',
      ...(args.slice(index + 1).includes('origin') ? ['--depth=1'] : [])]
  // A single pack and its index fit the reserved transfer budget under the inherited per-file kernel limit.
  return ['-c', 'fetch.unpackLimit=1', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    '-c', 'fetch.writeCommitGraph=false', '-c', 'pack.writeReverseIndex=false', '-c', 'fetch.uriprotocols=',
    ...args.slice(0, index + 1), ...flags, ...args.slice(index + 1)]
}

/** Start time of a process, so a reused process id is not mistaken for the reservation's owner. */
async function processStart(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
    throw error
  }
}

/** Counts the transfers still owned by a running process; the storage lock is held. Records of dead owners are removed. */
async function liveReservations(root: FileHandle): Promise<number> {
  let live = 0
  for (const name of await readdir(anchored(root))) {
    if (!/^transfer-.+\.reservation$/u.test(name)) continue
    let owner: { pid?: unknown; started?: unknown } = {}
    try { owner = JSON.parse(await readFile(anchored(root, name), 'utf8')) as typeof owner }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      // An interrupted write left no owner; the record is reclaimed below.
    }
    if (typeof owner.pid === 'number' && await processStart(owner.pid) === owner.started) live++
    else await rm(anchored(root, name), { force: true })
  }
  return live
}

/** Holds the storage lock only while measuring and reserving this transfer's footprint beside the running transfers. */
async function reserveTransfer(root: FileHandle, signal: AbortSignal): Promise<string> {
  const name = `transfer-${randomUUID()}.reservation`
  await withPrivateDirectoryLock(root, async () => {
    const measured = await measureStorage(root, signal)
    const reservedBytes = SOURCE_GIT_CACHE_LIMITS.transferBytes
    const active = await liveReservations(root) * reservedBytes
    const margin = Math.max(SOURCE_GIT_CACHE_LIMITS.diskMarginBytes, Math.ceil(measured.availableBytes * 0.1))
    await writeStorage(root, { ...measured, reservedBytes: active })
    if (measured.retainedBytes + active + reservedBytes > measured.limitBytes
      || active + reservedBytes + margin > measured.availableBytes) {
      throw new DomainError('SOURCE_GIT_CACHE_CAPACITY',
        'The Git cache has insufficient storage for this transfer. Free cache filesystem space, then retry.',
        409, { retryable: true, newCommandRequired: false, storage: measured, reservedBytes })
    }
    await writeSourceClaim(root, name, JSON.stringify({ pid: process.pid, started: await processStart(process.pid) }))
    await writeStorage(root, { ...measured, reservedBytes: active + reservedBytes })
  }, { signal })
  return name
}

async function releaseTransfer(root: FileHandle, name: string): Promise<void> {
  const measured = await measureStorage(root)
  await withPrivateDirectoryLock(root, async () => {
    await rm(anchored(root, name), { force: true })
    await writeStorage(root, { ...measured,
      reservedBytes: await liveReservations(root) * SOURCE_GIT_CACHE_LIMITS.transferBytes })
  })
}

/** Reserve each transfer's maximum footprint on the cache's actual filesystem; fetches into one repository take turns. */
export async function runGitWithCacheStorage(cacheRoot: string, args: string[], options: GitProcessOptions,
  run: GitRunner): Promise<GitProcessResult> {
  const index = commandIndex(args)
  const command = args[index]
  if (command !== 'clone' && command !== 'fetch') return run(args, options)
  options.signal.throwIfAborted()
  let target: string
  let common: string
  let createdTarget = false
  if (command === 'clone') {
    target = resolve(options.cwd ?? process.cwd(), args.at(-1)!)
    common = resolve(target, '.git')
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  } else {
    const located = await run(['rev-parse', '--path-format=absolute', '--git-common-dir'], options)
    if (located.code !== 0) return located
    common = located.stdout.trim()
    if (!isAbsolute(common)) throw new DomainError('SOURCE_GIT_CACHE_INVALID', 'Git cache identity is unavailable.', 409)
    target = common
  }
  let storagePath = cacheRoot
  if (!inside(cacheRoot, target)) {
    storagePath = command === 'clone' ? dirname(target) : common
  }
  const root = await openPrivateRoot(storagePath, false)
  try {
    const reservation = await reserveTransfer(root, options.signal)
    try {
      // Clones write a private staging directory; only fetches share a repository, so only they wait for each other.
      const transfer = async (lockFd?: number) => {
        const before = command === 'fetch' ? await packFiles(common) : []
        if (command === 'clone') {
          try { await lstat(target) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            createdTarget = true
          }
        }
        let result: GitProcessResult | undefined
        try {
          result = await run(boundedArgs(args, index), { ...options,
            maximumFileBytes: SOURCE_GIT_CACHE_LIMITS.maximumFileBytes, ...(lockFd !== undefined ? { lockFd } : {}) })
          return result
        } finally {
          if (!result || result.code !== 0) {
            if (command === 'clone' && createdTarget) await rm(target, { recursive: true, force: true })
            else if (command === 'fetch') await removeIncompletePacks(common, before)
          }
        }
      }
      if (command === 'clone') return await transfer()
      const repository = storagePath === common ? root : await openPrivateRoot(common, false)
      try {
        return await withPrivateDirectoryLock(repository, guard => transfer(guard.fd), { signal: options.signal })
      } finally {
        if (repository !== root) await repository.close()
      }
    } finally {
      await releaseTransfer(root, reservation)
    }
  } finally {
    await root.close()
  }
}
