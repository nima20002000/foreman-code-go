import { lstat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { checkFileCondition } from '../harnesses/opencodeFiles/types.js'
import type { OpenCodeServerController } from '../harnesses/opencodeTransport.js'

/** A paired worker receives copies over execution-v1, never a mount of Main's vault. */
export async function assertWorkerOpenCodeFileHost(server: OpenCodeServerController, protectedRoot: string,
  source: { bootId: string; storageRoot: string }, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  checkFileCondition(isAbsolute(source.storageRoot) && normalize(source.storageRoot) === source.storageRoot,
    'FILE_SOURCE_ISOLATION_REQUIRED', 'The file source requires a canonical storage directory.')
  checkFileCondition(server.assertFileSourceIsolation, 'FILE_SOURCE_ISOLATION_REQUIRED',
    'The native server must verify its protected mount namespace.')
  await server.assertFileSourceIsolation(protectedRoot, signal)
  if (source.storageRoot === protectedRoot) return
  if (source.bootId !== bootIdentity()) {
    try { await lstat(source.storageRoot) }
    catch (error) {
      // The native mount namespace was checked above. An absent remote vault has no local source bytes.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        signal.throwIfAborted()
        return
      }
      throw error
    }
  }
  checkFileCondition(false, 'FILE_SOURCE_ISOLATION_REQUIRED', 'The local source vault is outside the protected namespace.')
}
