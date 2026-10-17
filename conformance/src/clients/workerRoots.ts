import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import {
  ApprovedRootAllowlistSchema, WORKSPACE_ROOT_EXTENSION, WorkspaceRootBrowseResultSchema,
  WorkspaceRootWorkerRequestSchema,
} from '@foreman-code/contracts/workspace-root-policies'
import { browseWorkerDirectories, readWorkerDirectoryIdentity } from './workerDirectories.js'
import { TestWorkerOperationError, type TestWorkerExtension, type TestWorkerOperation } from './workerExtensions.js'

function assertPairing(operation: TestWorkerOperation, pairing: WorkerPairingConfiguration) {
  const binding = operation.binding
  for (const key of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
    if (binding[key] !== pairing[key]) throw new Error('The root operation belongs to another paired worker.')
  }
  if (operation.bytes !== undefined) throw new Error('Workspace root requests must not contain a binary payload.')
}

/** Human pairing owns these fixed managed paths; all exposed identities come from the actual fresh filesystem. */
export async function createTestWorkerRoots(targetDirectory: string, pairing: WorkerPairingConfiguration) {
  if (!isAbsolute(targetDirectory) || await realpath(targetDirectory) !== resolve(targetDirectory)) {
    throw new Error('Test worker storage must be inside the launcher’s canonical owned directory.')
  }
  const directory = join(targetDirectory, 'paired-worker')
  await mkdir(directory, { mode: 0o700 })
  const managed = join(directory, 'managed')
  await mkdir(managed, { mode: 0o700 })
  const workspaceDirectory = join(managed, 'workspaces')
  const runtimeDirectory = join(managed, 'runtime')
  await mkdir(workspaceDirectory, { mode: 0o700 })
  await mkdir(runtimeDirectory, { mode: 0o700 })
  const configuration = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1,
    hostRef: { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId },
    applicationInstallationId: pairing.workerInstallationId, configurationRevision: '1',
    bases: [{ baseId: randomUUID(), canonicalPath: workspaceDirectory,
      filesystem: await readWorkerDirectoryIdentity(workspaceDirectory),
      accessModes: ['read-write'], managedBy: 'worker-pairing' }],
    managedRuntimeRoot: runtimeDirectory, runtimeFilesystem: await readWorkerDirectoryIdentity(runtimeDirectory),
  })
  const extension: TestWorkerExtension = {
    namespace: WORKSPACE_ROOT_EXTENSION.namespace, version: WORKSPACE_ROOT_EXTENSION.version,
    role: 'server', maxJsonBytes: WORKSPACE_ROOT_EXTENSION.maxPayloadBytes, maxBinaryBytes: 0,
    async handle(operation) {
      operation.signal.throwIfAborted()
      assertPairing(operation, pairing)
      const request = WorkspaceRootWorkerRequestSchema.parse(operation.payload)
      if (request.operation === 'workspace-roots.configuration') return { payload: configuration }
      if (request.operation === 'workspace-roots.browse') {
        const result = await browseWorkerDirectories(configuration, request.selection, request.relativePath, operation.signal)
        return { payload: WorkspaceRootBrowseResultSchema.parse(result) }
      }
      throw new TestWorkerOperationError('UNIMPLEMENTED_TEST_WORKER_OPERATION')
    },
  }
  return { directory, workspaceDirectory, runtimeDirectory, configuration, extension }
}
