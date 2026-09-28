import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { ApiConfig } from '../../../config.js'
import type { NativeManagerResolver } from '../../conversations/operatorChat.js'
import { OPERATOR_MCP_ENVIRONMENT_VARIABLE } from '../../conversations/operatorChatAuthority.js'
import { DomainError } from '../../errors.js'
import { defaultFileStorageRoot } from '../../files/storage.js'
import { CodexAppServerSessionManager } from '../codexAppServer.js'
import { productionCodexChatFiles } from '../codexFiles/production.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from '../opencodeServer.js'
import { productionOpenCodeChatFiles } from '../opencodeFiles/production.js'
import type { NativeHarnessSessionManager } from '../port.js'
import type { NativeProcessRegistry } from '../recovery/processRegistry.js'
import type { NativeResponseJournal } from '../recovery/responseJournal.js'
import { operatorCodexFileAdmissions } from './codex.js'
import { adoptOperatorFilePublications, operatorTurnHasFileInputs, recordOperatorFileSubmission,
  resolveOperatorOpenCodeFileAdmission } from './postgres.js'

/** Shared by buildProductionApp and protocol regressions. Text-only Operator
 * management remains credentialed; an accepted file turn gets a file-only child. */
export function productionOperatorManagers(input: {
  app: () => FastifyInstance
  pool: pg.Pool
  config: ApiConfig
  workingDirectory: string
  endpointHost: string
  appMcpEndpoint: string
  processRegistry: NativeProcessRegistry
  responseJournal: NativeResponseJournal
  managers: Map<string, NativeHarnessSessionManager>
}): NativeManagerResolver {
  const modes = new Map<string, boolean>()
  const resolver: NativeManagerResolver = (configuration, conversationId, fileInputs = false) => {
    const existing = input.managers.get(conversationId)
    if (existing) {
      if (modes.get(conversationId) !== fileInputs) throw new DomainError(
        'OPERATOR_RUNTIME_MODE_CONFLICT', 'Dispose the previous Operator process before changing file authority.', 409)
      return existing
    }
    const recovery = input.processRegistry.scope(`conversation:${conversationId}`)
    let manager: NativeHarnessSessionManager
    if (configuration.harness.harness === 'codex') {
      manager = fileInputs
        ? new CodexAppServerSessionManager(input.config.harnesses.codexBinary, undefined, undefined, recovery, 'none',
          productionCodexChatFiles(input.app, conversationId, operatorCodexFileAdmissions(input.app, input.pool,
            configuration, input.workingDirectory, input.config.fileStorageRoot ?? defaultFileStorageRoot())))
        : new CodexAppServerSessionManager(input.config.harnesses.codexBinary, undefined, undefined, recovery)
    } else {
      const authority = fileInputs ? { appMcpAccess: 'none' as const }
        : { credentialEnvironmentVariable: OPERATOR_MCP_ENVIRONMENT_VARIABLE }
      const server = new ManagedOpenCodeServer({ binary: input.config.harnesses.openCodeBinary,
        workingDirectory: input.workingDirectory, ownerAgentId: configuration.operatorId,
        processRecovery: recovery, ...authority,
        ...(configuration.harness.advanced ? { advancedConfiguration: configuration.harness.advanced } : {}),
      })
      manager = new OpenCodeNativeSessionManager({ server, ownerAgentId: configuration.operatorId,
        responseJournal: input.responseJournal, expectedAppMcpEndpoint: input.appMcpEndpoint, ...authority,
        ...(fileInputs ? { chatFiles: productionOpenCodeChatFiles(input.app, input.pool, input.config,
          conversationId, server, input.endpointHost, {
            resolve: (pool, id, identity) => resolveOperatorOpenCodeFileAdmission(pool, id, configuration, input.workingDirectory, identity),
            adoptPublished: adoptOperatorFilePublications,
          }) } : {}),
      })
    }
    input.managers.set(conversationId, manager)
    modes.set(conversationId, fileInputs)
    return manager
  }
  resolver.release = (id) => { input.managers.delete(id); modes.delete(id) }
  resolver.hasFileInputs = (id, requestId) => operatorTurnHasFileInputs(input.pool, id, requestId)
  resolver.recordFileSubmission = (id, requestId, nativeTurnId) => recordOperatorFileSubmission(input.pool, id, requestId, nativeTurnId)
  return resolver
}
