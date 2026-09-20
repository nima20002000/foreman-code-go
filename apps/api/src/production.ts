import { isDeepStrictEqual } from 'node:util'
import { NativeResponseJournal } from './modules/harnesses/recovery/responseJournal.js'
import { NativeProcessRegistry } from './modules/harnesses/recovery/processRegistry.js'
import { resolve } from 'node:path'

import type { ApiConfig } from './config.js'
import { buildApp } from './app.js'
import { createOperatorExtensions } from './mcp/operator/extensions.js'
import { NativeConfigurationService } from './modules/harnesses/nativeConfiguration.js'
import { HarnessMcpSettingsService } from './modules/harnesses/mcpSettings.js'
import { workspaceStorageRoot } from './modules/workspaces/storage.js'
import { HarnessDirectoryBrowser } from './modules/harnesses/directoryBrowser.js'
import { CodexMcpConnections } from './modules/harnesses/codexMcpConnections.js'
import { OpenCodeMcpConnections } from './modules/harnesses/openCodeMcpConnections.js'
import type { CheckpointStore } from './infrastructure/checkpoints.js'
import type { createDatabase } from './infrastructure/database.js'
import { OperatorRuntimeOwner } from './infrastructure/operatorRuntimeOwner.js'
import { RuntimeShutdown } from './infrastructure/runtimeShutdown.js'
import { PostgresAccessService } from './modules/access/postgres.js'
import { BrowserAuthentication } from './modules/browser-auth/service.js'
import { WorkerCredentialService } from './modules/access/workerCredentials.js'
import {
  ensureOperatorRuntimeDirectory,
  OperatorChatService,
  PostgresOperatorConversationRepository,
  type NativeManagerResolver,
} from './modules/conversations/operatorChat.js'
import { OPERATOR_MCP_ENVIRONMENT_VARIABLE, PostgresOperatorChatAuthority } from './modules/conversations/operatorChatAuthority.js'
import { PostgresCommandCoordinator } from './modules/commands/postgres.js'
import { DomainError } from './modules/errors.js'
import { GraphDraftService } from './modules/graph-drafts/service.js'
import { HarnessCatalogService } from './modules/harnesses/catalog.js'
import { createHarnessCompatibility } from './modules/harnesses/compatibility/service.js'
import { CodexAppServerSessionManager } from './modules/harnesses/codexAppServer.js'
import { codexMcpInspectorAdapter } from './modules/harnesses/codexMcpInspectorAdapter.js'
import { McpDetectionService, WorkerLaunchCredentialService, type ExecutionCredentialProvider } from './modules/harnesses/mcpDetection.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from './modules/harnesses/opencodeServer.js'
import { openCodeMcpInspectorAdapter } from './modules/harnesses/opencodeMcpInspectorAdapter.js'
import { NativeRollout } from './modules/harnesses/nativeRollout.js'
import type { NativeHarnessSessionManager } from './modules/harnesses/port.js'
import { NativeHarnessConfigurationQualifier } from './modules/harnesses/nativeConfigurationQualifier.js'
import { PostgresAppInteractionService } from './modules/interactions/app.js'
import { PostgresApprovalBudgetRepository } from './modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from './modules/interactions/execution.js'
import { OperatorInteractionService } from './modules/interactions/operator.js'
import { PostgresInteractionRepository } from './modules/interactions/postgres.js'
import { ExecutionScopedNativeSessionManagerResolver } from './modules/interactions/runtimePorts.js'
import { InteractionService } from './modules/interactions/service.js'
import { AutomaticReviewService } from './modules/interactions/automaticReview.js'
import { PostgresOperatorRepository } from './modules/operators/postgres.js'
import { continuationValidator } from './modules/runs/continuation.js'
import { LangGraphWorkflowEngine } from './modules/runs/engine.js'
import { RunManagementService } from './modules/runs/management.js'
import { PostgresRunRepository } from './modules/runs/postgres.js'
import { PostgresSettingsRepository } from './modules/settings/postgres.js'
import { PostgresFoundationSettingsRepository } from './modules/settings/foundation.js'
import { FoundationSettingsManagementService } from './modules/settings/management.js'
import { WorkflowManagementService } from './modules/workflows/management.js'
import { PostgresWorkflowRepository } from './modules/workflows/postgres.js'
import { AgentManagementService } from './modules/workspaces/agents.js'
import { WorkspaceLocationService } from './modules/workspaces/location.js'
import { WorkspaceManagementService } from './modules/workspaces/management.js'
import { PostgresWorkspaceRepository } from './modules/workspaces/postgres.js'

function inspectorFor(manager: NativeHarnessSessionManager) {
  if (manager instanceof CodexAppServerSessionManager) return codexMcpInspectorAdapter(manager)
  if (manager instanceof OpenCodeNativeSessionManager) return openCodeMcpInspectorAdapter(manager)
  throw new DomainError('HARNESS_INSPECTOR_UNAVAILABLE', 'The native manager has no production MCP inspector.', 503)
}

/** The startup composition is shared with regression tests; infrastructure owns its lifecycle. */
export function buildProductionApp(
  config: ApiConfig,
  database: ReturnType<typeof createDatabase>,
  checkpoints: CheckpointStore,
  logger = true,
) {
  const responseJournal = new NativeResponseJournal(resolve(config.harnesses.workspaceRoot, 'native-response-receipts'))
  const processRegistry = new NativeProcessRegistry(resolve(config.harnesses.workspaceRoot, 'native-process-registry'))
  const access = new PostgresAccessService(database.pool)
  const commands = new PostgresCommandCoordinator(database.pool)
  const repository = new PostgresInteractionRepository(database.pool)
  const budgets = new PostgresApprovalBudgetRepository(database.pool)
  const projectRoot = config.workspaceStorageRoot ?? workspaceStorageRoot()
  const locations = new WorkspaceLocationService(database.pool, commands, config.harnesses.workspaceRoot, 'runner-local', projectRoot)
  const workflows = new PostgresWorkflowRepository(database.pool)
  const runs = new PostgresRunRepository(database.pool, workflows, locations)
  const workspaces = new PostgresWorkspaceRepository(database.pool, workflows, runs)
  const settings = new PostgresSettingsRepository(database.pool)
  const foundationSettings = new PostgresFoundationSettingsRepository(database.pool, projectRoot)
  const operators = new PostgresOperatorRepository(database.pool)
  const rollout = new NativeRollout(process.env)
  const harnessCompatibility = createHarnessCompatibility(config.harnesses)
  const qualifier = new NativeHarnessConfigurationQualifier(config.harnesses.codexBinary, config.harnesses.openCodeBinary)
  const harnessCatalog = new HarnessCatalogService(qualifier, settings, commands, config.harnesses.workspaceRoot)
  const nativeConfigurations = new NativeConfigurationService(
    config.harnesses.codexBinary, config.harnesses.openCodeBinary, config.harnesses.workspaceRoot,
  )
  const endpointHost = config.host === '0.0.0.0' ? '127.0.0.1'
    : config.host === '::' || config.host === '::1' ? '[::1]' : config.host
  const appMcpEndpoint = `http://${endpointHost}:${config.port}/mcp/tools`
  const operatorMcpEndpoint = `http://${endpointHost}:${config.port}/mcp/operator`
  const harnessSettings = {
    directories: new HarnessDirectoryBrowser([projectRoot], database.pool),
    mcp: new HarnessMcpSettingsService(database.pool, commands, {
      codex: new CodexMcpConnections(config.harnesses.codexBinary, config.harnesses.workspaceRoot, processRegistry.scope('settings:mcp:codex')),
      opencode: new OpenCodeMcpConnections(config.harnesses.openCodeBinary, config.harnesses.workspaceRoot, processRegistry.scope('settings:mcp:opencode')),
    }, () => { harnessCatalog.invalidateChecks(); nativeConfigurations.invalidateOptions() }, async () => {
      await Promise.all([processRegistry.closeOwner('settings:mcp:codex'), processRegistry.closeOwner('settings:mcp:opencode')])
    }, operatorMcpEndpoint),
  }
  const managers = new ExecutionScopedNativeSessionManagerResolver((context) => {
    const configuration = context.configuration.harness
    if (configuration.harness !== context.harness) {
      throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The pinned configuration does not match the execution harness.', 409)
    }
    if (configuration.harness === 'codex') return new CodexAppServerSessionManager(config.harnesses.codexBinary, undefined, undefined,
      processRegistry.scope(`execution:${context.executionId}`))
    return new OpenCodeNativeSessionManager({
      server: new ManagedOpenCodeServer({
        binary: config.harnesses.openCodeBinary,
        workingDirectory: context.workingDirectory,
        ownerAgentId: context.agentId,
        processRecovery: processRegistry.scope(`execution:${context.executionId}`),
        ...(configuration.advanced ? { advancedConfiguration: configuration.advanced } : {}),
      }),
      ownerAgentId: context.agentId,
      responseJournal,
      expectedAppMcpEndpoint: appMcpEndpoint,
    })
  })
  const validateContinuation = continuationValidator(database.pool, locations)
  const credentials = new WorkerCredentialService(database.pool, access)
  const launchCredentials: ExecutionCredentialProvider = {
    async prepare(input) {
      await validateContinuation(input.executionId, input.signal)
      const execution = await runs.getExecution(input.executionId)
      if (!execution || execution.workingDirectory !== input.workingDirectory) {
        throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Credential preflight must use the accepted execution directory.', 409)
      }
      const configuration = await runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
      const run = await runs.get(execution.runId)
      if (!configuration || configuration.id !== execution.agentConfigurationVersionId
        || configuration.agentId !== execution.agentId || configuration.harness.harness !== input.harness
        || !run?.executionLocation || run.executionLocation.runnerId !== 'runner-local') {
        throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Credential preflight requires the pinned local execution identity.', 409)
      }
      const context = {
        executionId: execution.id, agentId: execution.agentId, harness: input.harness,
        workingDirectory: input.workingDirectory, configuration,
      }
      const { manager } = managers.resolve(context)
      const detection = new McpDetectionService(inspectorFor(manager), appMcpEndpoint)
      const launch = new WorkerLaunchCredentialService(detection, credentials, run.executionLocation.runnerId)
      try {
        return await launch.prepare(input)
      } catch (error) {
        // A model-free OpenCode preflight may have started its owned server.
        // Never retain that unauthenticated process after rejected issuance.
        if (manager instanceof OpenCodeNativeSessionManager) await manager.dispose().catch(() => undefined)
        managers.release(context)
        throw error
      }
    },
    revoke: (credential) => credentials.revoke(credential),
    revokeForExecution: (executionId) => credentials.revokeForExecution(executionId),
    revokeForRun: (runId, client) => credentials.revokeForRun(runId, client),
    reconcileTerminalCredentials: () => credentials.reconcileTerminalCredentials(),
    renew: (executionId, credential) => credentials.renewForExecution(executionId, credential),
  }
  const approvals = new ApprovalExecutionCoordinator(
    runs, repository, budgets, managers, config.harnesses.timeoutMs, launchCredentials, validateContinuation,
    (executionId, signal) => processRegistry.closeOwner(`execution:${executionId}`, signal),
  )
  const reviewLifecycle: { current?: AutomaticReviewService } = {}
  const engine = new LangGraphWorkflowEngine(
    runs, workflows, approvals, checkpoints.saver, config.harnesses.workspaceRoot,
    locations, launchCredentials, repository,
    (runId, reason) => {
      if (!reviewLifecycle.current) throw new Error('Automatic review lifecycle is not initialized.')
      return reviewLifecycle.current.stopRun(runId, reason)
    },
  )
  const interactions = new InteractionService(
    repository, budgets, approvals, (interaction) => engine.resumeInteraction(interaction), responseJournal,
  )
  const operatorWorkingDirectory = resolve(config.harnesses.workspaceRoot, 'operator')
  const operatorManagers = new Map<string, NativeHarnessSessionManager>()
  const resolveOperatorManager: NativeManagerResolver = (configuration, conversationId) => {
    const existing = operatorManagers.get(conversationId)
    if (existing) return existing
    let manager: NativeHarnessSessionManager
    if (configuration.harness.harness === 'codex') {
      manager = new CodexAppServerSessionManager(config.harnesses.codexBinary, undefined, 'graphql-operator',
        processRegistry.scope(`conversation:${conversationId}`))
    } else {
      const server = new ManagedOpenCodeServer({
        binary: config.harnesses.openCodeBinary,
        workingDirectory: operatorWorkingDirectory,
        ownerAgentId: configuration.operatorId,
        processRecovery: processRegistry.scope(`conversation:${conversationId}`),
        credentialEnvironmentVariable: OPERATOR_MCP_ENVIRONMENT_VARIABLE,
        ...(configuration.harness.advanced ? { advancedConfiguration: configuration.harness.advanced } : {}),
      })
      manager = new OpenCodeNativeSessionManager({
        server,
        ownerAgentId: configuration.operatorId,
        appMcpServerName: 'graphql-operator',
        responseJournal,
        expectedAppMcpEndpoint: operatorMcpEndpoint,
        credentialEnvironmentVariable: OPERATOR_MCP_ENVIRONMENT_VARIABLE,
      })
    }
    operatorManagers.set(conversationId, manager)
    return manager
  }
  resolveOperatorManager.release = (conversationId) => { operatorManagers.delete(conversationId) }
  const chatAuthority = new PostgresOperatorChatAuthority(
    database.pool, access, rollout, operatorWorkingDirectory, operatorMcpEndpoint,
  )
  const chat = new OperatorChatService(
    new PostgresOperatorConversationRepository(database.pool), operators,
    resolveOperatorManager, operatorWorkingDirectory, chatAuthority,
  )
  const reviews = new AutomaticReviewService(database.pool, runs, approvals, chat, access, locations, rollout)
  reviewLifecycle.current = reviews
  const operatorServices = {
    operatorChat: chat,
    workspaces: new WorkspaceManagementService(database.pool, commands, locations, foundationSettings),
    locations,
    workflows: new WorkflowManagementService(database.pool, commands),
    agents: new AgentManagementService(database.pool),
    drafts: new GraphDraftService(database.pool, commands),
    harnesses: harnessCatalog,
    settings: new FoundationSettingsManagementService(foundationSettings, commands, harnessCatalog, operators),
    runs: new RunManagementService(database.pool, commands, runs, engine, locations),
    commands,
    interactions: new OperatorInteractionService(interactions, repository),
  }
  const detection = new McpDetectionService({
    async inspect(input) {
      if (input.runnerId !== 'runner-local') {
        throw new DomainError('RUNNER_UNSUPPORTED', 'This API can inspect only its local runner.', 409)
      }
      if (input.harness === 'codex') {
        return codexMcpInspectorAdapter(new CodexAppServerSessionManager(config.harnesses.codexBinary)).inspect(input)
      }
      // Workspace diagnostics are model-free: no durable session or credential
      // is created. Execution preflight above uses the pinned Agent manager.
      const manager = new OpenCodeNativeSessionManager({
        server: new ManagedOpenCodeServer({
          binary: config.harnesses.openCodeBinary, workingDirectory: input.workingDirectory,
          ownerAgentId: 'mcp-inspection',
        }),
        ownerAgentId: 'mcp-inspection', expectedAppMcpEndpoint: appMcpEndpoint,
      })
      try {
        return await openCodeMcpInspectorAdapter(manager).inspect(input)
      } finally {
        await manager.dispose()
      }
    },
  }, appMcpEndpoint)
  const operatorExtensions = createOperatorExtensions({
    pool: database.pool, commands, catalog: harnessCatalog, native: nativeConfigurations,
    detection, engine, runs: operatorServices.runs, locations,
    provisioningRoot: projectRoot,
  })
  const app = buildApp({
    ...(config.browserAuth ? { browserAuth: new BrowserAuthentication(database.pool, access, config.browserAuth) } : {}),
    readiness: { database, checkpoints },
    readinessTimeoutMs: config.readinessTimeoutMs,
    harnessCompatibility,
    product: { workspaces, workflows, runs, settings, foundationSettings, engine, interactions, chat },
    operator: { access, services: { ...operatorServices, extensions: operatorExtensions, harnessSettings } },
    appMcp: { access, interactions: new PostgresAppInteractionService(database.pool, repository, commands, interactions) },
    mcpDetection: { pool: database.pool, service: detection },
    logger,
  })
  let closing = false
  let httpClosing = false
  let initialized = false
  let initialization: Promise<void> | undefined
  let reconciliation: Promise<void> | undefined
  let applicationClose: Promise<void> | undefined
  const runtimeOwner = new OperatorRuntimeOwner(config.database.connectionString, (error) => {
    app.log.error({ err: error }, 'native runtime ownership lost; stopping execution')
    beginShutdown()
    // Never re-enter/await app.close() from an onClose cleanup. The failed
    // connection has already lost its lock; native recovery fencing still applies.
    if (!httpClosing) void shutdown().catch((failure: unknown) => {
      app.log.error({ err: failure }, 'shutdown after native runtime ownership loss failed')
    })
  })
  const lifecycle = new RuntimeShutdown({
    stop: [
      { name: 'harness compatibility diagnostics', run: () => harnessCompatibility.close() },
      { name: 'native MCP settings', run: () => harnessSettings.mcp.shutdown() },
      { name: 'harness qualification checks', run: () => Promise.all([harnessCatalog.shutdownChecks(), nativeConfigurations.shutdownChecks()]).then(() => undefined) },
      { name: 'workflow triggers', run: () => operatorExtensions.triggers.shutdown() },
      { name: 'Operator chat', run: () => chat.shutdown() },
      { name: 'automatic reviews', run: () => reviews.shutdown() },
      { name: 'workflow engine', run: () => engine.shutdown() },
    ],
    drain: [
      // Initialization errors belong to initialize()'s caller, not to cleanup.
      // Wait for its last DB/filesystem operation even if startup was canceled.
      { name: 'initialization', run: () => initialization?.then(() => undefined, () => undefined) },
      { name: 'reconciliation', run: () => reconciliation },
    ],
    dispose: [
      { name: 'execution native managers', run: () => managers.dispose() },
      { name: 'remaining Operator native managers', run: async () => {
        // Snapshot only after all producers have drained. Keep failed disposals
        // visible instead of clearing their ownership records unconditionally.
        const results = await Promise.allSettled([...operatorManagers.entries()].map(async ([id, manager]) => {
          const disposable = manager as NativeHarnessSessionManager & { dispose?: () => Promise<void> }
          if (!disposable.dispose) throw new Error('An owned native manager has no disposal contract.')
          await disposable.dispose()
          if (operatorManagers.get(id) === manager) operatorManagers.delete(id)
        }))
        const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, 'Operator native manager disposal was incomplete.')
      } },
    ],
    // Independent of initialized: startup can acquire ownership and then fail.
    releaseOwnership: () => runtimeOwner.close(),
  })
  const beginShutdown = (): void => {
    closing = true
    lifecycle.begin()
  }
  const assertOpen = (): void => {
    if (closing) throw new DomainError('NATIVE_RUNTIME_CLOSING', 'The native runtime is shutting down.', 503)
  }
  const initialize = (): Promise<void> => {
    if (closing) return Promise.reject(new DomainError('NATIVE_RUNTIME_CLOSING', 'The native runtime is shutting down.', 503))
    if (initialized) return Promise.resolve()
    // Coalesce startup and publish its lifetime before starting any async work.
    initialization ??= Promise.resolve().then(async () => {
      assertOpen()
      await runtimeOwner.acquire()
      assertOpen()
      const canonicalDirectory = await ensureOperatorRuntimeDirectory(config.harnesses.workspaceRoot)
      assertOpen()
      if (canonicalDirectory !== operatorWorkingDirectory) {
        throw new DomainError('OPERATOR_RUNTIME_DIRECTORY_INVALID', 'The canonical Operator directory differs from the configured managed path.', 422)
      }
      const operator = await operators.ensure()
      assertOpen()
      const defaults = await foundationSettings.getAgentDefaults()
      assertOpen()
      if (!isDeepStrictEqual(operator.configuration.harness, defaults.value.operator.harness)) {
        await operators.update(defaults.value.operator.harness, operator.operator.currentConfigurationVersionId)
        assertOpen()
      }
      await chatAuthority.revokeOrphanedCredentials()
      assertOpen()
      await harnessSettings.mcp.recover()
      assertOpen()
      // Optional discovery warmups used to block startup on native auth/network.
      // Qualification still runs at every existing on-demand configuration/execution gate.
      // The bounded compatibility diagnostic creates no native session or model turn.
      harnessCompatibility.start()
      assertOpen()
      initialized = true
    })
    // On failure the startup caller closes the app. Only the shared shutdown
    // barrier may release the owner, after any already-admitted work drains.
    return initialization
  }
  const reconcile = (report: (error: unknown) => void): Promise<void> => {
    if (closing) return Promise.resolve()
    if (reconciliation) return reconciliation
    reconciliation = (async () => {
      await engine.reconcile(report)
      if (closing) return
      if (initialized) {
        await chat.reconcileActive()
        if (closing) return
        await reviews.tick()
        if (!closing) await operatorExtensions.triggers.tick(report)
      }
      let afterId: string | undefined
      do {
        if (closing) return
        const page = await interactions.recover({ limit: 100, ...(afterId ? { afterId } : {}) })
        for (const failure of page.errors) report(new Error(`Interaction ${failure.interactionId}: ${failure.error}`))
        afterId = page.nextCursor ?? undefined
      } while (afterId)
    })().finally(() => { reconciliation = undefined })
    return reconciliation
  }
  app.addHook('preClose', async () => {
    httpClosing = true
    beginShutdown()
    // Signal now, but do not release ownership before in-flight HTTP handlers
    // have drained. They may still finish native/DB lifecycle operations.
  })
  // This hook-only boundary never calls app.close(). server.ts uses it before
  // closing database/checkpoint resources, whichever onClose hook runs first.
  const drainShutdown = (): Promise<void> => {
    httpClosing = true
    beginShutdown()
    return lifecycle.finish()
  }
  app.addHook('onClose', async () => { await drainShutdown() })
  const shutdown = (): Promise<void> => {
    beginShutdown()
    // External callers close HTTP first. Repeated calls share app.close(), and
    // cannot release ownership while HTTP is draining in preClose.
    // onClose hooks must use drainShutdown(), not await this enclosing close.
    applicationClose ??= Promise.resolve().then(() => app.close())
    return applicationClose
  }
  return { app, engine, initialize, reconcile, shutdown, drainShutdown }
}
