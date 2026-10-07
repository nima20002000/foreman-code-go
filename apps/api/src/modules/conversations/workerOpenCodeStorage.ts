import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkerConversationProfileFacts } from '@foreman-code/contracts/remote-execution-rpc'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { privateDirectory } from '../harnesses/recovery/storage.js'
import { OpenCodeFileError } from '../harnesses/opencodeFiles/types.js'

export async function workerOpenCodeStorageRoot(stateDirectory: string,
  source: WorkerConversationProfileFacts['fileSourceHost']) {
  if (!source) {
    throw new OpenCodeFileError('FILE_SOURCE_ISOLATION_REQUIRED', 'Main must advertise its protected file storage.')
  }
  try {
    const stat = await lstat(source.storageRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new OpenCodeFileError('FILE_SOURCE_ISOLATION_REQUIRED', 'Protect a canonical file storage directory.')
    }
    return source.storageRoot
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (source.bootId === bootIdentity()) {
      throw new OpenCodeFileError('FILE_SOURCE_ISOLATION_REQUIRED', 'The advertised local file storage is unavailable.', { cause: error })
    }
    return privateDirectory(join(stateDirectory, 'conversation-file-storage'))
  }
}
