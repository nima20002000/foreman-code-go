import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rmdir, type FileHandle } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { assertDirectoryEntry, openDirectory, removeDirectoryContents } from './host.js'
import { checkFileCondition } from './types.js'

export interface OpenCodeDirectoryOwnership {
  path: string
  dev: string
  ino: string
  parentDev: string
  parentIno: string
  quarantine: string
}
const at = (directory: FileHandle, name: string) => `/proc/self/fd/${directory.fd}/${name}`
const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

export async function ownOpenCodeDirectory(path: string): Promise<OpenCodeDirectoryOwnership> {
  const parent = await openDirectory(dirname(path))
  const directory = await openDirectory(path)
  try {
    await assertDirectoryEntry(parent, basename(path), directory)
    const [held, outer] = await Promise.all([directory.stat({ bigint: true }), parent.stat({ bigint: true })])
    return { path, dev: String(held.dev), ino: String(held.ino), parentDev: String(outer.dev),
      parentIno: String(outer.ino), quarantine: `.cleanup-${randomUUID()}` }
  } finally {
    await directory.close()
    await parent.close()
  }
}

async function present(path: string) {
  try { return await lstat(path, { bigint: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function cleanupOpenCodeDirectory(owned: OpenCodeDirectoryOwnership): Promise<void> {
  checkFileCondition(/^\.cleanup-[0-9a-f-]{36}$/.test(owned.quarantine),
    'FILE_CLEANUP_REQUIRED', 'The cleanup directory must have a registered name.')
  const parent = await openDirectory(dirname(owned.path))
  try {
    const outer = await parent.stat({ bigint: true })
    checkFileCondition(String(outer.dev) === owned.parentDev && String(outer.ino) === owned.parentIno,
      'FILE_CLEANUP_REQUIRED', 'The owned turn parent directory changed.')
    const name = basename(owned.path)
    const original = await present(at(parent, name))
    const quarantinePath = at(parent, owned.quarantine)
    if (!original && !await present(quarantinePath)) return
    if (original) {
      checkFileCondition(original.isDirectory() && String(original.dev) === owned.dev && String(original.ino) === owned.ino,
        'FILE_CLEANUP_REQUIRED', 'Do not remove a replacement turn directory.')
    }
    try { await mkdir(quarantinePath, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const quarantine = await open(quarantinePath, flags)
    try {
      if (original) {
        checkFileCondition(!await present(at(quarantine, 'files')),
          'FILE_CLEANUP_REQUIRED', 'Conflicting cleanup directories must be retained.')
        await rename(at(parent, name), at(quarantine, 'files'))
        await parent.sync()
        await quarantine.sync()
      }
      const moved = await present(at(quarantine, 'files'))
      if (moved) {
        checkFileCondition(moved.isDirectory() && String(moved.dev) === owned.dev && String(moved.ino) === owned.ino,
          'FILE_CLEANUP_REQUIRED', 'Do not traverse a replacement cleanup directory.')
        const files = await open(at(quarantine, 'files'), flags)
        try {
          await assertDirectoryEntry(quarantine, 'files', files)
          await removeDirectoryContents(files)
          await assertDirectoryEntry(quarantine, 'files', files)
          await rmdir(at(quarantine, 'files'))
          await quarantine.sync()
        } finally {
          await files.close()
        }
      }
      await assertDirectoryEntry(parent, owned.quarantine, quarantine)
      await rmdir(quarantinePath)
      await parent.sync()
    } finally {
      await quarantine.close()
    }
  } finally {
    await parent.close()
  }
}
