import { readFile, statfs } from 'node:fs/promises'
import { availableParallelism, freemem } from 'node:os'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import { SourceStorageCapacitySchema, type SourceStorageCapacity } from '@foreman-code/contracts/source-operations'
import { DomainError } from '../errors.js'
import { anchored, identity, openPrivateRoot } from './privateFilesystem.js'

const GIB = 2 ** 30
export const SOURCE_AGGREGATE_LIMITS = Object.freeze({ bytes: 64 * GIB, preparing: 32, materializations: 64 })

export function sourceStorageLimits(capacity: SourceStorageCapacity) {
  const diskMargin = Math.max(GIB, Math.ceil(capacity.availableBytes * 0.1))
  const memoryMargin = Math.max(GIB, Math.ceil(capacity.availableMemoryBytes * 0.25))
  const memorySlots = Math.floor(Math.max(0, capacity.availableMemoryBytes - memoryMargin) / (512 * 2 ** 20))
  const materializations = Math.min(SOURCE_AGGREGATE_LIMITS.materializations, capacity.cpuCount * 2, memorySlots)
  return {
    bytes: Math.min(SOURCE_AGGREGATE_LIMITS.bytes, Math.floor(capacity.totalBytes * 0.25)),
    availableBytes: Math.max(0, capacity.availableBytes - diskMargin),
    preparing: Math.min(SOURCE_AGGREGATE_LIMITS.preparing, materializations),
    materializations,
  }
}

export async function readSourceStorageCapacity(path: string,
  expectedFilesystem?: RootBinding['filesystem']): Promise<SourceStorageCapacity> {
  const root = await openPrivateRoot(path)
  try {
    const filesystem = await identity(root)
    if (expectedFilesystem && (filesystem.device !== expectedFilesystem.device
      || filesystem.mountId !== expectedFilesystem.mountId || filesystem.inode !== expectedFilesystem.inode)) {
      throw new DomainError('SOURCE_ROOT_CONFLICT', 'Source capacity belongs to another filesystem.', 409)
    }
    const disk = await statfs(anchored(root), { bigint: true })
    const memory = await readFile('/proc/meminfo', 'utf8')
    const availableMemory = /^MemAvailable:\s*(\d+)\s+kB$/m.exec(memory)?.[1]
    const processMemory = process.availableMemory()
    return SourceStorageCapacitySchema.parse({
      filesystem,
      totalBytes: Number(disk.blocks * disk.bsize),
      availableBytes: Number(disk.bavail * disk.bsize),
      cpuCount: availableParallelism(),
      availableMemoryBytes: Math.min(availableMemory ? Number(availableMemory) * 1024 : freemem(), processMemory),
      observedAt: new Date().toISOString(),
    })
  } finally { await root.close() }
}
