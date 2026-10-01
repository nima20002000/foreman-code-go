import { createWorkflowNativeCaptureChannel } from './modules/interactions/workflowNativeCapture.js'
import { createReviewNativeCaptureChannel } from './modules/interactions/reviewNativeCapture.js'
import { ReviewNativeProofServices } from './modules/interactions/reviewNativeProof.js'
import { PostgresRepeatReviewerBindings } from './modules/interactions/repeatReviewer.js'
import { createWorkflowRepositoryServices } from './modules/runs/workflowRepositoryServices.js'
import { readRuntimeIdentity } from './infrastructure/runtimeIdentity.js'
import { fileURLToPath } from 'node:url'
import { AppMcpRoutes } from './modules/harnesses/appMcpRoutes.js'
import { registerApprovalCheckpointResume } from './modules/runs/approvalCheckpointRegistration.js'
import { createCurrentNativeProductionFactory, isCurrentNativeProductionBinding } from './modules/runs/workflowProduction.js'
import { isDeepStrictEqual } from 'node:util'
import { NativeResponseJournal } from './modules/harnesses/recovery/responseJournal.js'
import { NativeProcessRegistry, type NativeProcessRecovery } from './modules/harnesses/recovery/processRegistry.js'
import { resolve } from 'node:path'

import type { ApiConfig } from './config.js'
import { buildApp } from './app.js'
import { FileRetentionService } from './modules/files/retention.js'
import { registerFileRetentionRoutes } from './routes/fileRetention.js'
import { createOperatorExtensions } from './mcp/operator/extensions.js'
import { NativeConfigurationService } from './modules/harnesses/nativeConfiguration.js'
import { HarnessMcpSettingsService } from './modules/harnesses/mcpSettings.js'
import { CodexPluginSettingsService } from './modules/harnesses/codexPluginSettings.js'
import { NativeCodexPlugins } from './modules/harnesses/codexPlugins.js'
import { workspaceStorageRoot } from './modules/workspaces/storage.js'
import { HarnessDirectoryBrowser } from './modules/harnesses/directoryBrowser.js'
import { CodexMcpConnections } from './modules/harnesses/codexMcpConnections.js'
import { OpenCodeMcpConnections } from './modules/harnesses/openCodeMcpConnections.js'
import type { CheckpointStore } from './infrastructure/checkpoints.js'
import type { createDatabase } from './infrastructure/database.js'
import { OperatorRuntimeOwner } from './infrastructure/operatorRuntimeOwner.js'
import { RuntimeShutdown } from './infrastructure/runtimeShutdown.js'
import { PostgresAccessService } from './modules/access/postgres.js'
import { LocalDevBrowserAccess } from './modules/access/localDevBrowser.js'
import { BrowserAuthentication } from './modules/browser-auth/service.js'
import { Wave25WorkerCredentialService as WorkerCredentialService } from './modules/interactions/wave25/credentials.js'
import {
  ensureOperatorRuntimeDirectory,
  OperatorChatService,
  PostgresOperatorConversationRepository,
} from './modules/conversations/operatorChat.js'
import { PostgresOperatorChatAuthority } from './modules/conversations/operatorChatAuthority.js'
import { AgentChatService, type AgentChatManagerFactory } from './modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from './modules/conversations/agentChatRepository.js'
import { PostgresCommandCoordinator } from './modules/commands/postgres.js'
import { DomainError } from './modules/errors.js'
import { HarnessCatalogService } from './modules/harnesses/catalog.js'
import { createHarnessCompatibility } from './modules/harnesses/compatibility/service.js'
import { HarnessQualificationRepository } from './modules/harnesses/qualification/repository.js'
import { HarnessQualificationRegistry } from './modules/harnesses/qualification/registry.js'
import { HarnessQualificationService } from './modules/harnesses/qualification/service.js'
import { clearQualificationGate, installQualificationGate } from './modules/harnesses/qualification/gate.js'
import type { QualificationSuite } from './modules/harnesses/qualification/types.js'
import type { CompatibilityHarness } from '@graphql/contracts'
import { CodexAppServerSessionManager } from './modules/harnesses/codexAppServer.js'
import { productionCodexChatFiles, type ProductionCodexChatFiles } from './modules/harnesses/codexFiles/production.js'
import { codexMcpInspectorAdapter } from './modules/harnesses/codexMcpInspectorAdapter.js'
import { McpDetectionService, WorkerLaunchCredentialService, type ExecutionCredentialProvider } from './modules/harnesses/mcpDetection.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from './modules/harnesses/opencodeServer.js'
import { productionOpenCodeChatFiles } from './modules/harnesses/opencodeFiles/production.js'
import { productionOperatorManagers } from './modules/harnesses/operatorFiles/managers.js'
import { openCodeMcpInspectorAdapter } from './modules/harnesses/opencodeMcpInspectorAdapter.js'
import { ExecutionReadinessService } from './modules/harnesses/executionReadiness.js'
import { NativeRollout } from './modules/harnesses/nativeRollout.js'
import type { NativeHarnessSessionManager } from './modules/harnesses/port.js'
import { NativeHarnessConfigurationQualifier } from './modules/harnesses/nativeConfigurationQualifier.js'
import { PostgresAppInteractionService } from './modules/interactions/app.js'
import { PostgresApprovalBudgetRepository } from './modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from './modules/interactions/execution.js'
import { PostgresWorkflowClosureStore } from './modules/interactions/workflowClosure.js'
import { OperatorInteractionService } from './modules/interactions/operator.js'
import { Wave25InteractionRepository as PostgresInteractionRepository } from './modules/interactions/wave25/repository.js'
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
import { RunGraphReadService } from './modules/run-graph/readService.js'
import type { CurrentRunProductionFactory, CurrentRunProductionBinding, CurrentStopContext } from './modules/runs/currentProduction.js'
import type { FastifyBaseLogger } from 'fastify'
import { componentLogger } from './infrastructure/logger.js'

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
  // The shared API logger by default; tests pass false.
  logger: boolean | FastifyBaseLogger = componentLogger('http'),
  createCurrentProduction?: CurrentRunProductionFactory,
  // Trusted FIL-10 admission + execution-host ports; never populated from HTTP fields.
  codexChatFiles?: ProductionCodexChatFiles,
  qualificationSuites?: Record<CompatibilityHarness, QualificationSuite>,
) {
  const responseJournal = new NativeResponseJournal(resolve(config.harnesses.workspaceRoot, 'native-response-receipts'))
  const processRegistry = new NativeProcessRegistry(resolve(config.harnesses.workspaceRoot, 'native-process-registry'))
  const access = new PostgresAccessService(database.pool)
  const commands = new PostgresCommandCoordinator(database.pool)
  // Producer/consumer halves are installed during construction. Neither HTTP,
  // MCP nor a caller-supplied JSON observation can manufacture these captures.
  const workflowCapture = createWorkflowNativeCaptureChannel()
  const reviewCapture = createReviewNativeCaptureChannel()
  const workflowRuntime = createWorkflowRepositoryServices(workflowCapture.verify)
  const reviewNativeProofs = new ReviewNativeProofServices(reviewCapture.verify)
  const repository = new PostgresInteractionRepository(database.pool, reviewNativeProofs)
  const budgets = new PostgresApprovalBudgetRepository(database.pool)
  const projectRoot = config.workspaceStorageRoot ?? workspaceStorageRoot()
  const locations = new WorkspaceLocationService(database.pool, commands, config.harnesses.workspaceRoot, 'runner-local', projectRoot)
  const workflows = new PostgresWorkflowRepository(database.pool)
  const runs = new PostgresRunRepository(database.pool, workflows, locations,
    { runtimeRoot: config.harnesses.workspaceRoot, ...workflowRuntime })
  const workspaces = new PostgresWorkspaceRepository(database.pool, workflows, runs)
  const settings = new PostgresSettingsRepository(database.pool)
  const foundationSettings = new PostgresFoundationSettingsRepository(database.pool, projectRoot)
  const operators = new PostgresOperatorRepository(database.pool)
  const rollout = new NativeRollout(process.env)
  const qualificationRepository = new HarnessQualificationRepository(database.pool)
  const qualificationRegistry = qualificationSuites ? new HarnessQualificationRegistry(qualificationRepository, {
    codex: qualificationSuites.codex.revision, opencode: qualificationSuites.opencode.revision,
  }) : undefined
  const harnessQualifications = qualificationSuites && qualificationRegistry ? new HarnessQualificationService(
    qualificationRepository, qualificationRegistry, qualificationSuites,
    { codex: config.harnesses.codexBinary, opencode: config.harnesses.openCodeBinary }, commands, settings,
    undefined, (harness) => harnessCompatibility.refreshAfterQualification(harness),
  ) : undefined
  const harnessCompatibility = createHarnessCompatibility(config.harnesses, harnessQualifications
    ? (harness) => { void harnessQualifications.begin(harness).catch(() => undefined) }
    : undefined)
  const qualifier = new NativeHarnessConfigurationQualifier(config.harnesses.codexBinary, config.harnesses.openCodeBinary)
  const harnessCatalog = new HarnessCatalogService(qualifier, settings, commands, config.harnesses.workspaceRoot)
  const nativeConfigurations = new NativeConfigurationService(
    config.harnesses.codexBinary, config.harnesses.openCodeBinary, config.harnesses.workspaceRoot,
  )
  const endpointHost = config.host === '0.0.0.0' ? '127.0.0.1'
    : config.host === '::' || config.host === '::1' ? '[::1]' : config.host
  // One endpoint for every role; the bearer credential decides Operator, Orchestrator or Coder.
  const appMcpEndpoint = `http://${endpointHost}:${config.port}/mcp`
  const appRoutes = new AppMcpRoutes(database.pool, appMcpEndpoint)
  const harnessSettings = {
    directories: new HarnessDirectoryBrowser([projectRoot], database.pool),
    plugins: new CodexPluginSettingsService(database.pool, new NativeCodexPlugins(config.harnesses.codexBinary, config.harnesses.workspaceRoot,
      processRegistry.scope('settings:plugins:codex')), () => processRegistry.closeOwner('settings:plugins:codex')),
    mcp: new HarnessMcpSettingsService(database.pool, commands, {
      codex: new CodexMcpConnections(config.harnesses.codexBinary, config.harnesses.workspaceRoot, processRegistry.scope('settings:mcp:codex')),
      opencode: new OpenCodeMcpConnections(config.harnesses.openCodeBinary, config.harnesses.workspaceRoot, processRegistry.scope('settings:mcp:opencode')),
    }, () => { harnessCatalog.invalidateChecks(); nativeConfigurations.invalidateOptions() }, async () => {
      await Promise.all([processRegistry.closeOwner('settings:mcp:codex'), processRegistry.closeOwner('settings:mcp:opencode')])
    }, appMcpEndpoint),
  }
  const launchScopes = new WeakMap<NativeHarnessSessionManager, NativeProcessRecovery>()
  const managers = new ExecutionScopedNativeSessionManagerResolver((context) => {
    const configuration = context.configuration.harness
    if (configuration.harness !== context.harness) {
      throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The pinned configuration does not match the execution harness.', 409)
    }
    // Object allocation remains native/registry IO-free. The coordinator reserves
    // this SAME scope immediately before its lifetime/entered commits.
    const recovery = processRegistry.scope(`execution:${context.executionId}`)
    const manager = configuration.harness === 'codex'
      ? new CodexAppServerSessionManager(config.harnesses.codexBinary, undefined, undefined, recovery)
      : new OpenCodeNativeSessionManager({
      server: new ManagedOpenCodeServer({
        binary: config.harnesses.openCodeBinary,
        workingDirectory: context.workingDirectory,
        ownerAgentId: context.agentId,
        processRecovery: recovery,
        ...(configuration.advanced ? { advancedConfiguration: configuration.advanced } : {}),
      }),
      ownerAgentId: context.agentId,
      responseJournal,
      expectedAppMcpEndpoint: appMcpEndpoint,
    })
    launchScopes.set(manager, recovery)
    return manager
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
      // The coordinator reserved and retained this exact manager lifetime
      // BEFORE preflight. It owns disposal + durable closure on every failure;
      // releasing an empty resolver here would destroy the only positive proof.
      const prepared = await launch.prepare(input)
      try { await appRoutes.refresh() } catch (error) { await credentials.revoke(prepared.credential); throw error }
      return prepared
    },
    revoke: (credential) => credentials.revoke(credential),
    revokeForExecution: (executionId) => credentials.revokeForExecution(executionId),
    revokeForRun: (runId, client) => credentials.revokeForRun(runId, client),
    reconcileTerminalCredentials: () => credentials.reconcileTerminalCredentials(),
    renew: async (executionId, credential) => {
      const expiresAt = await credentials.renewForExecution(executionId, credential)
      await appRoutes.refresh()
      return expiresAt
    },
  }
  const approvals = new ApprovalExecutionCoordinator(
    runs, repository, budgets, managers, config.harnesses.timeoutMs, launchCredentials, validateContinuation,
    new PostgresWorkflowClosureStore(database.pool), new PostgresRepeatReviewerBindings(database.pool),
    workflowCapture.capture, reviewCapture.capture,
    (executionId, signal) => processRegistry.closeOwner(`execution:${executionId}`, signal),
    (executionId, manager) => {
      const scope = launchScopes.get(manager)
      if (!scope || scope.owner !== `execution:${executionId}` || scope.launchId) throw new DomainError(
        'NATIVE_LAUNCH_RESERVATION_CONFLICT', 'The exact manager launch scope is unavailable or already reserved.', 409)
      Object.assign(scope, processRegistry.reserveLaunch(scope.owner))
    },
  )
  const engine = new LangGraphWorkflowEngine(
    runs, workflows, approvals, checkpoints.saver, config.harnesses.workspaceRoot,
    locations, launchCredentials, repository,
  )
  const interactions = new InteractionService(
    repository, budgets, approvals, (interaction) => engine.resumeInteraction(interaction), responseJournal,
  )
  registerApprovalCheckpointResume(interactions, engine)
  const operatorWorkingDirectory = resolve(config.harnesses.workspaceRoot, 'operator')
  const operatorManagers = new Map<string, NativeHarnessSessionManager>()
  const resolveOperatorManager = productionOperatorManagers({
    app: () => app, pool: database.pool, config, workingDirectory: operatorWorkingDirectory,
    endpointHost, appMcpEndpoint, processRegistry, responseJournal, managers: operatorManagers,
  })
  const chatAuthority = new PostgresOperatorChatAuthority(
    database.pool, access, rollout, operatorWorkingDirectory, appMcpEndpoint,
  )
  const chat = new OperatorChatService(
    new PostgresOperatorConversationRepository(database.pool), operators,
    resolveOperatorManager, operatorWorkingDirectory, chatAuthority,
  )
  const agentChatManagers = new Map<string, NativeHarnessSessionManager>()
  const resolveAgentChatManager: AgentChatManagerFactory = (conversationId, configuration, workingDirectory) => {
    const existing = agentChatManagers.get(conversationId)
    if (existing) return existing
    // Chat processes have their own owner scope; they never share a workflow execution's manager.
    const recovery = processRegistry.scope(`conversation:agent-chat:${conversationId}`)
    const harness = configuration.harness
    let manager: NativeHarnessSessionManager
    if (harness.harness === 'codex') {
      manager = new CodexAppServerSessionManager(config.harnesses.codexBinary, undefined, undefined, recovery, 'none',
        codexChatFiles ? productionCodexChatFiles(() => app, conversationId, codexChatFiles) : undefined)
    } else {
      const server = new ManagedOpenCodeServer({
        binary: config.harnesses.openCodeBinary, workingDirectory, ownerAgentId: configuration.agentId,
        processRecovery: recovery, appMcpAccess: 'none',
        ...(harness.advanced ? { advancedConfiguration: harness.advanced } : {}),
      })
      manager = new OpenCodeNativeSessionManager({
        server,
        ownerAgentId: configuration.agentId, responseJournal, expectedAppMcpEndpoint: appMcpEndpoint, appMcpAccess: 'none',
        chatFiles: productionOpenCodeChatFiles(() => app, database.pool, config, conversationId, server, endpointHost),
      })
    }
    agentChatManagers.set(conversationId, manager)
    return manager
  }
  resolveAgentChatManager.release = (conversationId) => { agentChatManagers.delete(conversationId) }
  const agentChat = new AgentChatService(database.pool, new PostgresAgentChatRepository(database.pool),
    new PostgresOperatorConversationRepository(database.pool), workflows, runs, resolveAgentChatManager, config.harnesses.workspaceRoot)
  const reviews = new AutomaticReviewService(database.pool, runs, approvals, locations, rollout,
    async (runId) => {
      // AutomaticReviewService committed the exact review cause and durable Stop
      // intent first. A process restart or failed closure cannot lose that cause.
      // The one engine owns negative settlement and cleanup. No extra terminal
      // writer follows a successful cancel, and uncertainty remains retryable.
      await engine.cancel(runId)
    })
  let closing = false
  let initialized = false
  // The callback executes only after app construction; no factory can swap the
  // actual constructor-held engine/repository/native/atomic-checkpoint ports.
  const nativeFactory = createCurrentNativeProductionFactory({
    isRuntimeOpen: () => initialized && !closing,
    reportDispatchFailure: (runId, code) => app.log.error({ runId, code }, 'current workflow dispatch remains unresolved'),
  })
  const productionContext = { primaryPool: database.pool, commands,
    runs, workflows, locations, engine, nativeExecutions: approvals, interactions, checkpointer: checkpoints.saver }
  const binding = (createCurrentProduction ?? nativeFactory)(productionContext)
  if (!isCurrentNativeProductionBinding(binding, productionContext)) throw new DomainError(
    'CURRENT_PRODUCTION_BINDING_REQUIRED', 'Production requires the concrete constructor-bound native lifecycle, not a shape-only publisher.', 503)
  // An injected genuine factory still cannot bypass the actual startup/shutdown
  // owner gate by supplying its own readiness callback.
  const assertRuntimeOpen = () => {
    if (!initialized || closing) throw new DomainError('CURRENT_RUNTIME_UNAVAILABLE',
      'The native runtime has not acquired ownership or is shutting down.', 503)
  }
  const currentProduction: CurrentRunProductionBinding = Object.freeze({
    startPublication: binding.startPublication,
    availability: () => initialized && !closing ? binding.availability() : { runtimeAdmission: false, stopAvailable: false },
    assertStartReady: () => { assertRuntimeOpen(); binding.assertStartReady() },
    assertStopReady: () => { assertRuntimeOpen(); binding.assertStopReady() },
    stop: (context: CurrentStopContext) => { assertRuntimeOpen(); return binding.stop(context) },
    reportDispatchFailure: (runId: string, error: unknown) => binding.reportDispatchFailure(runId, error),
  })

  const operatorServices = {
    fileRetention: new FileRetentionService(database.pool, commands),
    executionReadiness: new ExecutionReadinessService(rollout, harnessCatalog),
    operatorChat: chat,
    agentChat,
    workspaces: new WorkspaceManagementService(database.pool, commands, locations, foundationSettings),
    locations,
    workflows: new WorkflowManagementService(database.pool, commands),
    agents: new AgentManagementService(database.pool),
    harnesses: harnessCatalog,
    ...(harnessQualifications ? { harnessQualifications } : {}),
    settings: new FoundationSettingsManagementService(foundationSettings, commands, harnessCatalog, operators),
    runs: new RunManagementService(database.pool, commands, runs, engine, locations, currentProduction),
    commands,
    interactions: new OperatorInteractionService(interactions),
    // Reads and lifecycle mutations share the same canonical V3 journal.
    runGraph: new RunGraphReadService(database.pool, { qualifiedReads: true }),
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
    detection, locations,
    provisioningRoot: projectRoot,
  })
  const app = buildApp({
    runtimeIdentity: () => readRuntimeIdentity(database.pool, fileURLToPath(new URL('../../../', import.meta.url)), config.database.connectionString),
    ...(config.browserAuth ? { browserAuth: new BrowserAuthentication(database.pool, access, config.browserAuth) } : {}),
    ...(config.localDevBrowserAccess ? { localDevBrowserAccess: new LocalDevBrowserAccess(
      database.pool, access, config.localDevBrowserAccess.origin, config.localDevBrowserAccess.principalId,
    ) } : {}),
    readiness: { database, checkpoints },
    readinessTimeoutMs: config.readinessTimeoutMs,
    harnessCompatibility,
    product: { workspaces, workflows, runs, settings, foundationSettings, engine, interactions, chat },
    operator: { access, services: { ...operatorServices, extensions: operatorExtensions, harnessSettings } },
    appMcp: { access, interactions: new PostgresAppInteractionService(database.pool, repository, commands, interactions) },
    mcpDetection: { pool: database.pool, service: detection },
    logger,
  })
  registerFileRetentionRoutes(app, operatorServices.fileRetention)
  let httpClosing = false
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
      { name: 'harness qualification gate', run: async () => { if (qualificationRegistry) clearQualificationGate() } },
      { name: 'native MCP settings', run: () => harnessSettings.mcp.shutdown() },
      { name: 'Codex plugin settings', run: () => harnessSettings.plugins.shutdown() },
      { name: 'harness qualification checks', run: () => Promise.all([harnessCatalog.shutdownChecks(), nativeConfigurations.shutdownChecks()]).then(() => undefined) },
      { name: 'Operator chat', run: () => chat.shutdown() },
      { name: 'Agent chat', run: () => agentChat.shutdown() },
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
      { name: 'GraphQL MCP routes', run: () => appRoutes.close() },
      { name: 'execution native managers', run: async () => {
        // Ordinary restart must persist the exact retained Worker/reviewer
        // closes before raw disposal loses their manager lifetime identities.
        // Still dispose all allocations after a receipt failure, but propagate
        // that failure so shutdown cannot release runtime ownership.
        const errors: unknown[] = []
        try { await approvals.closeForRestart() } catch (error) { errors.push(error) }
        try { await managers.dispose() } catch (error) { errors.push(error) }
        if (errors.length) throw new AggregateError(errors, 'Execution native manager disposal was incomplete.')
      } },
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
      await appRoutes.refresh()
      assertOpen()
      await harnessSettings.mcp.recover()
      assertOpen()
      await harnessSettings.plugins.recover()
      assertOpen()
      // Optional discovery warmups used to block startup on native auth/network.
      // Qualification still runs at every existing on-demand configuration/execution gate.
      // The bounded compatibility diagnostic creates no native session or model turn.
      if (qualificationRegistry && harnessQualifications) {
        await qualificationRegistry.load()
        installQualificationGate(qualificationRegistry, harnessQualifications)
      }
      harnessCompatibility.start()
      assertOpen()
      initialized = true
      // Reconcile chat turns interrupted by the previous process; never blocks startup.
      void agentChat.recover().catch((error: unknown) => app.log.error({ err: error }, 'agent chat recovery failed'))
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
        await appRoutes.refresh()
        if (closing) return
        await chat.reconcileActive()
        if (closing) return
        await reviews.tick()
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
