import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { MAX_FILE_BYTES } from '@graphql/contracts/files'

import type { ApiConfig } from '../../config.js'
import { registerFileRoutes } from '../../routes/files.js'
import { workspaceStorageRoot } from '../workspaces/storage.js'
import { PostgresFileConversationAuthorization } from './authorization.js'
import { PostgresFileRepository } from './postgres.js'
import { TemporaryFileService } from './service.js'
import { defaultFileStorageRoot, FileByteStorage } from './storage.js'

export function registerProductionFileStorage(app: FastifyInstance, pool: pg.Pool, config: ApiConfig): TemporaryFileService {
  const repository = new PostgresFileRepository(pool)
  const bytes = new FileByteStorage(config.fileStorageRoot ?? defaultFileStorageRoot(), MAX_FILE_BYTES,
    [config.harnesses.workspaceRoot, config.workspaceStorageRoot ?? workspaceStorageRoot()])
  const service = new TemporaryFileService(repository, bytes, new PostgresFileConversationAuthorization(pool))
  registerFileRoutes(app, service)
  app.addHook('onReady', () => bytes.initialize())
  return service
}
