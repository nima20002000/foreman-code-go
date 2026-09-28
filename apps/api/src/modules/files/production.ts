import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { MAX_FILE_BYTES } from '@graphql/contracts/files'

import type { ApiConfig } from '../../config.js'
import { registerFileRoutes } from '../../routes/files.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { PostgresFileReferenceAuthorization } from './references/authorization.js'
import { registerFileReferenceRoutes } from './references/routes.js'
import { FileReferenceService } from './references/service.js'
import { workspaceStorageRoot } from '../workspaces/storage.js'
import { PostgresFileConversationAuthorization } from './authorization.js'
import { PostgresFileRepository } from './postgres.js'
import { TemporaryFileService } from './service.js'
import { readFileRetentionSnapshot } from './retentionSnapshot.js'
import { defaultFileStorageRoot, FileByteStorage } from './storage.js'
import { registerProductionFileTools } from './tools/production.js'
import type { FileReferenceResolver } from './tools/types.js'

// referenceResolver is FIL-37's agent read seam; FIL-36's human reference service is composed below.
export function registerProductionFileStorage(app: FastifyInstance, pool: pg.Pool, config: ApiConfig,
  referenceResolver?: FileReferenceResolver): TemporaryFileService {
  const repository = new PostgresFileRepository(pool, readFileRetentionSnapshot)
  const bytes = new FileByteStorage(config.fileStorageRoot ?? defaultFileStorageRoot(), MAX_FILE_BYTES,
    [config.harnesses.workspaceRoot, config.workspaceStorageRoot ?? workspaceStorageRoot()])
  const service = new TemporaryFileService(repository, bytes, new PostgresFileConversationAuthorization(pool))
  const references = new FileReferenceService(repository, bytes, new PostgresFileReferenceAuthorization(pool),
    new PostgresCommandCoordinator(pool))
  // The MCP endpoint is composed before this helper. Its onReady hook binds this same service.
  app.decorate('fileReferenceService', references)
  registerFileRoutes(app, service)
  registerFileReferenceRoutes(app, references)
  registerProductionFileTools(app, pool, service, referenceResolver)
  app.addHook('onReady', () => bytes.initialize())
  return service
}
