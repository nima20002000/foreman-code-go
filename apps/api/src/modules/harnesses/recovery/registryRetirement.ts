import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { NativeProcessObservationSchema } from '@foreman-code/contracts/remote-execution-entry-closure'
import { bootIdentity, identityAlive } from './linuxIdentity.js'
import { nativeRegistryProjection } from './registryObservation.js'
import { existingPrivateDirectory, privateDirectory, readRecord, syncDirectory, writeRecord } from './storage.js'

// Keep fresh closure certificates in place for in-flight recovery and retries.
const closureRetentionMs = 24 * 60 * 60 * 1000
const preparedRoots = new Set<string>()

function existingStat(path: string) {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function directoryEntries(path: string): string[] {
  try {
    if (!existingPrivateDirectory(path)) return []
    return readdirSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function archivedClosure(directory: string, id: string): unknown | undefined {
  const archive = join(directory, 'closed')
  if (!existingPrivateDirectory(archive)) return undefined
  return readRecord(join(archive, `${id}.json`))
}

/** Retain exact closure readback outside the hot process inventory. */
export function pruneClosedObservation(directory: string, id: string): void {
  const path = join(directory, `closed-${id}.json`)
  const stat = existingStat(path)
  if (!stat || Date.now() - stat.mtimeMs < closureRetentionMs) return
  // A crash may leave a closure certificate beside an unfinished retirement.
  if (existingStat(join(directory, id)) || existingStat(join(directory, `.retired-${id}`))) return
  const raw = readRecord(path)
  if (raw === undefined) return
  const row = NativeProcessObservationSchema.parse(raw)
  if (row.launchId !== id || row.lifecycle !== 'closed' || !row.closureEvidence
    || createHash('sha256').update(row.owner).digest('hex') !== basename(directory)) {
    throw new Error('Invalid native closure archive record.')
  }
  if (row.bootId === bootIdentity() && [row.guardian, row.provider].some(process => process && identityAlive(process))) {
    return
  }
  const archive = privateDirectory(join(directory, 'closed'))
  const destination = join(archive, `${id}.json`)
  const previous = readRecord(destination)
  if (previous !== undefined && !isDeepStrictEqual(previous, raw)) {
    throw new Error('Conflicting archived native closure.')
  }
  if (previous === undefined) {
    try { writeRecord(destination, raw, true) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
        || !isDeepStrictEqual(readRecord(destination), raw)) throw error
    }
  }
  // The archive is fsynced before unlink: interruption leaves at least one certificate.
  syncDirectory(archive)
  try { unlinkSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  syncDirectory(directory)
}

/** Startup maintenance runs once per root; passive telemetry never performs GC. */
export function prepareRegistryRetirement(root: string, retire: (directory: string) => void): void {
  if (preparedRoots.has(root) || !existingPrivateDirectory(root)) return
  nativeRegistryProjection(root).retirementBatch(() => {
    for (const ownerKey of directoryEntries(root)) {
      if (!/^[0-9a-f]{64}$/.test(ownerKey)) continue
      const directory = join(root, ownerKey)
      for (const name of directoryEntries(directory)) {
        const match = /^closed-([0-9a-f-]{36})\.json$/.exec(name)
        if (match) pruneClosedObservation(directory, match[1]!)
        if (/^[0-9a-f-]{36}$/.test(name)) {
          const registration = join(directory, name)
          if (!existingPrivateDirectory(registration)) continue
          const closed = existingStat(join(registration, 'closed.json'))
          if (closed && Date.now() - closed.mtimeMs >= closureRetentionMs) retire(registration)
        }
      }
    }
    preparedRoots.add(root)
  })
}
