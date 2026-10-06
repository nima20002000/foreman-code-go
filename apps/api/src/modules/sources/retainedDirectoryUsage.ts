import { constants } from 'node:fs'
import { open, readdir, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { SourceManifestSchema, type RootBinding, type MaterializationReceipt } from '@foreman-code/contracts/source-materialization'
import { anchored, identity, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'
import { SOURCE_LIMITS, SourceError } from './manifest.js'

/** Measures retained bytes only after the caller has confirmed the original writer is closed. */
export async function measureRetainedSourceDirectory(
  canonicalRoot: string, directoryId: string, expectedRoot?: RootBinding['filesystem'],
): Promise<number> {
  SourceManifestSchema.shape.snapshotId.parse(directoryId)
  const root = await openPrivateRoot(canonicalRoot)
  const rootFilesystem = await identity(root)
  let snapshot: FileHandle
  try {
    if (expectedRoot && !isDeepStrictEqual(rootFilesystem, expectedRoot)) {
      throw new SourceError('SOURCE_ROOT_CHANGED', 'Retained source storage identity changed.')
    }
    snapshot = await openChildDirectory(root, directoryId)
  } catch (error) {
    await root.close()
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let entries = 0
  const measure = async (directory: FileHandle, depth: number): Promise<number> => {
    if (depth > 34) throw new SourceError('SOURCE_CAPACITY', 'Retained source directory depth exceeds its bound.')
    let bytes = Math.max(4096, Number((await directory.stat()).blocks) * 512)
    for (const name of await readdir(anchored(directory))) {
      entries += 1
      if (entries > SOURCE_LIMITS.entries * 34 + 16) {
        throw new SourceError('SOURCE_CAPACITY', 'Retained source entry count exceeds its bound.')
      }
      const handle = await open(anchored(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await handle.stat()
        if (stat.uid !== process.getuid?.()) {
          throw new SourceError('SOURCE_BYTES_INVALID', 'Retained source ownership changed.')
        }
        if (stat.isDirectory()) {
          const filesystem = await identity(handle)
          if (filesystem.device !== rootFilesystem.device || filesystem.mountId !== rootFilesystem.mountId) {
            throw new SourceError('SOURCE_MOUNT_CHANGED', 'Retained source cannot cross a filesystem or mount boundary.')
          }
          // The private materialization parent also contains ordinary Git directory modes.
          bytes += await measure(handle, depth + 1)
        } else {
          if (!stat.isFile() || stat.nlink !== 1) {
            throw new SourceError('SOURCE_BYTES_INVALID', 'Retained source contains an unsupported file.')
          }
          bytes += Math.max(4096, stat.size, stat.blocks * 512)
        }
      } finally {
        await handle.close()
      }
    }
    return bytes
  }
  try {
    return await measure(snapshot, 0)
  } finally {
    await snapshot.close()
    await root.close()
  }
}

export async function measureRetainedMaterialization(receipt: MaterializationReceipt): Promise<number> {
  // Quota-owned Job trees are reclaimed with their project quota, not retained.
  if (receipt.quota) return 0
  const binding = receipt.binding
  const reference = await measureRetainedSourceDirectory(binding.canonicalPath, receipt.materializationId, binding.filesystem)
  if (!receipt.sharedTree) return reference
  const working = await measureRetainedSourceDirectory(binding.canonicalPath, receipt.sharedTree.id, binding.filesystem)
  return reference + working
}
