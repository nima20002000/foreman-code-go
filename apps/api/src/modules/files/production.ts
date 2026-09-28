import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { MAX_FILE_BYTES } from '@graphql/contracts/files'

import type { ApiConfig } from '../../config.js'
import { registerFileRoutes } from '../../routes/files.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { PostgresFileReferenceAuthorization } from './references/authorization.js'
import { registerFileReferenceRoutes } from './references/routes.js'
import { FileReferenceService } from './references/service.js'
import { PostgresAgentReferenceAuthorization } from './references/agentAuthorization.js'
import { PostgresReferenceReadRepository } from './references/agentProvenance.js'
import { AgentReferenceService } from './references/agentService.js'
import { workspaceStorageRoot } from '../workspaces/storage.js'
import { PostgresFileConversationAuthorization } from './authorization.js'
import { PostgresFileRepository } from './postgres.js'
import { TemporaryFileService } from './service.js'
import { readFileRetentionSnapshot } from './retentionSnapshot.js'
import { defaultFileStorageRoot, FileByteStorage } from './storage.js'
import { registerProductionFileTools } from './tools/production.js'
import type { FileReferenceResolver } from './tools/types.js'
import { ManagedFileCleanupBytes } from './cleanup/bytes.js'
import { PostgresFileCleanupRepository } from './cleanup/postgres.js'
import { TemporaryFileCleanupSweeper } from './cleanup/sweeper.js'

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
  // FIL-37: authenticated agent-tool/conversation adapters bind this read-only service, not FIL-36 writes.
  app.decorate('agentReferenceService', new AgentReferenceService({
    files: repository, bytes, authorization: new PostgresAgentReferenceAuthorization(pool),
    reads: new PostgresReferenceReadRepository(pool),
  }))
  registerFileRoutes(app, service)
  registerFileReferenceRoutes(app, references)
  registerProductionFileTools(app, pool, service, referenceResolver)
  const cleanup = new TemporaryFileCleanupSweeper(new PostgresFileCleanupRepository(pool),
    new ManagedFileCleanupBytes(bytes), (error, context) => app.log.warn({ err: error, ...context }, 'temporary file cleanup failed'))
  app.addHook('onReady', async () => { await bytes.initialize(); cleanup.start() })
  // Drain the sweeper before server.ts's onClose hooks dispose the shared pool.
  app.addHook('preClose', () => cleanup.stop())
  return service
}
