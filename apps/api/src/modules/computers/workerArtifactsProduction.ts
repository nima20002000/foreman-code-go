import type pg from 'pg'
import { join } from 'node:path'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { readProductVersion } from '../../infrastructure/productVersion.js'
import { createWorkerArtifactExtension } from './workerArtifacts.js'

export function createProductionWorkerArtifactExtension(options: {
  environment: NodeJS.ProcessEnv
  releaseDirectory: string
  pool?: pg.Pool
}) {
  return createWorkerArtifactExtension({
    directory: readProductEnvironment(options.environment, 'WORKER_ARTIFACT_DIRECTORY')
      ?? join(options.releaseDirectory, 'worker-artifacts'),
    version: readProductVersion(options.releaseDirectory),
    buildEnabled: async binding => {
      if (!options.pool) return false
      const result = await options.pool.query(`select 1 from build_computer_preferences
        where build_enabled and target#>>'{hostRef,mainId}'=$1
          and target#>>'{hostRef,deviceId}'=$2 and target->>'applicationInstallationId'=$3
          and (target->>'keyRevision')::int=$4 and (target->>'authorizationRevision')::int=$5`,
      [binding.mainId, binding.deviceId, binding.workerInstallationId, binding.keyRevision, binding.authorizationRevision])
      return result.rows.length > 0
    },
  })
}
