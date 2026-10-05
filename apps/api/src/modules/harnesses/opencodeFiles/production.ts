import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { MAX_FILE_BYTES, MAX_MESSAGE_ATTACHMENTS } from '@foreman-code/contracts/files'
import type { ApiConfig } from '../../../config.js'
import { defaultFileStorageRoot } from '../../files/storage.js'
import { mountOpenCodeFileMcp, FILE_TOOLS_MCP_PATH } from '../../files/tools/mcp.js'
import { productionFileTools } from '../../files/tools/production.js'
import type { OpenCodeServerController } from '../opencodeTransport.js'
import type { OpenCodeChatFiles } from './chat.js'
import { LocalOpenCodeExecutionFiles } from './host.js'
import { bindingIdentity } from '../../files/tools/context.js'
import { OpenCodeFileCleanupJournal } from './cleanupJournal.js'
import { cleanupOpenCodeDirectory, ownOpenCodeDirectory } from './cleanup.js'
import { adoptOpenCodePublications, resolveOpenCodeFileAdmission } from './postgres.js'
import { OpenCodeFileError } from './types.js'

export interface OpenCodeFileAdmissions {
  resolve: typeof resolveOpenCodeFileAdmission
  adoptPublished: typeof adoptOpenCodePublications
}

/** Chat-only production composition. The protected vault check runs on the actual native process. */
export function productionOpenCodeChatFiles(app: () => FastifyInstance, pool: pg.Pool, config: ApiConfig,
  conversationId: string, server: OpenCodeServerController, endpointHost: string,
  admissions: OpenCodeFileAdmissions = { resolve: resolveOpenCodeFileAdmission, adoptPublished: adoptOpenCodePublications }): OpenCodeChatFiles {
  const journal = new OpenCodeFileCleanupJournal(config.fileStorageRoot ?? defaultFileStorageRoot(), conversationId)
  return {
    recover: signal => journal.recover(async context => {
      await pool.query(`update file_tool_sessions set revoked_at=coalesce(revoked_at,now())
        where record->>'binding'=$1`, [bindingIdentity(context)])
      await admissions.adoptPublished(pool, context)
    }, signal),
    async resolve(identity, signal) {
    signal.throwIfAborted()
    const admission = await admissions.resolve(pool, conversationId, identity)
    signal.throwIfAborted()
    if (!admission) return undefined
    const service = productionFileTools(app())
    const scoped = { sessions: {
      issueForAcceptedSession: (context: typeof admission.context, expiresAt: Date) =>
        service.sessions.issueForAcceptedSession(context, expiresAt, 'opencode'),
      authenticate: service.sessions.authenticate.bind(service.sessions),
      authorizeAccepted: service.sessions.authorizeAccepted.bind(service.sessions),
      revoke: service.sessions.revoke.bind(service.sessions),
    },
    artifacts: service.artifacts,
    list: service.list.bind(service), read: service.read.bind(service),
    createWorkingCopy: service.createWorkingCopy.bind(service), publish: service.publish.bind(service),
    publishedForTurn: service.publishedForTurn.bind(service),
    writeWorkingCopy: service.writeWorkingCopy.bind(service), applyFormatEdit: service.applyFormatEdit.bind(service) }
    const mountId = randomUUID()
    if (!server.ownedFileRoot) {
      throw new OpenCodeFileError('FILE_SOURCE_ISOLATION_REQUIRED', 'The native server has no owned materialization directory.')
    }
    const root = join(server.ownedFileRoot, mountId)
    const host = new LocalOpenCodeExecutionFiles({
      executionHostId: 'runner-local', root, maxFileBytes: MAX_FILE_BYTES,
      assertSourceIsolation: async (checkSignal) => {
        if (!server.assertFileSourceIsolation) {
          throw new OpenCodeFileError('FILE_SOURCE_ISOLATION_REQUIRED', 'The native server has no isolated file host.')
        }
        await server.assertFileSourceIsolation(config.fileStorageRoot ?? defaultFileStorageRoot(), checkSignal)
      },
    })
    const pinned = new Set(admission.attachments.map((ref) => `${ref.fileId}/${ref.revisionId}`))
    return {
      admission: { ...admission, expiresAt: new Date(Date.now() + 60 * 60_000),
        executionHostId: host.executionHostId, directory: identity.directory,
        mode: admission.context.allowMutation ? 'write' : 'read' },
      options: { service: scoped, host, endpoint: `http://${endpointHost}:${config.port}${FILE_TOOLS_MCP_PATH}/opencode/${mountId}`,
        maxFileBytes: MAX_FILE_BYTES, maxAttachments: MAX_MESSAGE_ATTACHMENTS },
      read: async (input, readSignal) => {
        readSignal.throwIfAborted()
        if (!pinned.has(`${input.fileId}/${input.revisionId}`)) {
          throw new OpenCodeFileError('FILE_CONTEXT_DENIED', 'The file was not pinned by this message.')
        }
        const result = await service.readAccepted(admission.context, input)
        readSignal.throwIfAborted()
        return result
      },
      adoptPublished: (context) => admissions.adoptPublished(pool, context),
      mount: async (facade) => {
        await mkdir(root, { recursive: true, mode: 0o700 })
        const owned = await ownOpenCodeDirectory(root)
        if (!server.nativePid) throw new OpenCodeFileError('FILE_CLEANUP_REQUIRED', 'The native file owner is unavailable.')
        const registration = journal.register(owned, server.nativePid, admission.context, server.processRecovery)
        try {
          const unmount = mountOpenCodeFileMcp(app(), mountId, facade)
          return async () => {
            unmount()
            host.assertReleased()
            await cleanupOpenCodeDirectory(owned)
            await journal.forget(registration)
          }
        } catch (error) {
          await cleanupOpenCodeDirectory(owned)
          await journal.forget(registration)
          throw error
        }
      },
    }
  } }
}
