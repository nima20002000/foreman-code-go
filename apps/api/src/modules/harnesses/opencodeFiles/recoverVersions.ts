import { constants } from 'node:fs'
import { lstat, open, readdir, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import type { FileRevision } from '@foreman-code/contracts/files'
import type { AgentFileToolService } from '../../files/tools/service.js'
import type { FileToolContext } from '../../files/tools/types.js'
import type { OpenCodeDirectoryOwnership } from './cleanup.js'
import { openDirectory, readOpenCodeFileSnapshot, recoveredOpenCodeVersion } from './host.js'
import { checkFileCondition } from './types.js'

const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const at = (directory: FileHandle, name: string) => `/proc/self/fd/${directory.fd}/${name}`
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
export type OpenCodeVersionRecoveryService = Pick<AgentFileToolService, 'preserveAccepted'> & {
  sessions: Pick<AgentFileToolService['sessions'], 'authorizeAccepted'>
  artifacts: Pick<AgentFileToolService['artifacts'], 'get'>
}

export async function recoverOpenCodeVersions(service: AgentFileToolService, context: FileToolContext,
  owned: OpenCodeDirectoryOwnership, maxFileBytes: number, signal: AbortSignal): Promise<void> {
  let root: FileHandle
  try { root = await openDirectory(owned.path) }
  catch (error) {
    if (!missing(error)) throw error
    try { root = await openDirectory(join(dirname(owned.path), owned.quarantine, 'files')) }
    catch (error) {
      if (missing(error)) return
      throw error
    }
  }
  try {
    const stat = await root.stat({ bigint: true })
    checkFileCondition(String(stat.dev) === owned.dev && String(stat.ino) === owned.ino,
      'FILE_CLEANUP_REQUIRED', 'Recover versions only from the registered turn directory.')
    for (const handle of await readdir(at(root, '.'))) {
      if (!/^[0-9a-f-]{36}$/.test(handle)) continue
      if (!(await lstat(at(root, handle))).isDirectory()) continue
      const directory = await open(at(root, handle), flags)
      try {
        await recoverOpenCodeHandleVersions(service, context, handle, directory, maxFileBytes, signal)
      } finally {
        await directory.close()
      }
    }
  } finally {
    await root.close()
  }
}

export async function recoverOpenCodeHandleVersions(service: OpenCodeVersionRecoveryService, context: FileToolContext,
  handle: string, directory: FileHandle, maxFileBytes: number, signal: AbortSignal): Promise<string[]> {
  const names = (await readdir(at(directory, '.'))).filter(name => /^\.versions-[0-9a-f-]{36}$/.test(name))
  if (!names.length) return []
  const caller = await service.sessions.authorizeAccepted(context, 'files.publish_result')
  const artifact = await service.artifacts.get(caller, handle)
  const filename = Buffer.byteLength(artifact.filename, 'utf8') <= 200 ? artifact.filename
    : `attachment${extname(artifact.filename).slice(0, 12)}`
  const revision: FileRevision = { fileId: handle, revisionId: handle, filename: artifact.filename,
    mediaType: artifact.mediaType, origin: 'agent_output', createdAt: artifact.createdAt,
    byteSize: 0, sha256: '0'.repeat(64) }
  const preserve = async (name: string, label: string, source: FileHandle, leaf: string) => {
    const bytes = await readOpenCodeFileSnapshot(source, leaf, maxFileBytes, signal)
    await service.preserveAccepted(context,
      recoveredOpenCodeVersion(handle, name, label, revision, filename, bytes), signal)
  }
  for (const name of names) {
    const versions = await open(at(directory, name), flags)
    try {
      for (const label of ['native', 'edited']) {
        try {
          if (!await removeDuplicateVersion(versions, label, directory, filename)) {
            await preserve(name, label, versions, label)
          }
        } catch (error) {
          if (!missing(error)) throw error
        }
      }
    } finally {
      await versions.close()
    }
  }
  try { await preserve('current', 'working-copy', directory, filename) }
  catch (error) { if (!missing(error)) throw error }
  return names
}

async function removeDuplicateVersion(versions: FileHandle, label: string,
  directory: FileHandle, filename: string): Promise<boolean> {
  const saved = await lstat(at(versions, label), { bigint: true })
  if (saved.nlink !== 2n || !saved.isFile()) return false
  let current: typeof saved
  try { current = await lstat(at(directory, filename), { bigint: true }) }
  catch (error) {
    if (missing(error)) return false
    throw error
  }
  if (saved.dev !== current.dev || saved.ino !== current.ino || !current.isFile()) return false
  // Complete the create-only replacement interrupted between link and unlink.
  await unlink(at(versions, label))
  await versions.sync()
  return true
}
