import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { open, opendir, readFile, type FileHandle } from 'node:fs/promises'
import type { ApprovedRootAllowlist, WorkspaceRootBrowseResult, WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'
import { RootFilesystemIdentitySchema } from '@foreman-code/contracts/workspace-root-policies'
import { TestWorkerOperationError } from './workerExtensions.js'

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

/** Kernel facts for this owned descriptor, including its actual Linux mount identity. */
export async function workerDirectoryIdentity(directory: FileHandle) {
  if (process.platform !== 'linux' || process.getuid === undefined) {
    throw new Error('The native worker directory fixture requires Linux descriptor identity support.')
  }
  const info = await directory.stat({ bigint: true })
  if (!info.isDirectory()) throw new Error('Worker filesystem identity must describe a directory.')
  const descriptor = await readFile(`/proc/self/fdinfo/${directory.fd}`, 'utf8')
  const mount = /^mnt_id:\s+([0-9]+)$/m.exec(descriptor)
  if (!mount) throw new Error('The owned directory has no kernel mount identity.')
  return RootFilesystemIdentitySchema.parse({ device: String(info.dev), inode: String(info.ino), mountId: mount[1] })
}

export async function readWorkerDirectoryIdentity(path: string) {
  const directory = await open(path, directoryFlags)
  try { return await workerDirectoryIdentity(directory) }
  finally { await directory.close() }
}

function validRelativeDirectory(value: string): boolean {
  if (value === '') return true
  return value.length <= 1024 && value.normalize('NFC') === value && !value.startsWith('/') && !/[\\:]/.test(value)
    && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && value.split('/').length <= 32
    && value.split('/').every(component => component !== '' && component !== '.' && component !== '..' && !/[. ]$/.test(component))
}

function approvedBase(configuration: ApprovedRootAllowlist, selection: WorkspaceRootSelection) {
  if (selection.hostRef.kind !== 'device' || configuration.hostRef.kind !== 'device'
    || selection.hostRef.mainId !== configuration.hostRef.mainId || selection.hostRef.deviceId !== configuration.hostRef.deviceId
    || selection.configurationRevision !== configuration.configurationRevision) {
    throw new TestWorkerOperationError('ROOT_CONFIGURATION_CONFLICT')
  }
  const base = configuration.bases.find(value => value.baseId === selection.allowedBaseId)
  if (!base || !base.accessModes.includes(selection.accessMode)) throw new TestWorkerOperationError('ROOT_ACCESS_DENIED')
  if (!validRelativeDirectory(selection.relativePath)) throw new TestWorkerOperationError('ROOT_RELATIVE_PATH_INVALID')
  return base
}

async function openSelectedDirectory(base: ApprovedRootAllowlist['bases'][number], relativePath: string) {
  let directory = await open(base.canonicalPath, directoryFlags)
  try {
    const baseInfo = await directory.stat()
    if (baseInfo.uid !== process.getuid?.() || (baseInfo.mode & 0o022) !== 0 || (baseInfo.mode & 0o500) !== 0o500) {
      throw new TestWorkerOperationError('SOURCE_ROOT_NOT_PRIVATE')
    }
    let privatePrefix = (baseInfo.mode & 0o077) === 0
    const identity = await workerDirectoryIdentity(directory)
    if (identity.device !== base.filesystem.device || identity.inode !== base.filesystem.inode
      || identity.mountId !== base.filesystem.mountId) throw new TestWorkerOperationError('ROOT_BASE_CHANGED')
    for (const component of relativePath.split('/').filter(Boolean)) {
      const next = await open(`/proc/self/fd/${directory.fd}/${component}`, directoryFlags)
      try {
        const info = await next.stat()
        const current = await workerDirectoryIdentity(next)
        if (info.uid !== process.getuid?.() || !privatePrefix && (info.mode & 0o022) !== 0
          || current.device !== identity.device || current.mountId !== identity.mountId) {
          throw new TestWorkerOperationError('ROOT_FILESYSTEM_UNSUPPORTED')
        }
        privatePrefix ||= (info.mode & 0o077) === 0
      } catch (error) { await next.close(); throw error }
      await directory.close()
      directory = next
    }
    return directory
  } catch (error) { await directory.close(); throw error }
}

/** Performs an actual bounded directory read; no scripted answer or host-path request is accepted. */
export async function browseWorkerDirectories(configuration: ApprovedRootAllowlist, selection: WorkspaceRootSelection,
  relativePath: string, signal: AbortSignal): Promise<WorkspaceRootBrowseResult> {
  signal.throwIfAborted()
  const base = approvedBase(configuration, selection)
  if (!validRelativeDirectory(relativePath)) throw new TestWorkerOperationError('ROOT_RELATIVE_PATH_INVALID')
  const directory = await openSelectedDirectory(base, relativePath)
  try {
    const entries = await opendir(`/proc/self/fd/${directory.fd}`)
    const directories: WorkspaceRootBrowseResult['directories'] = []
    let scanned = 0
    let truncated = false
    for await (const entry of entries) {
      signal.throwIfAborted()
      if (++scanned > 4096 || directories.length === 256) { truncated = true; break }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const child = relativePath ? `${relativePath}/${entry.name}` : entry.name
      if (!validRelativeDirectory(child)) continue
      directories.push({ name: entry.name, relativePath: child })
    }
    directories.sort((left, right) => left.name.localeCompare(right.name))
    assert.equal(new Set(directories.map(value => value.relativePath)).size, directories.length)
    return { relativePath, directories, truncated }
  } finally { await directory.close() }
}
