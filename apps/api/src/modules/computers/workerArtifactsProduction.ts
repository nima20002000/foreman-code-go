import { join } from 'node:path'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { readProductVersion } from '../../infrastructure/productVersion.js'
import { createWorkerArtifactExtension } from './workerArtifacts.js'

export function createProductionWorkerArtifactExtension(options: {
  environment: NodeJS.ProcessEnv
  releaseDirectory: string
}) {
  return createWorkerArtifactExtension({
    directory: readProductEnvironment(options.environment, 'WORKER_ARTIFACT_DIRECTORY')
      ?? join(options.releaseDirectory, 'worker-artifacts'),
    version: readProductVersion(options.releaseDirectory),
  })
}
