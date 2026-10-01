import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import type { AcceptedJobSpec } from '@graphql/contracts'

export class JobOutputCollectionError extends Error {}

/** Called by W09 only after container/descendant quiescence is positively proven. */
export async function readDeclaredJobOutputs(root: string, spec: AcceptedJobSpec): Promise<Array<{ path: string; bytes: Buffer }>> {
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(error => { throw new JobOutputCollectionError('Declared Job output root unavailable.', { cause: error }) })
  const outputs: Array<{ path: string; bytes: Buffer }> = []
  let total = 0
  try {
    for (const output of spec.outputs) {
      const directories: FileHandle[] = []
      let file: FileHandle | undefined
      try {
        let parent = rootHandle
        const parts = output.path.split('/')
        if (parts.some(part => !part || part === '.' || part === '..') || output.path.startsWith('/') || output.path.includes('\\')) {
          throw new Error('Invalid declared output path.')
        }
        for (const part of parts.slice(0, -1)) {
          parent = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          directories.push(parent)
        }
        file = await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)!}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > spec.policy.maxOutputBytes - total) throw new Error('Output type or byte budget rejected.')
        const bytes = Buffer.alloc(stat.size)
        let offset = 0
        while (offset < bytes.length) {
          const read = await file.read(bytes, offset, bytes.length - offset, offset)
          if (!read.bytesRead) throw new Error('Output changed during collection.')
          offset += read.bytesRead
        }
        const after = await file.stat()
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Output changed during collection.')
        total += bytes.length
        outputs.push({ path: output.path, bytes })
      } catch (error) {
        if (output.required || !(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      } finally {
        await file?.close()
        await Promise.all(directories.map(directory => directory.close()))
      }
    }
    return outputs
  } catch (error) { throw new JobOutputCollectionError(error instanceof Error && !('code' in error) ? error.message : 'Declared Job output collection failed.', { cause: error }) } finally { await rootHandle.close() }
}
