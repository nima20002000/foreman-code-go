import { WORKSPACE_ROOT_EXTENSION } from '@graphql/contracts/workspace-root-policies'
import { createMainRsyncEntrypoint } from './modules/byte-transfer/installedEntrypoints.js'
import { PostgresTrustedConnectionSetup } from './modules/devices/trustedConnectionSetup.js'
import { PostgresTrustedConnectionHumanAuthority, registerTrustedConnectionApprovalRoutes } from './modules/devices/trustedConnectionHumanAuthority.js'
import { registerTrustedConnectionRoutes } from './modules/devices/trustedConnectionManagement.js'
import { requirePrincipal } from './modules/access/http.js'
import { RsyncTransferAuthorizeRequestSchema } from '@graphql/contracts/byte-transfer'
import type { AcceptedTransferAuthority } from './modules/byte-transfer/carrier.js'
import type { InstalledMainRsyncProviders } from './modules/byte-transfer/productionComposition.js'
import { createInstalledRsyncComposition } from './modules/byte-transfer/productionComposition.js'
import { RSYNC_STAGE_EXTENSION, type TransferIntent } from '@graphql/contracts/byte-transfer'
import { transferContextForBinding } from './modules/byte-transfer/carrier.js'
import { JOB_RUNTIME_QUALIFICATION_EXTENSION } from '@graphql/contracts/job-runtime'
import { interactionConnection } from './modules/interactions/connection.js'
import { createProductionRemoteWorkflow } from './modules/placement/productionRemoteWorkflow.js'
import { placedContinuationValidator } from './modules/placement/continuation.js'
import { readLiveManagementPrincipal } from './modules/access/liveManagementPrincipal.js'
import { sameWorkflowValue } from '@graphql/contracts/wave25'
import { readSourceCurrentNativeSession } from './modules/sources/activeNativeSession.js'
import type { SourceActiveNativeSessionReader, SourceNativeSessionCaptureReader } from './modules/sources/executionHosts.js'
import { EXECUTION_AUTHORITY_EXTENSION } from '@graphql/contracts/execution-authority'
import { WORKER_MCP_EXTENSION } from '@graphql/contracts/worker-mcp-relay'
import { AgentPlacementProducer } from './modules/placement/agentProducer.js'
import { AgentExecutionPreparation } from './modules/placement/agentExecutionPreparation.js'
import { createExecutionAuthorityExtension } from './modules/placement/executionAuthority.js'
import { MainWorkerMcpRelay, selectedMainMcpForward } from './modules/placement/workerMcpRelay.js'
import { readAcceptedPlacement } from './modules/placement/persistence.js'
import type { RepeatRepositoryServices } from './modules/runs/repeatRepositoryHost.js'
import { SOURCE_OPERATION_EXTENSION } from '@graphql/contracts/source-operations'
import { BYTE_TRANSFER_NAMESPACE } from './modules/byte-transfer/carrier.js'
import { retainInstalledCodexInventory } from './modules/harnesses/installedCodexInspection.js'
import { readFile } from 'node:fs/promises'
import { RESOURCE_TELEMETRY_CAPABILITY, type TrustedTelemetryContext } from '@graphql/contracts/resource-telemetry'
import { createResourceTelemetryRuntime, type ResourceTelemetryRuntime } from './modules/resource-telemetry/runtime.js'
import { createPassiveTelemetryAuthorities } from './modules/resource-telemetry/productionAuthority.js'
import { registerResourceTelemetryRoutes } from './routes/resourceTelemetry.js'
import { registerResourceTelemetrySelectorRoutes } from './routes/resourceTelemetrySelector.js'
import { WorkspaceBoundLocationService } from './modules/workspace-roots/service.js'
import { bootstrapLocalMainWorkspaceRoot } from './modules/workspace-roots/localMainBootstrap.js'
import { registerWorkspaceRootRoutes } from './modules/workspace-roots/transports.js'
import type { OpenCodeServerController } from './modules/harnesses/opencodeTransport.js'
import { RemoteJobMainRpcRequestSchema } from '@graphql/contracts/remote-job-execution'
import { JOB_INPUT_NAMESPACE } from './modules/files/jobInputs/service.js'
import { PostgresWorkflowJobNodeStore, workflowJobStorePublication } from './modules/jobs/workflowStore.js'
import { createProductionJobs } from './modules/jobs/production.js'
import type { OperatorServices } from './mcp/operator/types.js'
import { registerJobRoutes } from './routes/jobs.js'
import { registerJobRuntimeProfileRoutes } from './routes/jobRuntimeProfiles.js'
import { registerSourceRoutes } from './modules/sources/routes.js'
import { createClaudeProductionDiscovery } from './modules/harnesses/claudeSdk/bootstrap.js'
import { productionClaudeMetadata } from './modules/harnesses/claudeSdk/productionMetadata.js'
import { initializeNativeDefaults } from './modules/harnesses/initializeDefaults.js'
import { qualifyClaudeNativeProfile } from './modules/harnesses/claudeSdk/nativeProfileQualification.js'
import { discoverLauncher } from './modules/harnesses/hostDiscovery.js'
import { passiveDriverPayloads } from './modules/harnesses/payloadDiscovery.js'
import { runCommand } from './modules/harnesses/process.js'
import { productionClaudeManager, type ClaudeProfileOwner } from './modules/harnesses/claudeSdk/production.js'
import { requireClaudeProductionCredentialDelivery } from './modules/harnesses/claudeSdk/productionCredentials.js'
import { PostgresClaudeInteractionAuthority } from './modules/harnesses/claudeSdk/domainAuthority.js'
import { productionSelectedProfileManager } from './modules/harnesses/selectedProfileProduction.js'
import { credentialAuthority } from './modules/interactions/wave25/credentialAuthority.js'
import type { GraphSqlClient } from './modules/run-graph/connection.js'
import { currentOperatorAuthority } from './modules/access/runAuthority.js'
import { requireAuthorization } from './modules/access/policy.js'
import { AcceptedHarnessProfileAdmission, AcceptedClaudeProfileAdmission, type AcceptedProfileAuthority } from './modules/harnesses/instanceSettings/acceptedProfile.js'
import type { AcceptedProfileSelector } from './modules/harnesses/instanceSettings/acceptedProfile.js'
import { HarnessExecutionRequestSchema, OperatorConfigurationVersionSchema } from '@graphql/contracts'
import { inspectClaudeOperatorConfiguration } from './modules/harnesses/claudeSdk/operatorConfigurationInspection.js'
import { requireClaudePolicyQualification } from './modules/harnesses/claudeSdk/configuration.js'
import { qualificationError } from './modules/harnesses/qualificationErrors.js'
import { authorizeOperatorConfigurationRead } from './modules/operators/configurationRead.js'
import { operatorCodexFileAdmissions } from './modules/harnesses/operatorFiles/codex.js'
import { adoptOperatorFilePublications, resolveOperatorOpenCodeFileAdmission } from './modules/harnesses/operatorFiles/postgres.js'
import { OPERATOR_MCP_ENVIRONMENT_VARIABLE } from './modules/conversations/operatorChatAuthority.js'
import { nativeCorrelation } from './modules/conversations/operatorChatRepository.js'
import { randomUUID } from 'node:crypto'
import { createWorkflowNativeCaptureChannel } from './modules/interactions/workflowNativeCapture.js'
import { createReviewNativeCaptureChannel } from './modules/interactions/reviewNativeCapture.js'
import { ReviewNativeProofServices } from './modules/interactions/reviewNativeProof.js'
import { PostgresRepeatReviewerBindings } from './modules/interactions/repeatReviewer.js'
import { createWorkflowRepositoryServices } from './modules/runs/workflowRepositoryServices.js'
import { createProductionWorkflowArtifactResultSource } from './modules/runs/remote/workflowArtifactResultProduction.js'
import { WorkflowArtifactResultAdoption } from './modules/runs/remote/workflowArtifactResultAdoption.js'
import { createWorkflowArtifactOutputsGate } from './modules/runs/remote/workflowArtifactAcceptance.js'
import { PostgresWorkflowPhysicalArtifacts } from './modules/runs/remote/workflowPhysicalArtifacts.js'
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
import { createProductionWorkflowFileContexts } from './modules/runs/remote/workflowNativeFilesProduction.js'
import { PostgresArtifactPublicationAuthority, PostgresAcceptedArtifactAttemptFence, type NativeArtifactAuthorityPorts } from './modules/runs/remote/nativeArtifactAuthority.js'
import { mountProductionWorkflowArtifacts } from './modules/runs/remote/workflowArtifactProduction.js'
import { createMainWorkflowArtifactTransferExtension } from './modules/runs/remote/workflowArtifactTransferProduction.js'
import type { TemporaryFileService } from './modules/files/service.js'
import { defaultFileStorageRoot } from './modules/files/storage.js'
import { postgresCodexChatFiles } from './modules/harnesses/codexFiles/chatAdmission.js'
import { codexChatHostDirectory, localCodexChatHost } from './modules/harnesses/codexFiles/localHost.js'
import { productionFileTools } from './modules/files/tools/production.js'
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
import { authorizeDeviceHost, assertDeviceHostInstallation } from './modules/devices/hostAuthorization.js'

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
  let agentPlacement: AgentPlacementProducer | undefined
  let agentPreparation: AgentExecutionPreparation | undefined
  let executionAuthority: ReturnType<typeof createExecutionAuthorityExtension> | undefined
  let workflowArtifacts: ReturnType<typeof mountProductionWorkflowArtifacts> | undefined
  let workflowPhysicalArtifacts: PostgresWorkflowPhysicalArtifacts | undefined
  let artifactComposition: { mainId: string; authority: PostgresArtifactPublicationAuthority; fence: PostgresAcceptedArtifactAttemptFence } | undefined
  let mainWorkerMcp: MainWorkerMcpRelay | undefined
  let trustedConnections: PostgresTrustedConnectionSetup | undefined
  const inputAcknowledgements = new Map<string, TransferIntent>()
  const acceptedRsync: AcceptedTransferAuthority = {
    async intent(id, binding) {
      if (!jobRuntime) throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'Original Main source and Job transfer services have not initialized.', 503)
      if (!isDeepStrictEqual(deviceRuntime.endpointForDomains().captureRequest(binding.deviceId, RSYNC_STAGE_EXTENSION.namespace)?.binding, binding))
        throw new DomainError('RSYNC_CONNECTION_CONFLICT', 'Transfer lookup requires the actual current rsync channel.', 403)
      const owners = (await database.pool.query<{ operation: string }>(`select operation from management_command_receipts where
        (operation in ('source.package.admit','job.output.admit') and result #>> '{intent,transferId}'=$1)
        or (operation='job.inputs.bind' and exists(select 1 from jsonb_array_elements(result->'transfers') item where item #>> '{intent,transferId}'=$1))`, [id])).rows
      if (owners.length !== 1) throw new DomainError('RSYNC_TRANSFER_DENIED', 'Exactly one original source or Job admission must own the transfer.', 403)
      const operation = owners[0]!.operation
      if (operation === 'source.package.admit') return jobRuntime.transfers.intent(id, binding)
      if (operation === 'job.inputs.bind') {
        const { transfer } = await jobRuntime.inputs.main.acceptedTransfer(id)
        await jobRuntime.inputs.main.authorizeTransfer(transfer.intent, transferContextForBinding(binding))
        return transfer.intent
      }
      const intent = await jobRuntime.outputs.admission.intentForTransfer(id)
      await jobRuntime.outputs.admission.authorizeTransfer(intent, transferContextForBinding(binding))
      return intent
    },
    async authorize(intent, context) {
      const binding = deviceRuntime.endpointForDomains().captureRequest(intent.deviceId, RSYNC_STAGE_EXTENSION.namespace)?.binding
      if (!binding || !isDeepStrictEqual(transferContextForBinding(binding), context) || !isDeepStrictEqual(await acceptedRsync.intent(intent.transferId, binding), intent))
        throw new DomainError('RSYNC_TRANSFER_DENIED', 'The original accepted transfer or authenticated generation changed.', 403)
    },
  }
  const entrypoint = infrastructure?.rsyncInstallation?.kind === 'configured' && !infrastructure.rsync
    ? createMainRsyncEntrypoint({ installation: infrastructure.rsyncInstallation, endpoint: () => deviceRuntime.endpointForDomains(), accepted: acceptedRsync,
      setup: { checkAcceptedTransfer: (...args) => {
        if (!trustedConnections) throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'The original Main trusted connection authority has not initialized.', 503)
        return trustedConnections.checkAcceptedTransfer(...args)
      } },
      ownership: () => rsync.kind === 'configured' ? rsync.ownership : undefined }) : undefined
  const installedRsync: InstalledMainRsyncProviders | undefined = infrastructure?.rsync ?? entrypoint?.providers
  const rsyncProviders: InstalledMainRsyncProviders | undefined=installedRsync?{...installedRsync,acknowledged:async(...args:Parameters<NonNullable<InstalledMainRsyncProviders['acknowledged']>>)=>{
    const [intent,context]=args
    const binding=deviceRuntime.endpointForDomains().captureRequest(intent.deviceId,RSYNC_STAGE_EXTENSION.namespace)?.binding
    if(!binding||!isDeepStrictEqual(transferContextForBinding(binding),context))throw new DomainError('RSYNC_CONNECTION_CONFLICT','Canonical ACK requires the original actual Main capture.',403)
    if(intent.byteClass==='source'&&intent.direction==='to-worker'){
      if(!jobRuntime)throw new DomainError('SOURCE_RUNTIME_UNAVAILABLE','The original committed source lifecycle is unavailable.',503)
      await jobRuntime.lifecycle.acknowledged(intent,context)
    }else if(intent.byteClass==='artifact'&&intent.direction==='to-main'&&jobRuntime&&await jobRuntime.outputs.ownsTransfer(intent.transferId)){
      await jobRuntime.outputs.admission.authorizeTransfer(intent,context)
      await jobRuntime.outputs.lifecycle.acknowledged(intent)
    }else if(isDeepStrictEqual(inputAcknowledgements.get(intent.transferId),intent)){
      if(!jobRuntime)throw new DomainError('JOB_RUNTIME_UNAVAILABLE','The original input delivery authority is unavailable.',503)
      await jobRuntime.inputs.main.acknowledged(intent.transferId,binding)
    }else await installedRsync.acknowledged(...args)
  }}:undefined
  const rsync: ReturnType<typeof createInstalledRsyncComposition> = createInstalledRsyncComposition({ side: 'main', providers: rsyncProviders,
    current: deviceId => deviceRuntime.endpointForDomains().captureRequest(deviceId, RSYNC_STAGE_EXTENSION.namespace)?.binding })
  const deviceRuntime = new ProductionDeviceRuntime(database.pool, infrastructure?.deviceListener, {
    extensions: [
      ...rsync.extensions.map(extension => ({ ...extension, role: 'duplex' as const, async handle(raw: unknown, context: import('./modules/devices/deviceApplicationChannel.js').DeviceExtensionContext) {
        context.signal.throwIfAborted()
        if (context.bytes !== undefined) throw new DomainError('RSYNC_TRANSFER_DENIED', 'Transfer authorization accepts metadata only.', 403)
        const request = RsyncTransferAuthorizeRequestSchema.parse(raw)
        const intent = await acceptedRsync.intent(request.transferId, context.binding)
        context.signal.throwIfAborted()
        return { payload: intent }
      } })),
      { namespace: WORKSPACE_ROOT_EXTENSION.namespace, version: WORKSPACE_ROOT_EXTENSION.version, role: 'client', maxJsonBytes: WORKSPACE_ROOT_EXTENSION.maxPayloadBytes, maxBinaryBytes: 0 },
      { ...JOB_RUNTIME_QUALIFICATION_EXTENSION, role: 'duplex', async handle(payload, context) {
        const handler = jobRuntime?.qualificationExtension.handle
        if (!handler) throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'The actual diagnostic qualification authority is unavailable.', 503)
        return handler(payload, context)
      } },
      { ...EXECUTION_AUTHORITY_EXTENSION, role: 'server', async handle(payload, context) {
        if (!executionAuthority?.handle) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual Main Agent placement authority has not initialized.', 503)
        return executionAuthority.handle(payload, context)
      } },
      { namespace: WORKER_MCP_EXTENSION.namespace, version: WORKER_MCP_EXTENSION.version, role: 'server',
        maxJsonBytes: WORKER_MCP_EXTENSION.maxJsonBytes, maxBinaryBytes: 0, async handle(payload, context) {
          if (!mainWorkerMcp) throw new DomainError('WORKER_MCP_UNAVAILABLE', 'The original Main worker MCP authority has not initialized.', 503)
          context.signal.throwIfAborted()
          const result = await mainWorkerMcp.handle(payload, context.binding)
          context.signal.throwIfAborted()
          return { payload: result }
        } },
      { ...SOURCE_OPERATION_EXTENSION, role: 'duplex', async handle(payload, context) {
        const handler = jobRuntime?.sourceExtension.handle
        if (!handler) throw new DomainError('SOURCE_RUNTIME_UNAVAILABLE', 'The actual Main source domain has not initialized.', 503)
        return handler(payload, context)
      } },
      createMainWorkflowArtifactTransferExtension(() => workflowArtifacts?.receiver,
        infrastructure?.deviceDomains?.extensions.find(value => value.namespace === BYTE_TRANSFER_NAMESPACE),()=>jobRuntime?.outputs),
      { namespace: 'harness-discovery-v1', version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: 'host-harness-check-v1', version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: 'execution-v1', version: 1, role: 'duplex', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
        handle: async (payload, context) => {
          if (RemoteJobMainRpcRequestSchema.safeParse(payload).success) {
            if (!jobRuntime) throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'The actual main Job application bridge is unavailable.', 503)
            return { payload: await jobRuntime.application.handle(payload, context.binding) }
          }
          const native = infrastructure?.deviceDomains?.extensions.find(value => value.namespace === 'execution-v1')
          if (!native?.handle) throw new DomainError('REMOTE_WORKFLOW_RPC_UNAVAILABLE', 'The actual main workflow application bridge is unavailable.', 503)
          return native.handle(payload, context)
        } },
      { namespace: JOB_INPUT_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 8192,
        handle: async (payload, context) => {
          const handler = jobRuntime?.inputs.extension.handle
          if (!handler) throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'The actual Job input authority is unavailable.', 503)
          return handler(payload, context)
        } },
      ...(infrastructure?.deviceDomains?.extensions.filter(value => !['execution-v1', JOB_INPUT_NAMESPACE, BYTE_TRANSFER_NAMESPACE].includes(value.namespace)) ?? []),
    ],
    async bindingLost(binding) {
      const tasks: Promise<unknown>[] = []
      try { if (rsync.kind === 'configured') tasks.push(rsync.rsyncWriters.bindingLost(binding)) } catch (error) { tasks.push(Promise.reject(error)) }
      try { const task = infrastructure?.deviceDomains?.bindingLost?.(binding); if (task) tasks.push(task) } catch (error) { tasks.push(Promise.reject(error)) }
      const results = await Promise.allSettled(tasks), failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Original device domain binding cleanup remains incomplete')
    },
    async reconcile(binding, signal, endpoint) {
      if (endpoint.capabilities(binding.deviceId).some((item) => item.namespace === 'harness-discovery-v1' && item.mainCanRequest)) {
        const result = await endpoint.request(binding.deviceId, 'harness-discovery-v1',
          { operation: 'discover', refreshId: randomUUID() }, { signal })
        signal.throwIfAborted()
        if (selectedSuites) await retainInstalledCodexInventory({ registry: harnessRegistry, qualifications: qualificationRepository,
          binding, inventory: result.payload, suiteRevision: selectedSuites.codex.revision })
        else harnessRegistry.acceptRemoteSnapshot(binding, result.payload)
      }
      if (infrastructure?.deviceDomains) await infrastructure.deviceDomains.reconcile(binding, signal, endpoint)
    },
  })
  const commands = new PostgresCommandCoordinator(database.pool)
  // Producer/consumer halves are installed during construction. Neither HTTP,
  // MCP nor a caller-supplied JSON observation can manufacture these captures.
  const workflowCapture = createWorkflowNativeCaptureChannel()
  const reviewCapture = createReviewNativeCaptureChannel()
  let admitWorkflowFileContext: ReturnType<typeof createProductionWorkflowFileContexts> | undefined
  let artifactResultSource: ReturnType<typeof createProductionWorkflowArtifactResultSource> | undefined
  let artifactOutputsGate: ReturnType<typeof createWorkflowArtifactOutputsGate> | undefined
  const workflowRuntime = createWorkflowRepositoryServices(workflowCapture.verify, (sql, owner, capture) => {
    if (!remoteWorkflow) throw new DomainError('REMOTE_WORKFLOW_UNAVAILABLE', 'The actual original native physical composition is unavailable.', 503)
    return remoteWorkflow.assertPhysical(sql, owner, capture)
  }, async (sql, evidence, proof) => {
    if (!admitWorkflowFileContext) throw new DomainError('NATIVE_ARTIFACT_CONTEXT_UNAVAILABLE', 'The original Main file-context composition is unavailable.', 503)
    await admitWorkflowFileContext(sql, evidence, proof)
    await artifactResultSource?.retainOriginalLocked(sql, evidence, proof)
  })
  const workflowServices: RepeatRepositoryServices = { ...workflowRuntime.services,
    async assertWorkflowArtifactOutputsLocked(sql, run, version, execution) {
      if (!artifactOutputsGate) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The original workflow artifact acceptance composition is unavailable.', 503)
      await artifactOutputsGate(sql, run, version, execution)
    },
    async admitPlacementExecutionLocked(sql, owner, run, execution, ref, inputDigest) {
      if (agentPlacement) { await agentPlacement.admitExecution(sql, owner, execution, ref, inputDigest, run.authorizationPrincipalId); return }
      if (await readAcceptedPlacement(sql, run.id, execution.workflowNodeId)) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual Agent placement producer is unavailable.', 503)
    },
    async preparePlacementExecution(owner, run, execution) {
      if (!artifactResultSource) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The original workflow artifact composition is unavailable.', 503)
      await owner.oneShotConnection().transaction(sql => artifactResultSource!.assertLaunchSupportedLocked(sql, execution.id, run.id))
      if (agentPreparation) {
        const prepared = await approvals.withSourceObservationLane(owner, execution, () => agentPreparation!.prepare(owner, run, execution))
        return prepared ? { ...prepared, revalidate: () => approvals.withSourceObservationLane(owner, execution, prepared.revalidate) } : undefined
      }
      const placed = await owner.oneShotConnection().transaction(sql => readAcceptedPlacement(sql, run.id, execution.workflowNodeId))
      if (placed) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual Agent source preparation producer is unavailable.', 503)
      return undefined
    },
  }
  const reviewNativeProofs = new ReviewNativeProofServices(reviewCapture.verify)
  const repository = new PostgresInteractionRepository(database.pool, reviewNativeProofs)
  const budgets = new PostgresApprovalBudgetRepository(database.pool)
  const projectRoot = config.workspaceStorageRoot ?? workspaceStorageRoot()
  const locations = new WorkspaceLocationService(database.pool, commands, config.harnesses.workspaceRoot, 'runner-local', projectRoot)
  const workflows = new PostgresWorkflowRepository(database.pool)
  const runs = new PostgresRunRepository(database.pool, workflows, locations,
    { runtimeRoot: config.harnesses.workspaceRoot, ...workflowRuntime, services: workflowServices }, async evidence => {
      const accepted = artifactResultSource?.acceptedAfterCommit(evidence)
      if (accepted) {
        if (!workflowArtifacts || !artifactResultSource) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The original workflow artifact composition is unavailable.', 503)
        await new WorkflowArtifactResultAdoption(artifactResultSource.source, workflowArtifacts.artifacts.outputs).adoptOriginalOutputs(accepted)
        await artifactResultSource.assertAdoptedAfterCommit(evidence)
      }
      try { await remoteWorkflow.afterCommit(workflowCapture.verify.read(evidence)) }
      catch (error) { app.log.warn({ err: error }, 'Original remote metadata acknowledgment remains pending') }
    })
  const remoteWorkflow = createProductionRemoteWorkflow({ pool: database.pool, locations, endpoint: () => deviceRuntime.endpointForDomains(),
    producer: () => agentPlacement, execution: id => runs.getExecution(id), artifacts: {
      assertPublications: (sql, readout, binding) => {
        if (!workflowPhysicalArtifacts) throw new DomainError('REMOTE_ARTIFACT_PHYSICAL_UNAVAILABLE', 'The original canonical artifact physical composition is unavailable.', 503)
        return workflowPhysicalArtifacts.assertPublications(sql, readout, binding)
      },
      assertAdopted: (sql, readout, binding) => {
        if (!workflowPhysicalArtifacts) throw new DomainError('REMOTE_ARTIFACT_PHYSICAL_UNAVAILABLE', 'The original canonical artifact physical composition is unavailable.', 503)
        return workflowPhysicalArtifacts.assertAdopted(sql, readout, binding)
      },
    } })
  const workspaces = new PostgresWorkspaceRepository(database.pool, workflows, runs)
  const settings = new PostgresSettingsRepository(database.pool)
  const hostProfileEvidence = new HostHarnessProfileEvidenceRepository(database.pool)
  const claudeDiscovery = createClaudeProductionDiscovery({ registry: () => harnessRegistry, factories: () => nativeFactories,
    workingDirectory: config.harnesses.workspaceRoot })
  const harnessRegistry = new ProductionHarnessRegistry(database.pool, config.harnesses,
    (client) => settings.getManagedHarnessDefaults(client), hostProfileEvidence,
    (deviceId) => { const view = deviceRuntime.presenceFor(deviceId); return view?.phase === 'ready' ? view.binding : null },
    process.env, infrastructure?.inventoryDiscovery ?? { launcher: discoverLauncher, payloads: passiveDriverPayloads,
      claude: claudeDiscovery.discover }, (deviceId) => deviceRuntime.currentBinding(deviceId),
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
    claudeVersionCommand: infrastructure?.auxiliary?.command ?? runCommand,
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
  const profileAuthority: AcceptedProfileAuthority<ClaudeProfileOwner> = {
    async authorize(binding, selector, client) {
      binding.admissionSignal?.throwIfAborted()
      if (binding.kind === 'workflow') {
        const current = await credentialAuthority(client as unknown as GraphSqlClient, binding.executionId, binding.purpose ?? 'workflow')
        if (current.run.id !== binding.runId || current.execution.attempt !== binding.attempt) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The exact Run attempt changed.', 409)
        if (!current.nativeSessionId && binding.purpose !== 'reviewer') {
          const owner = binding.getOwner()
          if (!owner || owner.runId !== binding.runId) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The original native launch owner is unavailable.', 409)
          owner.assertOwned(); await owner.readOneShotFence(owner.client as unknown as GraphSqlClient)
        }
        const row = (await client.query<{ principal_id: string }>("select record->>'authorizationPrincipalId' as principal_id from runs where id=$1", [binding.runId])).rows[0]
        if (!row?.principal_id) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The accepted Run principal is unavailable.', 409)
        const principal = (await currentOperatorAuthority(client, row.principal_id)).principal
        requireAuthorization(principal, 'runs:start', { workspaceId: current.run.workspaceId, workflowId: current.run.workflowId })
      } else if (binding.kind === 'operator-inspection') {
        const principal = await access.currentHarnessInspectionPrincipal(binding.principalId, client)
        requireAuthorization(principal, 'harnesses:read')
        await authorizeOperatorConfigurationRead(client, principal, binding.configurationVersionId)
        const row = (await client.query<{ record: unknown }>('select record from operator_configuration_versions where id=$1 and operator_id=$2',
          [binding.configurationVersionId, 'application-operator'])).rows[0]
        const configuration = row ? OperatorConfigurationVersionSchema.parse(row.record) : undefined
        if (!configuration || configuration.contentHash !== binding.configurationHash || !isDeepStrictEqual(configuration.harnessProfileSelection, selector)) {
          throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The exact saved Operator configuration changed before its read-only inspection.', 409)
        }
      } else await new PostgresClaudeInteractionAuthority(client, binding, { nativeCallbackContext: () => undefined }).callbackAdmission()
      await assertDeviceHostInstallation(client, selector.target.hostRef, selector.target.applicationInstallationId)
      binding.admissionSignal?.throwIfAborted()
    },
    async current(binding, value, client) {
      if (value.driverId === 'claude') {
        requireClaudeProductionCredentialDelivery(value.configuration)
        const current = infrastructure?.claudeCurrentProfile ?? (infrastructure?.mode === 'replay' ? undefined : claudeDiscovery.current)
        if (!current) throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Claude replay requires its current installed profile metadata port.', 500)
        return current(binding, value, client)
      }
      if (!await harnessRegistry.profileEvidence(value, client)) throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The exact accepted native profile proof is stale.', 409)
      return { registry: harnessRegistry.pinOverride(value), applicationInstallationId: value.target.applicationInstallationId,
        suiteRevision: `${value.driverId}-profile-check-v1` }
    },
    assertCurrent: binding => harnessRegistry.installations.assertCurrent(binding),
  }
  const selectedProfiles = new AcceptedHarnessProfileAdmission<ClaudeProfileOwner>(hostSettings, hostProfileEvidence, profileAuthority)
  const claudeProfiles = infrastructure?.claudeProfiles ?? new AcceptedClaudeProfileAdmission<ClaudeProfileOwner>(hostSettings, hostProfileEvidence, profileAuthority)
  const hostProfileChecks = new HostHarnessInstanceProfileChecks(hostSettings, hostProfileEvidence, commands, hostAuthority,
    new ProductionHostHarnessProfileQualifier(harnessRegistry, nativeFactories, () => deviceRuntime.endpointForDomains(), config.harnesses.workspaceRoot,
      infrastructure?.mode === 'replay' ? undefined : { async qualify(value, input) {
        const current = await claudeDiscovery.currentForConfiguration(value, input.signal)
        const binding = harnessRegistry.pinOverride(value)
        const recovery = processRegistry.reserveLaunch(`claude-profile-check:${input.checkId}`)
        const close = async () => {
          await processRegistry.abandonReservedLaunch(recovery)
          if (!await processRegistry.closeOwner(recovery.owner)) throw new Error('Claude native profile qualification closure is unconfirmed.')
        }
        try { return await qualifyClaudeNativeProfile({ value, checkId: input.checkId, binding, pin: current.pin,
          directory: resolve(config.harnesses.workspaceRoot, 'claude-native-qualification'), recovery, signal: input.signal,
          assertCurrent: async () => { await nativeFactories.assertInstallationUnchanged(binding, input.signal); harnessRegistry.installations.assertCurrent(binding) } }) }
        finally { await close() }
      } }))
  const harnessInstances = new HostHarnessOverrideService(hostSettings, commands, hostAuthority, async (value, client) => {
    requireClaudeProductionCredentialDelivery(value.configuration)
    const proof = await harnessRegistry.profileEvidence(value, client)
    return proof ? { target: proof.target, configurationFingerprint: proof.configurationFingerprint, qualified: proof.qualified } : null
  }, hostProfileChecks, configuration => {
    const binding = harnessRegistry.pinAccepted({ id: `operator-default-profile:${commandInputHash(configuration)}`, agentId: 'operator-default-setup', harness: configuration })
    const hostRef = binding.selection.hostRef
    if (hostRef.kind !== 'main' || !binding.installation.installationFingerprint) throw new DomainError('CLAUDE_INSTALLATION_UNAVAILABLE', 'The actual local Claude installation is unavailable.', 409)
    return { hostRef, applicationInstallationId: hostRef.mainId, harnessInstallationId: binding.selection.harnessInstallationId,
      installationFingerprint: binding.installation.installationFingerprint }
  })
  const claudeMetadata = infrastructure?.mode === 'replay' ? undefined : productionClaudeMetadata({ registry: harnessRegistry,
    processes: processRegistry, factories: nativeFactories, settings: hostSettings, defaults: () => settings.getHarnessDefaults(), current: claudeDiscovery.currentForConfiguration })
  const qualifier = new NativeHarnessConfigurationQualifier(config.harnesses.codexBinary, config.harnesses.openCodeBinary, nativeFactories, claudeMetadata)
  const harnessCatalog = new HarnessCatalogService(qualifier, settings, commands, config.harnesses.workspaceRoot, appMcpEndpoint)
  const nativeConfigurations = new NativeConfigurationService(
    config.harnesses.codexBinary, config.harnesses.openCodeBinary, config.harnesses.workspaceRoot, nativeFactories,
    claudeMetadata, infrastructure?.auxiliary?.command,
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
  const claudeLaunches = new WeakMap<NativeHarnessSessionManager, ReturnType<typeof productionClaudeManager>>()
  const managers = new ExecutionScopedNativeSessionManagerResolver((context, getOwner) => {
    const configuration = context.configuration.harness
    if (configuration.harness !== context.harness) {
      throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The pinned configuration does not match the execution harness.', 409)
    }
    // Object allocation remains native/registry IO-free. The coordinator reserves
    // this SAME scope immediately before its lifetime/entered commits.
    const recovery = processRegistry.scope(`execution:${context.executionId}`)
    const remote = remoteWorkflow!.manager(context, getOwner)
    if (remote) return remote
    const placement = context.acceptedPlacement
    let selector: AcceptedProfileSelector | undefined
    if (placement) {
      if (placement.payload.kind !== 'agent' || placement.payload.agentId !== context.agentId
        || placement.payload.agentConfigurationVersionId !== context.configuration.id
        || placement.runId !== context.runId || (remoteWorkflow!.binding(context.executionId)?.executionPlacement?.workingTree.canonicalCwd ?? placement.destination.canonicalCwd) !== context.workingDirectory
        || placement.payload.driverId !== configuration.harness) throw new DomainError('PLACEMENT_BINDING_CONFLICT',
        'The native role must use its exact accepted workflow placement.', 409)
      selector = { instanceId: placement.payload.instanceId, instanceRevision: placement.payload.instanceRevision,
        target: { hostRef: placement.hostRef, applicationInstallationId: placement.hostRef.kind === 'main'
          ? placement.hostRef.mainId : placement.registration!.workerInstallationId,
        harnessInstallationId: placement.payload.harnessInstallationId, installationFingerprint: placement.payload.installationFingerprint } }
    }
    if (configuration.harness === 'claude') {
      requireClaudeProductionCredentialDelivery(configuration)
      if (!context.runId || !context.attempt) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE',
        'Claude requires the persisted Run and execution attempt.', 409)
      const claude = productionClaudeManager({ pool: database.pool, factories: nativeFactories, registry: harnessRegistry,
        profiles: claudeProfiles, ...(selector ? { selector } : {}),
        binding: { kind: 'workflow', runId: context.runId, executionId: context.executionId, attempt: context.attempt, getOwner },
        role: 'workflow', configuration, workingDirectory: context.workingDirectory, ownerAgentId: context.agentId,
        recovery, appMcpAccess: 'scoped', mode: infrastructure?.mode ?? 'native',
        ...(infrastructure?.claudeClient ? { loadClient: infrastructure.claudeClient } : {}),
        inspectionStart: async () => {
          const owner = getOwner()
          if (!owner) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE', 'The workflow native owner is unavailable.', 409)
          const execution = await runs.getExecution(context.executionId, owner), run = await runs.get(context.runId!, owner)
          if (!execution || !run || execution.attempt !== context.attempt) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE', 'The persisted execution attempt changed.', 409)
          const request = HarnessExecutionRequestSchema.parse({ executionId: execution.id, runId: execution.runId,
            workspaceId: run.workspaceId, workflowNodeId: execution.workflowNodeId, workingDirectory: execution.workingDirectory,
            runtimeDirectory: execution.runtimeDirectory, configuration: context.configuration, input: execution.input })
          return execution.nativeSessionId ? { kind: 'workflow', correlationId: `execution:${execution.id}`, request } : { request }
        },
      })
      claudeLaunches.set(claude.manager, claude)
      launchScopes.set(claude.manager, recovery)
      return claude.manager
    }
    if (selector) {
      if (!context.runId || !context.attempt) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The exact Run attempt is unavailable.', 409)
      const { manager } = productionSelectedProfileManager({ factories: nativeFactories, registry: harnessRegistry, profiles: selectedProfiles,
        selector, binding: { kind: 'workflow', runId: context.runId, executionId: context.executionId, attempt: context.attempt, getOwner,
          ...(context.purpose ? { purpose: context.purpose } : {}) },
        configuration, role: 'workflow', workingDirectory: context.workingDirectory, ownerAgentId: context.agentId, recovery, appMcpAccess: 'scoped' })
      launchScopes.set(manager, recovery)
      return manager
    }
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
  const validateContinuation = placedContinuationValidator(database.pool, locations, remoteWorkflow, {
    async assertCurrent(binding, signal) {
      signal?.throwIfAborted()
      const sql = interactionConnection.getStore() ?? database.pool
      const row = (await sql.query<{ principal_id: string; workspace_id: string }>("select record->>'authorizationPrincipalId' as principal_id,workspace_id from runs where id=$1", [binding.intent.runId])).rows[0]
      if (!row || !agentPlacement) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The current accepted placement authority is unavailable.', 503)
      await agentPlacement.assertPinsCurrent(sql, binding.placement, await readLiveManagementPrincipal(sql, row.principal_id), row.workspace_id)
      signal?.throwIfAborted()
    },
  })
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
        workingDirectory: input.workingDirectory, configuration, runId: execution.runId, attempt: execution.attempt,
      }
      const { manager } = managers.resolve(context)
      const detection = new McpDetectionService(nativeFactories.inspector(manager), appMcpEndpoint)
      if (input.harness === 'claude') {
        const claude = claudeLaunches.get(manager)
        if (!claude || configuration.harness.harness !== 'claude') throw new DomainError('CLAUDE_OWNER_UNAVAILABLE', 'The exact Claude launch is unavailable.', 409)
        const inspected = await nativeFactories.inspector(manager).inspect({ harness: 'claude', runnerId: run.executionLocation.runnerId,
          workingDirectory: input.workingDirectory, serverName: 'graphql', phase: 'configuration', ...(input.signal ? { signal: input.signal } : {}) })
        const entry = inspected.entry
        if (!entry || entry.name !== 'graphql' || entry.transport !== 'streamable-http' || entry.endpoint !== appMcpEndpoint
          || entry.enabled === false || !['connected', 'authentication_required', 'status_unavailable'].includes(entry.status ?? '')) {
          throw new DomainError('APP_MCP_PREFLIGHT_FAILED', 'The owned Claude query has no accepted GraphQL HTTP endpoint.', 409)
        }
        await credentials.revokeSupersededForExecution(input.executionId)
        input.signal?.throwIfAborted()
        const credential = await (input.purpose === 'reviewer' ? credentials.issueForReviewer(input.executionId) : credentials.issueForExecution(input.executionId))
        try {
          const token = credential.environment.variables.GRAPHQL_MCP_TOKEN
          const configured = configuration.harness.mcpServers.graphql
          if (!token || configured?.type !== 'http' || configured.url !== appMcpEndpoint) throw new DomainError('APP_MCP_PREFLIGHT_FAILED', 'The accepted Claude settings cannot receive this scoped HTTP credential.', 409)
          const start = { ...await claude.inspectionStart(), environment: credential.environment }
          await claude.manager.refreshInspectionCredentials(start, { ...configuration.harness.mcpServers,
            graphql: { ...configured, headers: { Authorization: `Bearer ${token}` } } }, input.signal)
          const checked = await detection.preflight({ harness: 'claude', runnerId: run.executionLocation.runnerId,
            workingDirectory: input.workingDirectory, ...(input.signal ? { signal: input.signal } : {}) })
          if (checked.detection.state !== 'connected' || checked.detection.credentialArrangement?.kind !== 'scoped_http_header') throw new DomainError('APP_MCP_PREFLIGHT_FAILED', 'Claude did not acknowledge the scoped HTTP credential on its current query.', 409)
          await appRoutes.refresh()
          return { credential, detection: checked }
        } catch (error) { await credentials.revoke(credential); throw error }
      }
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
    { capture(input) {
      const evidence = workflowCapture.capture.capture(input)
      remoteWorkflow!.capture(input, workflowCapture.verify.read(evidence))
      return evidence
    } }, reviewCapture.capture,
    (executionId, signal) => remoteWorkflow!.isRemote(executionId)
      ? Promise.resolve(false) : processRegistry.closeOwner(`execution:${executionId}`, signal),
    (executionId, manager) => {
      if (remoteWorkflow!.isRemote(executionId)) return
      const scope = launchScopes.get(manager)
      if (!scope || scope.owner !== `execution:${executionId}` || scope.launchId) throw new DomainError(
        'NATIVE_LAUNCH_RESERVATION_CONFLICT', 'The exact manager launch scope is unavailable or already reserved.', 409)
      Object.assign(scope, processRegistry.reserveLaunch(scope.owner))
    },
    context => remoteWorkflow!.prepareContext(context),
  )
  let telemetry: ResourceTelemetryRuntime | undefined
  const telemetryLifetime = new AbortController()
  let mainTelemetryContext: Extract<TrustedTelemetryContext, { kind: 'main-local' }> | null = null
  let jobRuntime: Awaited<ReturnType<typeof createProductionJobs>> | undefined
  const engine = new LangGraphWorkflowEngine(
    runs, workflows, approvals, checkpoints.saver, config.harnesses.workspaceRoot,
    locations, launchCredentials, repository, undefined, {}, (owner, version) => {
      if (!jobRuntime) throw new DomainError('WORKFLOW_JOB_COMPOSITION_REQUIRED', 'The actual Job domain has not initialized.', 503)
      const bound = jobRuntime.workflow.forOwner(owner, version)
      return { store: new PostgresWorkflowJobNodeStore(owner, version, runs.repeatRepositoryFactory().hostForOwner(owner, version),
        bound.locked, workflowJobStorePublication()), driver: bound.driver }
    },
  )
  const interactions = new InteractionService(
    repository, budgets, approvals, (interaction) => engine.resumeInteraction(interaction), responseJournal,
    (interaction) => approvals.inspectInteractionActivity(interaction),
  )
  registerApprovalCheckpointResume(interactions, engine)
  const operatorWorkingDirectory = resolve(config.harnesses.workspaceRoot, 'operator')
  const operatorManagers = new Map<string, NativeHarnessSessionManager>()
  const operatorConversations = new PostgresOperatorConversationRepository(database.pool)
  const resolveOperatorManager = productionOperatorManagers({
    app: () => app, pool: database.pool, config, workingDirectory: operatorWorkingDirectory,
    endpointHost, appMcpEndpoint, processRegistry, responseJournal, managers: operatorManagers, nativeFactories,
    createSelected: (configuration, conversationId, fileInputs, recovery) => {
      if (!configuration.harnessProfileSelection || configuration.harness.harness === 'claude') throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The selected Operator driver profile is unavailable.', 409)
      return productionSelectedProfileManager({ factories: nativeFactories, registry: harnessRegistry, profiles: selectedProfiles,
        selector: configuration.harnessProfileSelection, binding: { kind: 'operator', conversationId, repository: operatorConversations },
        configuration: configuration.harness, role: 'operator', workingDirectory: operatorWorkingDirectory, ownerAgentId: configuration.operatorId,
        recovery, appMcpAccess: fileInputs ? 'none' : 'scoped',
        ...(!fileInputs && configuration.harness.harness === 'opencode' ? { credentialEnvironmentVariable: OPERATOR_MCP_ENVIRONMENT_VARIABLE } : {}),
        ...(fileInputs ? { files: productionCodexChatFiles(() => app, conversationId, operatorCodexFileAdmissions(() => app, database.pool,
          configuration, operatorWorkingDirectory, fileStorageRoot)),
          openCodeFiles: (server: OpenCodeServerController) => productionOpenCodeChatFiles(() => app, database.pool, config, conversationId, server, endpointHost, {
            resolve: (pool, id, identity) => resolveOperatorOpenCodeFileAdmission(pool, id, configuration, operatorWorkingDirectory, identity),
            adoptPublished: adoptOperatorFilePublications,
          }) } : {}),
      }).manager
    },
    createClaude: (configuration, conversationId, fileInputs, recovery) => {
      if (configuration.harness.harness !== 'claude') throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'Claude requires the pinned Claude configuration.', 409)
      requireClaudeProductionCredentialDelivery(configuration.harness)
      const claude = productionClaudeManager({ pool: database.pool, factories: nativeFactories, registry: harnessRegistry,
        profiles: claudeProfiles,
        ...(configuration.harnessProfileSelection ? { selector: configuration.harnessProfileSelection } : {}),
        binding: { kind: 'operator', conversationId, repository: operatorConversations }, role: 'operator',
        configuration: configuration.harness, workingDirectory: operatorWorkingDirectory, ownerAgentId: configuration.operatorId,
        recovery, appMcpAccess: fileInputs ? 'none' : 'scoped', mode: infrastructure?.mode ?? 'native',
        ...(fileInputs ? { files: { service: () => productionFileTools(app), ...(infrastructure?.claudeFileSdk ? { sdk: infrastructure.claudeFileSdk } : {}) } } : {}),
        ...(infrastructure?.claudeClient ? { loadClient: infrastructure.claudeClient } : {}),
        inspectionStart: async () => {
          const row = await operatorConversations.active(conversationId)
          if (!row?.active_request_id || row.operator_configuration_version_id !== configuration.id) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE', 'The accepted Operator turn is unavailable.', 409)
          return { kind: 'operator', correlationId: nativeCorrelation(conversationId, row.active_request_id), configuration,
            workingDirectory: operatorWorkingDirectory, environment: { agentId: configuration.operatorId, variables: {} } }
        },
      })
      claudeLaunches.set(claude.manager, claude)
      return claude.manager
    },
    selectInstallation: (configuration) => harnessRegistry.initialized
      ? harnessRegistry.pinAccepted({ ...configuration, agentId: configuration.operatorId }) : undefined,
  })
  const chatAuthority = new PostgresOperatorChatAuthority(
    database.pool, access, rollout, operatorWorkingDirectory, appMcpEndpoint,
    (manager) => nativeFactories.inspector(manager),
    async (manager, configuration, environment, signal) => {
      const claude = claudeLaunches.get(manager)
      const configured = configuration.harness.harness === 'claude' ? configuration.harness.mcpServers.graphql : undefined
      const token = environment.variables.GRAPHQL_MCP_TOKEN
      if (!claude || !configured || configured.type !== 'http' || configured.url !== appMcpEndpoint || !token) throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'The accepted Claude HTTP credential arrangement is unavailable.', 409)
      await claude.manager.refreshInspectionCredentials({ ...await claude.inspectionStart(), environment }, {
        ...(configuration.harness.harness === 'claude' ? configuration.harness.mcpServers : {}),
        graphql: { ...configured, headers: { Authorization: `Bearer ${token}` } },
      }, signal)
      const checked = await new McpDetectionService(nativeFactories.inspector(manager), appMcpEndpoint).preflight({
        harness: 'claude', runnerId: 'runner-local', workingDirectory: operatorWorkingDirectory, signal,
      })
      if (checked.detection.state !== 'connected' || checked.detection.credentialArrangement?.kind !== 'scoped_http_header') throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'Claude did not acknowledge the scoped Operator credential on its current query.', 409)
    },
    async (principal, configuration, signal) => {
      if (configuration.harness.harness !== 'claude' || !configuration.harnessProfileSelection) throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Claude setup requires its exact saved host profile.', 409)
      const owner: ClaudeProfileOwner = { kind: 'operator-inspection', principalId: principal.id,
        configurationVersionId: configuration.id, configurationHash: configuration.contentHash, admissionSignal: signal }
      const accepted = await claudeProfiles.admit(owner, configuration.harnessProfileSelection)
      const binding = harnessRegistry.pinOverride(accepted.override), binary = binding.installation.launcher.resolvedLauncher
      if (!binary || accepted.override.target.hostRef.kind !== 'main') throw new DomainError('HARNESS_HOST_MISMATCH', 'Claude setup must inspect its actual local installed profile.', 409)
      const recovery = processRegistry.reserveLaunch(`operator-configuration-inspection:${randomUUID()}`)
      const close = async () => {
        await processRegistry.abandonReservedLaunch(recovery)
        if (!await processRegistry.closeOwner(recovery.owner)) throw new Error('Claude read-only configuration inspection closure is unconfirmed.')
      }
      try { return await inspectClaudeOperatorConfiguration({ accepted, binary, workingDirectory: operatorWorkingDirectory,
        endpoint: appMcpEndpoint, recovery, signal, ...(infrastructure?.claudeClient ? {
          loadClient: (profilePath, processRecovery, selectedBinary) => infrastructure.claudeClient!({ profilePath, recovery: processRecovery, binary: selectedBinary }),
        } : {}),
        revalidate: async () => { await claudeProfiles.revalidate(owner, accepted); await nativeFactories.assertInstallationUnchanged(binding, signal) } }) }
      finally { await close() }
    },
  )
  const chat = new OperatorChatService(
    operatorConversations, operators,
    resolveOperatorManager, operatorWorkingDirectory, chatAuthority,
  )
  const agentConversations = new PostgresAgentChatRepository(database.pool)
  const agentChatManagers = new Map<string, NativeHarnessSessionManager>()
  const resolveAgentChatManager: AgentChatManagerFactory = (conversationId, configuration, workingDirectory) => {
    const existing = agentChatManagers.get(conversationId)
    if (existing) return existing
    // Chat processes have their own owner scope; they never share a workflow execution's manager.
    const recovery = processRegistry.scope(`conversation:agent-chat:${conversationId}`)
    const harness = configuration.harness
    if (harness.harness === 'claude') {
      requireClaudeProductionCredentialDelivery(harness)
      const { manager } = productionClaudeManager({ pool: database.pool, factories: nativeFactories, registry: harnessRegistry,
        profiles: claudeProfiles,
        ...(configuration.harnessProfileSelection ? { selector: configuration.harnessProfileSelection } : {}),
        binding: { kind: 'agent', conversationId, workspaceId: configuration.workspaceId, repository: agentConversations },
        role: 'agent-chat', configuration: harness, workingDirectory, ownerAgentId: configuration.agentId, recovery,
        appMcpAccess: 'none', mode: infrastructure?.mode ?? 'native',
        files: { service: () => productionFileTools(app), ...(infrastructure?.claudeFileSdk ? { sdk: infrastructure.claudeFileSdk } : {}) },
        ...(infrastructure?.claudeClient ? { loadClient: infrastructure.claudeClient } : {}),
        inspectionStart: async () => { throw new DomainError('CLAUDE_MANAGEMENT_MCP_FORBIDDEN', 'Agent chat has no management MCP inspection authority.', 403) },
      })
      agentChatManagers.set(conversationId, manager)
      return manager
    }
    if (configuration.harnessProfileSelection) {
      const { manager } = productionSelectedProfileManager({ factories: nativeFactories, registry: harnessRegistry, profiles: selectedProfiles,
        selector: configuration.harnessProfileSelection,
        binding: { kind: 'agent', conversationId, workspaceId: configuration.workspaceId, repository: agentConversations },
        configuration: harness, role: 'agent-chat', workingDirectory, ownerAgentId: configuration.agentId, recovery, appMcpAccess: 'none',
        files: productionCodexChatFiles(() => app, conversationId, chatFileAdmissions),
        openCodeFiles: (server) => productionOpenCodeChatFiles(() => app, database.pool, config, conversationId, server, endpointHost) })
      agentChatManagers.set(conversationId, manager)
      return manager
    }
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
          chatFiles: (server: OpenCodeServerController) => productionOpenCodeChatFiles(() => app, database.pool, config, conversationId, server, endpointHost) }),
    })
    agentChatManagers.set(conversationId, manager)
    return manager
  }
  resolveAgentChatManager.release = (conversationId) => { agentChatManagers.delete(conversationId) }
  const agentChat = new AgentChatService(database.pool, agentConversations,
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
    startPublication: { ...binding.startPublication, ...(selectedSuites ? { placementAdmission: {
      prepare: (...args: Parameters<AgentPlacementProducer['prepare']>) => {
        if (!agentPlacement) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual saved-placement admission producer is unavailable.', 503)
        return agentPlacement.prepare(...args)
      },
    } } : {}) },
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
    executionReadiness: new ExecutionReadinessService(rollout, harnessCatalog, async (principal, configurationVersionId) => {
      if (configurationVersionId) await authorizeOperatorConfigurationRead(database.pool,
        await access.currentHarnessInspectionPrincipal(principal.id), configurationVersionId)
      const defaults = configurationVersionId ? undefined : await foundationSettings.getAgentDefaults()
      const configuration = configurationVersionId ? await operatorConversations.configuration(configurationVersionId)
        : await operators.inspectionConfiguration(defaults!.revision)
      if (!configuration || configuration.operatorId !== 'application-operator') throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'The saved Operator configuration is unavailable.', 409)
      try {
        if (configuration.harnessProfileSelection) {
          const owner: ClaudeProfileOwner = { kind: 'operator-inspection', principalId: principal.id,
            configurationVersionId: configuration.id, configurationHash: configuration.contentHash }
          if (configuration.harness.harness === 'claude') {
            const accepted = await claudeProfiles.admit(owner, configuration.harnessProfileSelection)
            requireClaudePolicyQualification(configuration.harness, accepted)
          } else await selectedProfiles.admit(owner, configuration.harnessProfileSelection)
        } else {
          if (configuration.harness.harness === 'claude') throw new DomainError('HARNESS_PROFILE_REQUIRED', 'The saved Operator Claude configuration has no exact qualified host profile.', 409)
          await harnessCatalog.checkConfiguration(principal, configuration.harness)
        }
      } catch (error) { throw qualificationError(error) }
      return { configurationVersionId: configuration.id, harness: configuration.harness, defaultsRevision: defaults?.revision ?? null }
    }),
    operatorChat: chat,
    agentChat,
    workspaces: new WorkspaceManagementService(database.pool, commands, locations, foundationSettings, projectRoot),
    locations,
    workflows: new WorkflowManagementService(database.pool, commands),
    agents: new AgentManagementService(database.pool),
    harnesses: harnessCatalog,
    ...(harnessQualifications ? { harnessQualifications } : {}),
    settings: new FoundationSettingsManagementService(foundationSettings, commands, harnessCatalog, operators, harnessInstances),
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
      if (input.harness === 'claude') throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Claude diagnostics require an explicit accepted profile owner.', 409)
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
    provisioningRoot: projectRoot, harnessProfiles: harnessInstances,
  })
  const runtimeServices: OperatorServices & { jobs?: import('./modules/jobs/service.js').JobService;
    jobRuntimeProfiles?: import('./modules/jobs/runtimeProfiles.js').JobRuntimeProfiles } = { ...operatorServices, extensions: operatorExtensions, harnessSettings }
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
    operator: { access, services: runtimeServices },
    appMcp: { access, interactions: new PostgresAppInteractionService(database.pool, repository, commands, interactions) },
    workerArtifacts: () => workflowArtifacts?.extension,
    mcpDetection: { pool: database.pool, service: detection },
    logger,
  })
  registerFileRetentionRoutes(app, operatorServices.fileRetention)
  const mountArtifacts = () => {
    if (workflowArtifacts || !fileStorage || !artifactComposition) return
    workflowPhysicalArtifacts = new PostgresWorkflowPhysicalArtifacts(artifactComposition.mainId,
      { authority: artifactComposition.authority, files: fileStorage.repository })
    workflowArtifacts = mountProductionWorkflowArtifacts({ app, pool: database.pool, files: fileStorage,
      ...artifactComposition, attempts: artifactComposition.fence, commands, access,
      endpoint: deviceRuntime.endpointForDomains(), stagingRoot: resolve(fileStorageRoot, 'workflow-artifact-transfers') })
  }
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
      { name: 'passive resource telemetry admission', run: async () => { telemetryLifetime.abort() } },
      { name: 'original rsync byte ownership', run: () => rsync.kind === 'configured' ? rsync.rsyncWriters.close() : undefined },
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
      { name: 'installed rsync canonical receiver', run: () => entrypoint ? entrypoint.close() : undefined },
      { name: 'workflow artifact byte receiver', run: async () => { await workflowArtifacts?.receiver.close() } },
      { name: 'passive resource telemetry collector', run: async () => { await telemetry?.close() } },
      { name: 'diagnostic and configuration qualification native managers', run: () => nativeFactories.disposeAuxiliaries() },
      { name: 'Job dispatch owners', run: async () => { await jobRuntime?.close() } },
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
      const connectionAuthority = new PostgresTrustedConnectionHumanAuthority(database.pool, machine.installationId)
      trustedConnections = new PostgresTrustedConnectionSetup(database.pool, machine.installationId,
        { verifyOwnerApproval: connectionAuthority.verifyOwnerApproval })
      runtimeServices.trustedConnections = trustedConnections
      registerTrustedConnectionRoutes(app, trustedConnections,
        async request => request.reauthorizeOperator ? request.reauthorizeOperator() : requirePrincipal(request))
      registerTrustedConnectionApprovalRoutes(app, connectionAuthority)
      const activeNativeSession: SourceActiveNativeSessionReader = (sql, record) =>
        readSourceCurrentNativeSession(sql, record, approvals.passiveOwnedNativeSessions())
      const captureNativeSession: SourceNativeSessionCaptureReader = async record => {
        const captures = approvals.passiveOwnedNativeSessions()
        const readCurrent = async () => {
          const sql = await database.pool.connect()
          try {
            await sql.query('begin')
            const proof = await readSourceCurrentNativeSession(sql, record, captures)
            await sql.query('commit')
            return proof
          } catch (error) { await sql.query('rollback'); throw error } finally { sql.release() }
        }
        const proof = await readCurrent()
        if (!proof) return null
        const capture = captures.find(value => value.execution.id === record.receipt.executionId)!
        return { proof, signal: capture.signal, async assertCurrent() {
          capture.signal.throwIfAborted(); capture.assertCurrent()
          if (!sameWorkflowValue(await readCurrent(), proof)) throw new DomainError('SOURCE_NATIVE_SESSION_CONFLICT', 'The original entered native owner or source lane is no longer current.', 409)
          capture.signal.throwIfAborted(); capture.assertCurrent()
        } }
      }
      jobRuntime = await createProductionJobs({ pool: database.pool, commands, locations, mainId: machine.installationId,
        runtimeRoot: config.harnesses.workspaceRoot, storageRoot: fileStorageRoot, endpoint: () => deviceRuntime.endpointForDomains(),
        activeNativeSession, captureNativeSession,
        ...(installedRsync ? { transferSender: source => rsync.sender(source),
          transferReceiver:installedRsync.receiver,
          outputRsync:{stage:async(intent,signal)=>{
            if(rsync.kind!=='configured')throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE','The selected original rsync lifecycle is unavailable.',409)
            return rsync.backend.send(intent,undefined,signal)
          },acknowledge:async(intent,signal)=>{
            if(rsync.kind!=='configured')throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE','The selected original rsync lifecycle is unavailable.',409)
            await rsync.backend.acknowledge(intent,signal)
          }},
          inputRsync: { stage: async (intent, source, signal) => {
            if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'The selected original rsync lifecycle is unavailable.', 409)
            return rsync.backend.send(intent, source, signal)
          }, acknowledge: async (intent, signal) => {
            if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'The selected original rsync lifecycle is unavailable.', 409)
            if (inputAcknowledgements.has(intent.transferId)) throw new DomainError('JOB_INPUT_ACK_BUSY', 'Original input delivery ACK is already coordinating.', 409)
            inputAcknowledgements.set(intent.transferId, structuredClone(intent))
            try { await rsync.backend.acknowledge(intent, signal) } finally { inputAcknowledgements.delete(intent.transferId) }
          } },
          transferAcknowledged: async intent => {
            if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'The selected original rsync lifecycle is unavailable.', 409)
            await rsync.backend.acknowledge(intent)
          } } : {}),
        ...(processRegistry instanceof NativeProcessRegistry ? { nativeRegistry: processRegistry } : {}),
        ...(infrastructure?.jobs ? { infrastructure: infrastructure.jobs } : {}) })
      if (selectedSuites) {
        agentPlacement = new AgentPlacementProducer(database.pool, machine.installationId, jobRuntime.sources, jobRuntime.policies,
          harnessRegistry.installations, { codex: selectedSuites.codex.revision, opencode: selectedSuites.opencode.revision })
        agentPreparation = new AgentExecutionPreparation(jobRuntime.sources, agentPlacement)
        executionAuthority = createExecutionAuthorityExtension(database.pool, locations, agentPlacement)
      }
      const artifactPorts: NativeArtifactAuthorityPorts = { locations,
        producer: { assertPinsCurrent: (...args) => {
          if (!agentPlacement) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual artifact placement producer is unavailable.', 503)
          return agentPlacement.assertPinsCurrent(...args)
        } } }
      const artifactAuthority = new PostgresArtifactPublicationAuthority(machine.installationId, database.pool, artifactPorts)
      mainWorkerMcp = new MainWorkerMcpRelay(machine.installationId, database.pool, access, selectedMainMcpForward(app),
        infrastructure?.nativeOutputAuthorization?.(artifactAuthority))
      artifactOutputsGate = createWorkflowArtifactOutputsGate(machine.installationId, artifactAuthority)
      artifactResultSource = createProductionWorkflowArtifactResultSource({ captures: workflowCapture.verify,
        physical: remoteWorkflow, authority: artifactAuthority })
      admitWorkflowFileContext = createProductionWorkflowFileContexts(machine.installationId, { captures: workflowCapture.verify,
        assertPhysical: remoteWorkflow.assertPhysical, authority: artifactAuthority, transferContext: remoteWorkflow.fileTransferContext })
      artifactComposition = { mainId: machine.installationId, authority: artifactAuthority,
        fence: new PostgresAcceptedArtifactAttemptFence(machine.installationId, artifactPorts) }
      mountArtifacts()
      await bootstrapLocalMainWorkspaceRoot({ pool: database.pool, policies: jobRuntime.policies, mainId: machine.installationId,
        runtimeRoot: config.harnesses.workspaceRoot, appStorageRoot: projectRoot })
      runtimeServices.workspaceRoots = new WorkspaceBoundLocationService(database.pool, commands, jobRuntime.policies)
      registerWorkspaceRootRoutes(app, runtimeServices.workspaceRoots)
      runtimeServices.sources = jobRuntime.sources
      runtimeServices.jobs = jobRuntime.jobs
      runtimeServices.jobRuntimeProfiles = jobRuntime.profiles
      registerSourceRoutes(app, jobRuntime.sources)
      registerJobRoutes(app, jobRuntime.jobs)
      registerJobRuntimeProfileRoutes(app, jobRuntime.profiles)
      assertOpen()
      await harnessRegistry.initialize(machine.installationId)
      assertOpen()
      if (processRegistry instanceof NativeProcessRegistry) {
        const registry = processRegistry
        mainTelemetryContext = { kind: 'main-local', mainId: machine.installationId,
          // Approved canonical alias for the Main, not a separate hardware UUID.
          deviceId: machine.installationId, applicationInstallationId: machine.installationId,
          bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
          runtimeEpoch: await runtimeOwner.readRuntimeEpoch(), capability: RESOURCE_TELEMETRY_CAPABILITY }
        const authorities = createPassiveTelemetryAuthorities({ pool: database.pool, registry,
          mainContext: () => mainTelemetryContext, mainActive: () => !closing && runtimeOwner.active,
          deviceBinding: id => deviceRuntime.currentBinding(id), presence: id => deviceRuntime.presenceFor(id),
          deviceCapabilities: id => deviceRuntime.endpointForDomains().capabilities(id),
          getRemoteNativeOwners: () => remoteWorkflow.getRemoteNativeOwners(),
          getNativeOwners: () => approvals.passiveOwnedNativeSessions().flatMap(owned => {
            const captured = launchScopes.get(owned.manager)
            return captured ? [{ execution: owned.execution, session: owned.session, writer: owned.writer, generation:owned.generation, assertCurrent: owned.assertCurrent, nativeOwner: captured.owner }] : []
          }) })
        telemetry = await createResourceTelemetryRuntime({ localContext: mainTelemetryContext, registry, ...authorities,
          wholeHostVisible: false, signal: telemetryLifetime.signal })
        runtimeServices.resourceTelemetry = { reads: telemetry.service, selectors: telemetry.selectors }
        const audit = { record: (principalId: string, source: 'http' | 'mcp', selectorKey: string) =>
          commands.recordDenied(principalId, source, 'resource_telemetry_read', selectorKey) }
        registerResourceTelemetryRoutes(app, telemetry.service, audit)
        registerResourceTelemetrySelectorRoutes(app, telemetry.selectors, {
          record: (principalId, source, selectorKey) => commands.recordDenied(principalId, source, 'resource_telemetry_selector_get', selectorKey),
        })
        void telemetry.completion.then(result => {
          if (result.kind === 'failed') app.log.error({ err: result.error }, 'passive resource telemetry collector failed')
        })
        assertOpen()
      }
      // Optional discovery warmups used to block startup on native auth/network.
      // Qualification still runs at every existing on-demand configuration/execution gate.
      // The bounded compatibility diagnostic creates no native session or model turn.
      if (qualificationRegistry && harnessQualifications) {
        await qualificationRegistry.load()
        installQualificationGate(qualificationRegistry, harnessQualifications)
      }
      if (infrastructure?.mode !== 'replay') {
        await initializeNativeDefaults({ pool: database.pool, options: harness => nativeConfigurations.options(harness), appMcpEndpoint })
        await harnessRegistry.refreshMain()
        const initializedDefaults = await foundationSettings.getAgentDefaults()
        const currentOperator = await operators.ensure()
        if (!isDeepStrictEqual(currentOperator.configuration.harness, initializedDefaults.value.operator.harness)) {
          await operators.update(initializedDefaults.value.operator.harness, currentOperator.operator.currentConfigurationVersionId)
        }
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
  return { app, engine, initialize, reconcile, shutdown, drainShutdown, rsync,
    registerFileStorage: () => {
      fileStorage ??= registerProductionFileStorage(app, database.pool, config)
      mountArtifacts()
      return fileStorage
    }, startDeviceListener: () => deviceRuntime.startListener() }
}
