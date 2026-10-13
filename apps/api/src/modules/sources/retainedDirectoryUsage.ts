import { lstat, open, readdir, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { SourceManifestSchema, type RootBinding, type MaterializationReceipt } from '@foreman-code/contracts/source-materialization'
import { anchored, directoryFlags, identity, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'
import type { RetainedSourceFootprint } from '@foreman-code/contracts/source-operations'
import { SOURCE_LIMITS, SourceError } from './manifest.js'

/** Measures retained bytes only after the caller has confirmed the original writer is closed. */
export async function measureRetainedSourceDirectory(
  canonicalRoot: string, directoryId: string, expectedRoot?: RootBinding['filesystem'],
): Promise<number> {
  return measureSourceDirectory(canonicalRoot, directoryId, expectedRoot, new Set())
}

async function measureSourceDirectory(
  canonicalRoot: string, directoryId: string, expectedRoot: RootBinding['filesystem'] | undefined,
  countedInodes: Set<string>,
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
  try {
    return await measureRetainedDirectory(snapshot, rootFilesystem, countedInodes,
      { depth: 34, entries: SOURCE_LIMITS.entries * 34 + 16 })
  } finally {
    await snapshot.close()
    await root.close()
  }
}

/** Count allocated bytes without following symlinks or crossing the pinned filesystem. */
export async function measureRetainedDirectory(root: FileHandle, rootFilesystem: RootBinding['filesystem'],
  countedInodes = new Set<string>(), limits = { depth: 64, entries: 300_000 }): Promise<number> {
  let entries = 0
  const measure = async (directory: FileHandle, depth: number): Promise<number> => {
    if (depth > limits.depth) throw new SourceError('SOURCE_CAPACITY', 'Retained source directory depth exceeds its bound.')
    let bytes = Math.max(4096, Number((await directory.stat()).blocks) * 512)
    for (const name of await readdir(anchored(directory))) {
      entries += 1
      if (entries > limits.entries) {
        throw new SourceError('SOURCE_CAPACITY', 'Retained source entry count exceeds its bound.')
      }
      const path = anchored(directory, name)
      const stat = await lstat(path, { bigint: true })
      if (stat.uid !== BigInt(process.getuid?.() ?? -1)) {
        throw new SourceError('SOURCE_BYTES_INVALID', 'Retained source ownership changed.')
      }
      if (stat.isDirectory()) {
        const handle = await open(path, directoryFlags)
        try {
          if ((await handle.stat()).uid !== process.getuid?.()) {
            throw new SourceError('SOURCE_BYTES_INVALID', 'Retained source ownership changed.')
          }
          const filesystem = await identity(handle)
          if (filesystem.device !== rootFilesystem.device || filesystem.mountId !== rootFilesystem.mountId) {
            throw new SourceError('SOURCE_MOUNT_CHANGED', 'Retained source cannot cross a filesystem or mount boundary.')
          }
          // The private materialization parent also contains ordinary Git directory modes.
          bytes += await measure(handle, depth + 1)
        } finally {
          await handle.close()
        }
      } else {
        if (!stat.isFile() && !stat.isSymbolicLink()) {
          throw new SourceError('SOURCE_BYTES_INVALID', 'Retained source contains an unsupported file.')
        }
        const inode = `${stat.dev}:${stat.ino}`
        if (countedInodes.has(inode)) continue
        countedInodes.add(inode)
        bytes += Math.max(4096, Number(stat.size), Number(stat.blocks) * 512)
      }
    }
    return bytes
  }
  return measure(root, 0)
}

export async function measureRetainedMaterializationFootprint(
  receipt: MaterializationReceipt,
): Promise<RetainedSourceFootprint> {
  if (receipt.quota) return { retainedBytes: 0 }
  const binding = receipt.binding
  const countedInodes = new Set<string>()
  // Charge cross-tree hard links to the shared tree so its other references can release their own copies.
  const working = receipt.sharedTree ? await measureSourceDirectory(
    binding.canonicalPath, receipt.sharedTree.id, binding.filesystem, countedInodes,
  ) : 0
  const reference = await measureSourceDirectory(
    binding.canonicalPath, receipt.materializationId, binding.filesystem, countedInodes,
  )
  return { retainedBytes: reference + working,
    ...(receipt.sharedTree ? { sharedTree: { id: receipt.sharedTree.id, bytes: working } } : {}) }
}

export async function measureRetainedMaterialization(receipt: MaterializationReceipt): Promise<number> {
  return (await measureRetainedMaterializationFootprint(receipt)).retainedBytes
}
