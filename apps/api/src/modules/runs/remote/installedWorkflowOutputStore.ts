import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, rename, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { BYTE_TRANSFER_POLICY } from '@graphql/contracts/byte-transfer'
import { DeviceSessionBindingSchema } from '@graphql/contracts/device-connection'
import type { WorkerPairingConfiguration } from '@graphql/contracts/device-identity'
import { anchored, identity, openChildDirectory, openPrivateRoot } from '../../sources/privateFilesystem.js'
import { DomainError } from '../../errors.js'
import { createNativeOutputBudgetLedger } from './installedNativeOutputStorage.js'

export const nativeOutputBudgetLimits = {
  maxDiskBytes: BYTE_TRANSFER_POLICY.maxStagingBytes,
  maxSnapshotBytes: BYTE_TRANSFER_POLICY.maxStagingBytes,
  // Each turn has one command registry even when it creates multiple artifacts.
  maxCommandRecords: BYTE_TRANSFER_POLICY.maxRecords * BYTE_TRANSFER_POLICY.maxActiveGlobal,
}
const Installation = DeviceSessionBindingSchema.pick({ mainId: true, deviceId: true, workerInstallationId: true })
const Marker = z.object({ version: z.literal(1), installation: Installation,
  phase: z.enum(['initializing', 'complete']) }).strict()
const markerName = 'workflow-native-outputs-initialized.json'
const unavailable = () => new DomainError('WORKER_NATIVE_OUTPUT_UNAVAILABLE',
  'The original installed output store and ownership records are required.', 409)

export function workerOutputInstallation(pairing: WorkerPairingConfiguration) {
  const { mainId, deviceId, workerInstallationId } = pairing
  return { mainId, deviceId, workerInstallationId }
}

async function readPrivateJson(parent: FileHandle, name: string, byteLimit: number) {
  const file = await open(anchored(parent, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077
      || stat.uid !== process.getuid?.() || stat.size > byteLimit) throw unavailable()
    return JSON.parse(await file.readFile('utf8')) as unknown
  } finally {
    await file.close()
  }
}

async function publishMarker(state: FileHandle, marker: z.infer<typeof Marker>) {
  const temporary = `.${markerName}-${randomUUID()}.tmp`
  const file = await open(anchored(state, temporary), 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(Marker.parse(marker)))
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(anchored(state, temporary), anchored(state, markerName))
  await state.sync()
}

export async function openInstalledWorkflowOutputDirectories(stateDirectory: string, options: {
  initialize?: true
} = {}) {
  const state = await openPrivateRoot(stateDirectory)
  try {
    const root = await openChildDirectory(state, 'workflow-native-outputs', options.initialize === true)
    try {
      for (const name of ['budget', 'turns']) {
        const child = await openChildDirectory(root, name, options.initialize === true)
        try { if (options.initialize) await child.sync() }
        finally { await child.close() }
      }
      if (options.initialize) {
        await root.sync()
        await state.sync()
      }
      return { rootDirectory: join(stateDirectory, 'workflow-native-outputs'), filesystem: await identity(root) }
    } finally {
      await root.close()
    }
  } finally {
    await state.close()
  }
}

async function assertLegacyInitializationUnused(state: FileHandle) {
  for (const name of ['workflow-native-processes', 'job-runtime-native-processes']) {
    try {
      await lstat(anchored(state, name))
      throw unavailable()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  for (const name of ['workflow-operations.json', 'job-runtime-operations.json']) {
    try {
      const journal = z.object({ schemaVersion: z.literal(1) }).passthrough()
        .parse(await readPrivateJson(state, name, 4 * 1024 * 1024))
      const unused = Object.entries(journal).every(([key, value]) =>
        key === 'schemaVersion' || Array.isArray(value) && value.length === 0)
      if (!unused) throw unavailable()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  try {
    const root = await openChildDirectory(state, 'workflow-native-outputs')
    try {
      if (!(await readdir(anchored(root))).every(name => name === 'budget' || name === 'turns')) throw unavailable()
      const turns = await openChildDirectory(root, 'turns')
      try { if ((await readdir(anchored(turns))).length !== 0) throw unavailable() }
      finally { await turns.close() }
    } finally { await root.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** The caller holds the installation's worker service lock until startup or initialization finishes. */
export async function ensureInstalledWorkflowOutputStore(stateDirectory: string, pairing: WorkerPairingConfiguration) {
  const state = await openPrivateRoot(stateDirectory)
  const installation = workerOutputInstallation(pairing)
  let marker: z.infer<typeof Marker>
  try {
    let raw: unknown
    try {
      raw = await readPrivateJson(state, markerName, 4096)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const existing = await lstat(anchored(state, 'workflow-native-outputs')).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (existing) throw unavailable()
    }
    if (raw === undefined) {
      marker = { version: 1, installation, phase: 'initializing' }
      await publishMarker(state, marker)
    } else if (Installation.safeParse(raw).success) {
      if (!isDeepStrictEqual(raw, installation)) throw unavailable()
      marker = { version: 1, installation, phase: 'complete' }
      try {
        const store = await openInstalledWorkflowOutputDirectories(stateDirectory)
        await createNativeOutputBudgetLedger({ rootDirectory: join(store.rootDirectory, 'budget'),
          installation, limits: nativeOutputBudgetLimits, stoppedWorker: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await assertLegacyInitializationUnused(state)
        marker.phase = 'initializing'
      }
      await publishMarker(state, marker)
    } else {
      marker = Marker.parse(raw)
      if (!isDeepStrictEqual(marker.installation, installation)) throw unavailable()
    }
    const initializing = marker.phase === 'initializing'
    const store = await openInstalledWorkflowOutputDirectories(stateDirectory, initializing ? { initialize: true } : {})
    await createNativeOutputBudgetLedger({ rootDirectory: join(store.rootDirectory, 'budget'), installation,
      limits: nativeOutputBudgetLimits, stoppedWorker: true, ...(initializing ? { initializeNewStore: true } : {}) })
    if (initializing) await publishMarker(state, { ...marker, phase: 'complete' })
  } finally {
    await state.close()
  }
}
