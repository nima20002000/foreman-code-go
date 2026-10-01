import { randomUUID } from 'node:crypto'
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
import { registerProductionFileStorage } from './modules/files/production.js'
import type { TemporaryFileService } from './modules/files/service.js'
import { defaultFileStorageRoot } from './modules/files/storage.js'
import { postgresCodexChatFiles } from './modules/harnesses/codexFiles/chatAdmission.js'
import { codexChatHostDirectory, localCodexChatHost } from './modules/harnesses/codexFiles/localHost.js'
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
import { FileCompatibilityCache } from './modules/harnesses/compatibility/cache.js'
import { scopedCompatibilityProbe } from './modules/harnesses/compatibility/scopedProbe.js'
import { HarnessCompatibilityService } from './modules/harnesses/compatibility/service.js'
import { HarnessQualificationRepository } from './modules/harnesses/qualification/repository.js'
import { HarnessQualificationRegistry } from './modules/harnesses/qualification/registry.js'
import { HarnessQualificationService } from './modules/harnesses/qualification/service.js'
import { clearQualificationGate, installQualificationGate } from './modules/harnesses/qualification/gate.js'
import type { QualificationSuite } from './modules/harnesses/qualification/types.js'
import { withNativeQualificationOwnership } from './modules/harnesses/qualification/nativeOwnership.js'
import { withQualificationIdentity } from './modules/harnesses/qualification/identity.js'
import type { CompatibilityHarness } from '@graphql/contracts'
import { NativeHarnessFactories } from './modules/harnesses/runtimeFactory.js'
import type { ProductionHarnessInfrastructure } from './modules/harnesses/productionInfrastructure.js'
import { productionCodexChatFiles, type ProductionCodexChatFiles } from './modules/harnesses/codexFiles/production.js'
import { McpDetectionService, WorkerLaunchCredentialService, type ExecutionCredentialProvider } from './modules/harnesses/mcpDetection.js'
import { productionOpenCodeChatFiles } from './modules/harnesses/opencodeFiles/production.js'
import { productionOperatorManagers } from './modules/harnesses/operatorFiles/managers.js'
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
import { ProductionDeviceRuntime } from './modules/devices/productionRuntime.js'
import { ProductionHarnessRegistry } from './modules/harnesses/productionRegistry.js'
import { ProductionHostHarnessProfileQualifier } from './modules/harnesses/productionProfileQualifier.js'
import { HarnessInstanceSettingsRepository } from './modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from './modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessInstanceProfileChecks } from './modules/harnesses/instanceSettings/profileChecks.js'
import { HostHarnessOverrideService, type HostHarnessOverrideAuthority } from './modules/harnesses/instanceSettings/service.js'
import { commandInputHash } from './modules/commands/postgres.js'
import { authorizeDeviceHost } from './modules/devices/hostAuthorization.js'

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
  infrastructure?: ProductionHarnessInfrastructure,
) {
  if (infrastructure?.mode === 'replay' && (!infrastructure.auxiliary
    || !infrastructure.auxiliary.compatibility || !infrastructure.auxiliary.plugins
    || !infrastructure.auxiliary.mcp?.codex || !infrastructure.auxiliary.mcp.opencode
    || !infrastructure.auxiliary.command || !infrastructure.auxiliary.recovery || !infrastructure.inventoryDiscovery || qualificationSuites)) {
    throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Replay must inject settings and probes and cannot run installed CLI qualification.', 500)
  }
  let fileStorage: TemporaryFileService | undefined
  const fileStorageRoot = config.fileStorageRoot ?? defaultFileStorageRoot()
  const chatFileAdmissions = codexChatFiles ?? postgresCodexChatFiles(database.pool, () => {
    if (!fileStorage) throw new Error('Production file storage is not registered.')
    return fileStorage
  }, () => localCodexChatHost(fileStorageRoot), codexChatHostDirectory(fileStorageRoot))
  const responseJournal = new NativeResponseJournal(resolve(config.harnesses.workspaceRoot, 'native-response-receipts'))
  const processRegistry = infrastructure?.auxiliary?.recovery
    ?? new NativeProcessRegistry(resolve(config.harnesses.workspaceRoot, 'native-process-registry'))
  const access = new PostgresAccessService(database.pool)
  const deviceRuntime = new ProductionDeviceRuntime(database.pool, infrastructure?.deviceListener, {
    extensions: [
      { namespace: 'harness-discovery-v1', version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: 'host-harness-check-v1', version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      ...(infrastructure?.deviceDomains?.extensions ?? []),
    ],
    async reconcile(binding, signal, endpoint) {
      if (endpoint.capabilities(binding.deviceId).some((item) => item.namespace === 'harness-discovery-v1' && item.mainCanRequest)) {
        const result = await endpoint.request(binding.deviceId, 'harness-discovery-v1',
          { operation: 'discover', refreshId: randomUUID() }, { signal })
        signal.throwIfAborted()
        harnessRegistry.acceptRemoteSnapshot(binding, result.payload)
      }
      if (infrastructure?.deviceDomains) await infrastructure.deviceDomains.reconcile(binding, signal, endpoint)
    },
  })
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
  const hostProfileEvidence = new HostHarnessProfileEvidenceRepository(database.pool)
  const harnessRegistry = new ProductionHarnessRegistry(database.pool, config.harnesses,
    (client) => settings.getManagedHarnessDefaults(client), hostProfileEvidence,
    (deviceId) => { const view = deviceRuntime.presenceFor(deviceId); return view?.phase === 'ready' ? view.binding : null },
    process.env, infrastructure?.inventoryDiscovery, (deviceId) => deviceRuntime.currentBinding(deviceId),
    (deviceId) => deviceRuntime.presenceFor(deviceId))
  const foundationSettings = new PostgresFoundationSettingsRepository(database.pool, projectRoot)
  const operators = new PostgresOperatorRepository(database.pool)
  const rollout = new NativeRollout(process.env)
  const compatibilityProbe = (timeoutMs = 2000, expected?: { harness: CompatibilityHarness; binary: string }) => scopedCompatibilityProbe({
    registry: processRegistry, pin: (harness) => {
      const binding = harnessRegistry.pinDefault(harness)
      if (expected && (harness !== expected.harness || binding.installation.launcher.resolvedLauncher !== expected.binary)) {
        throw new DomainError('HARNESS_INSTALLATION_CHANGED', 'Diagnostics require the original inspected launcher.', 409)
      }
      return binding
    },
    assertInstallation: (binding, signal) => nativeFactories.assertInstallationUnchanged(binding, signal),
    workingDirectory: config.harnesses.workspaceRoot, environment: process.env, timeoutMs,
  })
  const qualificationRepository = new HarnessQualificationRepository(database.pool)
  const identity = infrastructure?.qualificationIdentity ?? {
    registry: harnessRegistry.installations, pin: (harness: CompatibilityHarness) => harnessRegistry.pinDefault(harness),
  }
  const selectedSuites = qualificationSuites && identity ? {
    codex: withQualificationIdentity(withNativeQualificationOwnership(qualificationSuites.codex, processRegistry,
      (input) => { const binding = identity.pin('codex', input); return (signal) => nativeFactories.assertInstallationUnchanged(binding, signal) }), identity.registry, (input) => identity.pin('codex', input)),
    opencode: withQualificationIdentity(withNativeQualificationOwnership(qualificationSuites.opencode, processRegistry,
      (input) => { const binding = identity.pin('opencode', input); return (signal) => nativeFactories.assertInstallationUnchanged(binding, signal) }), identity.registry, (input) => identity.pin('opencode', input)),
  } : qualificationSuites
  const qualificationRegistry = selectedSuites ? new HarnessQualificationRegistry(qualificationRepository, {
    codex: selectedSuites.codex.revision, opencode: selectedSuites.opencode.revision,
  }) : undefined
  const harnessQualifications = selectedSuites && qualificationRegistry ? new HarnessQualificationService(
    qualificationRepository, qualificationRegistry, selectedSuites,
    { codex: config.harnesses.codexBinary, opencode: config.harnesses.openCodeBinary }, commands, settings,
    undefined, (harness) => harnessCompatibility.refreshAfterQualification(harness),
    (harness, binary, timeoutMs) => compatibilityProbe(timeoutMs, { harness, binary }),
    (harness, signal) => {
      if (harness !== 'codex' && harness !== 'opencode') throw new DomainError('HARNESS_DRIVER_UNAVAILABLE', 'Unsupported qualification driver.', 409)
      return harnessRegistry.refreshMain(signal)
    },
  ) : undefined
  // Live qualification is an explicit authenticated operation; optional
  // compatibility diagnostics never start model turns during startup.
  const harnessCompatibility = infrastructure?.auxiliary
    ? new HarnessCompatibilityService(infrastructure.auxiliary.compatibility)
    : new HarnessCompatibilityService({ probe: compatibilityProbe(), cache: new FileCompatibilityCache() })
  const endpointHost = config.host === '0.0.0.0' ? '127.0.0.1'
    : config.host === '::' || config.host === '::1' ? '[::1]' : config.host
  // One endpoint for every role; the bearer credential decides Operator, Orchestrator or Coder.
  const appMcpEndpoint = `http://${endpointHost}:${config.port}/mcp`
  const nativeFactories = new NativeHarnessFactories({ ...config.harnesses, appMcpEndpoint, responseJournal,
    instances: harnessRegistry.instances, installations: harnessRegistry.installations,
    selectDefault: (harness) => harnessRegistry.pinDefault(harness),
    selectConfiguration: (configuration) => harnessRegistry.pinAccepted({
      id: `configuration-check:${commandInputHash(configuration)}`, agentId: 'configuration-qualification', harness: configuration,
    }),
    ...(infrastructure?.inventoryDiscovery ? { installationDiscovery: infrastructure.inventoryDiscovery.launcher } : {}),
    auxiliaryRecovery: (role) => processRegistry.scope(`${role}:${infrastructure?.mode === 'replay' ? infrastructure.codex.id() : randomUUID()}`),
    admitRecovery: (recovery) => { Object.assign(recovery, processRegistry.reserveLaunch(recovery.owner)) },
    abandonRecovery: async (recovery) => { await processRegistry.abandonReservedLaunch(recovery) },
    closeRecovery: async (recovery) => {
      if (!await processRegistry.closeOwner(recovery.owner)) throw new Error('Diagnostic native process closure is unconfirmed.')
    },
  }, infrastructure)
  const hostSettings = new HarnessInstanceSettingsRepository(database.pool)
  const hostAuthority: HostHarnessOverrideAuthority = { async authorize(principal, action, hostRef, applicationInstallationId, client) {
    if (client) { await authorizeDeviceHost(client, principal, action, hostRef, applicationInstallationId); return }
    const connection = await database.pool.connect()
    try {
      await connection.query('begin')
      await authorizeDeviceHost(connection, principal, action, hostRef, applicationInstallationId)
      await connection.query('commit')
    } catch (error) { await connection.query('rollback'); throw error } finally { connection.release() }
  } }
  const hostProfileChecks = new HostHarnessInstanceProfileChecks(hostSettings, hostProfileEvidence, commands, hostAuthority,
    new ProductionHostHarnessProfileQualifier(harnessRegistry, nativeFactories, () => deviceRuntime.endpointForDomains(), config.harnesses.workspaceRoot))
  const harnessInstances = new HostHarnessOverrideService(hostSettings, commands, hostAuthority, async (value, client) => {
    const proof = await harnessRegistry.profileEvidence(value, client)
    return proof ? { target: proof.target, configurationFingerprint: proof.configurationFingerprint, qualified: proof.qualified } : null
  }, hostProfileChecks)
  const qualifier = new NativeHarnessConfigurationQualifier(config.harnesses.codexBinary, config.harnesses.openCodeBinary, nativeFactories)
  const harnessCatalog = new HarnessCatalogService(qualifier, settings, commands, config.harnesses.workspaceRoot)
  const nativeConfigurations = new NativeConfigurationService(
    config.harnesses.codexBinary, config.harnesses.openCodeBinary, config.harnesses.workspaceRoot, nativeFactories,
    undefined, infrastructure?.auxiliary?.command,
  )
  const appRoutes = new AppMcpRoutes(database.pool, appMcpEndpoint)
  const harnessSettings = {
    directories: new HarnessDirectoryBrowser([projectRoot], database.pool),
    plugins: new CodexPluginSettingsService(database.pool, infrastructure?.auxiliary?.plugins ?? new NativeCodexPlugins(config.harnesses.codexBinary, config.harnesses.workspaceRoot,
      processRegistry.scope('settings:plugins:codex')), () => processRegistry.closeOwner('settings:plugins:codex')),
    mcp: new HarnessMcpSettingsService(database.pool, commands, {
      codex: infrastructure?.auxiliary?.mcp.codex ?? new CodexMcpConnections(config.harnesses.codexBinary, config.harnesses.workspaceRoot, processRegistry.scope('settings:mcp:codex')),
      opencode: infrastructure?.auxiliary?.mcp.opencode ?? new OpenCodeMcpConnections(config.harnesses.openCodeBinary, config.harnesses.workspaceRoot, processRegistry.scope('settings:mcp:opencode')),
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
    const selection = harnessRegistry.initialized ? harnessRegistry.pinAccepted(context.configuration) : undefined
    const { manager } = nativeFactories.allocate({
      ...(selection ? { selection } : {}),
      role: 'workflow', workingDirectory: context.workingDirectory, ownerAgentId: context.agentId,
      configured: { instanceId: selection?.instance.instanceId ?? context.agentId, instanceRevision: context.configuration.id, driverId: configuration.harness,
        enabled: true, configuration },
      processRecovery: recovery, appMcpAccess: 'scoped',
      ...(configuration.harness === 'codex' ? { harness: 'codex' as const }
        : { harness: 'opencode' as const, ...(configuration.advanced ? { advancedConfiguration: configuration.advanced } : {}) }),
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
      const detection = new McpDetectionService(nativeFactories.inspector(manager), appMcpEndpoint)
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
    (interaction) => approvals.inspectInteractionActivity(interaction),
  )
  registerApprovalCheckpointResume(interactions, engine)
  const operatorWorkingDirectory = resolve(config.harnesses.workspaceRoot, 'operator')
  const operatorManagers = new Map<string, NativeHarnessSessionManager>()
  const resolveOperatorManager = productionOperatorManagers({
    app: () => app, pool: database.pool, config, workingDirectory: operatorWorkingDirectory,
    endpointHost, appMcpEndpoint, processRegistry, responseJournal, managers: operatorManagers, nativeFactories,
    selectInstallation: (configuration) => harnessRegistry.initialized
      ? harnessRegistry.pinAccepted({ ...configuration, agentId: configuration.operatorId }) : undefined,
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
    const selection = harnessRegistry.initialized ? harnessRegistry.pinAccepted(configuration) : undefined
    const { manager } = nativeFactories.allocate({
      ...(selection ? { selection } : {}),
      role: 'agent-chat', workingDirectory, ownerAgentId: configuration.agentId,
      configured: { instanceId: selection?.instance.instanceId ?? configuration.agentId, instanceRevision: configuration.id, driverId: harness.harness,
        enabled: true, configuration: harness },
      processRecovery: recovery, appMcpAccess: 'none',
      ...(harness.harness === 'codex' ? { harness: 'codex' as const,
        chatFiles: productionCodexChatFiles(() => app, conversationId, chatFileAdmissions) }
        : { harness: 'opencode' as const,
          ...(harness.advanced ? { advancedConfiguration: harness.advanced } : {}),
          chatFiles: (server) => productionOpenCodeChatFiles(() => app, database.pool, config, conversationId, server, endpointHost) }),
    })
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
    devices: deviceRuntime.management,
    harnessInstances, harnessRegistry,
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
      // Diagnostics allocate their own credential-free child, never a workflow manager.
      const { manager, inspector } = nativeFactories.allocate({
        harness: input.harness, role: 'diagnostics', workingDirectory: input.workingDirectory,
        ownerAgentId: 'mcp-inspection', appMcpAccess: 'none',
      })
      try { return await inspector.inspect(input) } finally { await nativeFactories.disposeAuxiliary(manager) }
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
      { name: 'device admission and channels', run: async () => { deviceRuntime.stop() } },
      { name: 'canonical harness inventory and profile checks', run: async () => { harnessRegistry.stop(); await harnessInstances.closeChecks() } },
      { name: 'diagnostic and configuration qualification admission', run: async () => { nativeFactories.stopAuxiliaries() } },
      { name: 'live harness qualification admission', run: async () => { harnessQualifications?.stop() } },
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
      { name: 'device listener and admitted work', run: () => deviceRuntime.drain() },
      { name: 'live harness qualification', run: () => harnessQualifications?.join() },
      // Initialization errors belong to initialize()'s caller, not to cleanup.
      // Wait for its last DB/filesystem operation even if startup was canceled.
      { name: 'initialization', run: () => initialization?.then(() => undefined, () => undefined) },
      { name: 'reconciliation', run: () => reconciliation },
    ],
    dispose: [
      { name: 'diagnostic and configuration qualification native managers', run: () => nativeFactories.disposeAuxiliaries() },
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
      const machine = await deviceRuntime.initializeFromRuntime(() => readRuntimeIdentity(database.pool,
        fileURLToPath(new URL('../../../', import.meta.url)), config.database.connectionString))
      assertOpen()
      await harnessRegistry.initialize(machine.installationId)
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
  return { app, engine, initialize, reconcile, shutdown, drainShutdown,
    registerFileStorage: () => {
      fileStorage ??= registerProductionFileStorage(app, database.pool, config)
      return fileStorage
    }, startDeviceListener: () => deviceRuntime.startListener() }
}
