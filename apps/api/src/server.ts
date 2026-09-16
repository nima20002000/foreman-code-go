import { loadEnvFile } from 'node:process'
import { mkdir } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'

import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createCheckpointStore } from './infrastructure/checkpoints.js'
import { createDatabase } from './infrastructure/database.js'
import { ensureAcceptanceSeed } from './infrastructure/seed.js'
import { PostgresAccessService } from './modules/access/postgres.js'
import { WorkerCredentialService } from './modules/access/workerCredentials.js'
import { PostgresInteractionRepository } from './modules/interactions/postgres.js'
import { PostgresAppInteractionService } from './modules/interactions/app.js'
import { PostgresApprovalBudgetRepository } from './modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from './modules/interactions/execution.js'
import { InteractionService } from './modules/interactions/service.js'
import { OperatorInteractionService } from './modules/interactions/operator.js'
import { ExecutionScopedNativeSessionManagerResolver } from './modules/interactions/runtimePorts.js'
import { PostgresCommandCoordinator } from './modules/commands/postgres.js'
import { GraphDraftService } from './modules/graph-drafts/service.js'
import { HarnessCatalogService } from './modules/harnesses/catalog.js'
import { LocalHarnessResolver } from './modules/harnesses/resolver.js'
import { CodexAppServerSessionManager } from './modules/harnesses/codexAppServer.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from './modules/harnesses/opencodeServer.js'
import { codexMcpInspectorAdapter } from './modules/harnesses/codexMcpInspectorAdapter.js'
import { openCodeMcpInspectorAdapter } from './modules/harnesses/opencodeMcpInspectorAdapter.js'
import { CompositeNativeMcpInspector } from './modules/harnesses/compositeMcpInspector.js'
import { McpDetectionService, WorkerLaunchCredentialService } from './modules/harnesses/mcpDetection.js'
import type { NativeHarnessSessionManager } from './modules/harnesses/port.js'
import { LangGraphWorkflowEngine } from './modules/runs/engine.js'
import { PostgresRunRepository } from './modules/runs/postgres.js'
import { RunManagementService } from './modules/runs/management.js'
import { PostgresSettingsRepository } from './modules/settings/postgres.js'
import { PostgresFoundationSettingsRepository } from './modules/settings/foundation.js'
import { FoundationSettingsManagementService } from './modules/settings/management.js'
import { PostgresWorkflowRepository } from './modules/workflows/postgres.js'
import { WorkflowManagementService } from './modules/workflows/management.js'
import { PostgresWorkspaceRepository } from './modules/workspaces/postgres.js'
import { WorkspaceManagementService } from './modules/workspaces/management.js'
import { AgentManagementService } from './modules/workspaces/agents.js'
import { WorkspaceLocationService } from './modules/workspaces/location.js'
import { PostgresOperatorRepository } from './modules/operators/postgres.js'
import {
  ensureOperatorRuntimeDirectory,
  OperatorChatService,
  PostgresOperatorConversationRepository,
} from './modules/conversations/operatorChat.js'

async function main() {
  // loadEnvFile is available at the declared Node 22.0 runtime baseline, unlike
  // --env-file-if-exists. Missing local configuration is normal in production.
  try {
    loadEnvFile()
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }
  const config = loadConfig(process.env)
  const database = createDatabase(config.database)
  const access = new PostgresAccessService(database.pool)
  const commands = new PostgresCommandCoordinator(database.pool)
  const interactions = new PostgresInteractionRepository(database.pool)
  const budgets = new PostgresApprovalBudgetRepository(database.pool)
  const locations = new WorkspaceLocationService(database.pool, commands, config.harnesses.workspaceRoot)
  const checkpoints = createCheckpointStore(
    config.database.connectionString,
    config.checkpoints.schema,
    config.database,
  )
  const workflows = new PostgresWorkflowRepository(database.pool)
  const runs = new PostgresRunRepository(database.pool, workflows, locations)
  const workspaces = new PostgresWorkspaceRepository(database.pool, workflows, runs)
  const settings = new PostgresSettingsRepository(database.pool)
  const foundationSettings = new PostgresFoundationSettingsRepository(database.pool)
  const operators = new PostgresOperatorRepository(database.pool)
  const legacyHarnesses = new LocalHarnessResolver(config.harnesses.codexBinary, config.harnesses.openCodeBinary)
  const appMcpEndpoint = `http://127.0.0.1:${config.port}/mcp/tools`
  const detectionCodex = new CodexAppServerSessionManager(config.harnesses.codexBinary)
  const nativeInspector = new CompositeNativeMcpInspector(
    codexMcpInspectorAdapter(detectionCodex),
    async (input) => {
      const server = new ManagedOpenCodeServer({
        binary: config.harnesses.openCodeBinary,
        workingDirectory: input.workingDirectory,
        ownerAgentId: `mcp-inspector:${input.runnerId}`,
      })
      const manager = new OpenCodeNativeSessionManager({
        server,
        ownerAgentId: `mcp-inspector:${input.runnerId}`,
        expectedAppMcpEndpoint: appMcpEndpoint,
      })
      try {
        return await openCodeMcpInspectorAdapter(manager).inspect(input)
      } finally {
        await manager.dispose()
      }
    },
  )
  const detection = new McpDetectionService(nativeInspector, appMcpEndpoint)
  const workerCredentialStore = new WorkerCredentialService(database.pool, access)
  const workerCredentials = new WorkerLaunchCredentialService(detection, workerCredentialStore, locations.runnerId)
  const nativeManagers = new ExecutionScopedNativeSessionManagerResolver((context) => {
    if (context.harness === 'codex') return new CodexAppServerSessionManager(config.harnesses.codexBinary)
    const harness = context.configuration.harness
    if (harness.harness !== 'opencode') throw new Error('OpenCode manager received a non-OpenCode pinned configuration.')
    const server = new ManagedOpenCodeServer({
      binary: config.harnesses.openCodeBinary,
      workingDirectory: context.workingDirectory,
      ownerAgentId: context.agentId,
      ...(harness.advanced ? { advancedConfiguration: harness.advanced } : {}),
    })
    return new OpenCodeNativeSessionManager({
      server,
      ownerAgentId: context.agentId,
      expectedAppMcpEndpoint: appMcpEndpoint,
    })
  })
  const approvals = new ApprovalExecutionCoordinator(
    runs, interactions, budgets, nativeManagers, config.harnesses.timeoutMs, workerCredentials,
  )
  const interactionService = new InteractionService(
    interactions, budgets, approvals, (interaction) => engine.resumeInteraction(interaction),
  )
  const engine = new LangGraphWorkflowEngine(
    runs, workflows, legacyHarnesses, checkpoints.saver, config.harnesses.workspaceRoot,
    config.harnesses.timeoutMs, locations, workerCredentials, approvals, interactions,
  )

  let app: FastifyInstance | undefined
  let chat: OperatorChatService | undefined
  const operatorManagers = new Map<string, NativeHarnessSessionManager>()
  let reconciliationTimer: NodeJS.Timeout | undefined
  try {
    await database.ping()
    await database.migrate()
    await ensureAcceptanceSeed(database.pool)
    await checkpoints.setup()
    await checkpoints.ping()
    await mkdir(config.harnesses.workspaceRoot, { recursive: true })
    await operators.ensure()
    const operatorWorkingDirectory = await ensureOperatorRuntimeDirectory(config.harnesses.workspaceRoot)
    chat = new OperatorChatService(
      new PostgresOperatorConversationRepository(database.pool),
      operators,
      (configuration) => {
        const existing = operatorManagers.get(configuration.id)
        if (existing) return existing
        let manager: NativeHarnessSessionManager
        if (configuration.harness.harness === 'codex') {
          manager = new CodexAppServerSessionManager(config.harnesses.codexBinary)
        } else {
          const server = new ManagedOpenCodeServer({
            binary: config.harnesses.openCodeBinary,
            workingDirectory: operatorWorkingDirectory,
            ownerAgentId: configuration.operatorId,
            ...(configuration.harness.advanced ? { advancedConfiguration: configuration.harness.advanced } : {}),
          })
          manager = new OpenCodeNativeSessionManager({
            server,
            ownerAgentId: configuration.operatorId,
            expectedAppMcpEndpoint: appMcpEndpoint,
          })
        }
        operatorManagers.set(configuration.id, manager)
        return manager
      },
      operatorWorkingDirectory,
    )
    const operatorServices = {
      workspaces: new WorkspaceManagementService(database.pool, commands, locations),
      locations,
      workflows: new WorkflowManagementService(database.pool, commands),
      agents: new AgentManagementService(database.pool),
      drafts: new GraphDraftService(database.pool, commands),
      harnesses: new HarnessCatalogService(legacyHarnesses, settings, commands, config.harnesses.workspaceRoot),
      settings: new FoundationSettingsManagementService(foundationSettings, commands),
      runs: new RunManagementService(database.pool, commands, runs, engine, locations),
      interactions: new OperatorInteractionService(interactionService, interactions),
      commands,
    }
    app = buildApp({
      readiness: { database, checkpoints },
      readinessTimeoutMs: config.readinessTimeoutMs,
      product: { workspaces, workflows, runs, settings, foundationSettings, engine, interactions: interactionService, chat },
      operator: { access, services: operatorServices },
      appMcp: {
        access,
        interactions: new PostgresAppInteractionService(database.pool, interactions, commands, interactionService),
      },
      mcpDetection: { pool: database.pool, service: detection },
      logger: true,
    })
    app.addHook('onClose', async () => {
      if (reconciliationTimer) clearInterval(reconciliationTimer)
      await Promise.allSettled([chat?.shutdown(), engine.shutdown()])
      await Promise.allSettled([
        nativeManagers.dispose(),
        detectionCodex.dispose(),
        ...[...operatorManagers.values()].map(async (manager) => {
          const disposable = manager as NativeHarnessSessionManager & { dispose?: () => Promise<void> }
          await disposable.dispose?.()
        }),
      ])
      operatorManagers.clear()
      await Promise.allSettled([checkpoints.close(), database.close()])
    })
    const reportReconciliationError = (error: unknown) => app?.log.error({ err: error }, 'run reconciliation failed')
    await engine.reconcile(reportReconciliationError)
    await chat.reconcileActive()
    reconciliationTimer = setInterval(() => {
      void engine.reconcile(reportReconciliationError).catch(reportReconciliationError)
    }, 5_000)
    reconciliationTimer.unref()
    await app.listen({ host: config.host, port: config.port })
  } catch (error) {
    if (app) await app.close()
    else {
      await Promise.allSettled([chat?.shutdown(), engine.shutdown(), nativeManagers.dispose(), detectionCodex.dispose()])
      await Promise.allSettled([checkpoints.close(), database.close()])
    }
    throw error
  }

  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await app?.close()
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error'
  process.stderr.write(`graphql-api failed to start: ${message}\n`)
  process.exitCode = 1
})
