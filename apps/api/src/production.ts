import { RunWorktrees } from './modules/runs/runWorktrees.js'
import { withTransaction } from './infrastructure/transaction.js'
import { ComputerActivityService } from './modules/computers/activity.js'
import { registerComputerActivityRoutes } from './routes/computerActivity.js'
import { ComputerAccountsService } from './modules/computers/accounts.js'
import { AGENT_SNAPSHOT_NAMESPACE, AgentSnapshotResultSchema } from '@foreman-code/contracts/source-materialization'
import { snapshotAgentWorktree } from './modules/sources/agentSnapshot.js'
import { CiRuntimeProvisioner } from './modules/jobs/ciRuntimeProvisioner.js'
import { CiEnrollment } from './modules/jobs/ciEnrollment.js'
import { ProductionCiEnrollmentInventory } from './modules/jobs/ciEnrollmentInventory.js'
import { CI_HOST_NAMESPACE, CI_RUNTIME_NAMESPACE } from '@foreman-code/contracts'
import { HostCiService } from './modules/ci-host/service.js'
import { GitCiCommits } from './modules/ci-host/commits.js'
import { RunCiAuthority } from './modules/jobs/ciAuthority.js'
import { ProductionHostCiEndpoint } from './modules/ci-host/endpoint.js'
import { HostCiRunner } from './modules/ci-host/runner.js'
import { cloudCis, workspaceMirrors } from './modules/ci-host/cloud.js'
import { agentSnapshots, type ReadAgentFiles } from './modules/ci-host/agentSnapshots.js'
import { systemGitWorktreePorts } from './modules/sources/gitWorktree.js'
import { registerComputerAccountsRoutes } from './routes/computerAccounts.js'
import { registerComputerMaintenanceRoutes } from './routes/computerMaintenance.js'
import { FleetMaintenanceService } from './modules/computers/fleet.js'
import { createProductionWorkerArtifactExtension } from './modules/computers/workerArtifactsProduction.js'
import { ComputerMaintenance, claudeUserMcpServers, installedPlugins, pluginMarketplaces, systemMaintenancePorts } from './modules/computers/maintenance.js'
import { ComputerGitHubService } from './modules/computers/github.js'
import { COMPUTER_MAINTENANCE_NAMESPACE, COMPUTER_MAINTENANCE_VERSION } from '@foreman-code/contracts/computer-maintenance'
import { COMPUTER_ACCOUNTS_NAMESPACE, COMPUTER_SYNC_NAMESPACE, COMPUTER_GITHUB_NAMESPACE } from '@foreman-code/contracts/computer-accounts'
import { ComputerSyncService } from './modules/computers/sync.js'
import { registerComputerSyncRoutes } from './routes/computerSync.js'
import { sessionStartDirectory } from './modules/harnesses/sessionStart.js'
import { recoverPersistedClaudeCompaction } from './modules/harnesses/claudeSdk/recoverCompaction.js'
import { registerBuildComputerRoutes } from './routes/buildComputers.js'
import { WORKSPACE_ROOT_EXTENSION } from '@foreman-code/contracts/workspace-root-policies'
import { PRODUCT_SLUG } from '@foreman-code/contracts/product'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { appMcpServerName } from './modules/harnesses/appMcpLauncher.js'
import { createMainRsyncEntrypoint } from './modules/byte-transfer/installedEntrypoints.js'
import { PostgresTrustedConnectionSetup } from './modules/devices/trustedConnectionSetup.js'
import {
  PostgresTrustedConnectionHumanAuthority,
  registerTrustedConnectionApprovalRoutes,
} from './modules/devices/trustedConnectionHumanAuthority.js'
import { registerTrustedConnectionRoutes } from './modules/devices/trustedConnectionManagement.js'
import { requirePrincipal } from './modules/access/http.js'
import { RsyncTransferAuthorizeRequestSchema } from '@foreman-code/contracts/byte-transfer'
import type { AcceptedTransferAuthority } from './modules/byte-transfer/carrier.js'
import type { InstalledMainRsyncProviders } from './modules/byte-transfer/productionComposition.js'
import { createInstalledRsyncComposition } from './modules/byte-transfer/productionComposition.js'
import { RSYNC_STAGE_EXTENSION, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { transferContextForBinding } from './modules/byte-transfer/carrier.js'
import { JOB_RUNTIME_QUALIFICATION_EXTENSION } from '@foreman-code/contracts/job-runtime'
import { interactionConnection } from './modules/interactions/connection.js'
import { createProductionRemoteWorkflow } from './modules/placement/productionRemoteWorkflow.js'
import { remoteMcpPreflight } from './modules/placement/remoteMcpPreflight.js'
import { closeCompletedWorkflowSources } from './modules/sources/workflowCleanup.js'
import { remoteWorkflowPreparationClosed } from './modules/sources/workflowPreparationCleanup.js'
import { readExecutionPlacement, readNativePlacement } from './modules/placement/persistence.js'
import { sourceNativeSessionContinues } from './modules/sources/workingDirectory.js'
import { placedContinuationValidator } from './modules/placement/continuation.js'
import { readLiveManagementPrincipal } from './modules/access/liveManagementPrincipal.js'
import { readSourceCurrentNativeSession } from './modules/sources/activeNativeSession.js'
import type { SourceActiveNativeSessionReader, SourceNativeSessionCaptureReader } from './modules/sources/executionHosts.js'
import { EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import { WORKER_MCP_EXTENSION } from '@foreman-code/contracts/worker-mcp-relay'
import { AgentPlacementProducer } from './modules/placement/agentProducer.js'
import { RunPlacementReadService } from './modules/placement/readService.js'
import { NodePlacementChoicesService } from './modules/placement/choicesService.js'
import { ProductionPlacementChoiceDiscovery } from './modules/placement/choiceDiscovery.js'
import { readRemoteObservations } from './modules/runs/remote/persistence.js'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { remoteExecutionStartupEnvironment } from './modules/settings/remoteExecutionConfig.js'
import { RemoteExecutionSettingsService } from './modules/settings/remoteExecution.js'
import { WorkerExecutionPolicy } from './modules/settings/workerExecution.js'
import { AgentExecutionPreparation } from './modules/placement/agentExecutionPreparation.js'
import { assertRemoteExecutionAuthority, createExecutionAuthorityExtension } from './modules/placement/executionAuthority.js'
import { MainWorkerMcpRelay, selectedMainMcpForward, createWorkerNativeOutputAuthorizationPort } from './modules/placement/workerMcpRelay.js'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { recoverWorkflowArtifactOutputs } from './modules/runs/remote/workflowArtifactRecovery.js'
import { readAcceptedPlacement } from './modules/placement/persistence.js'
import { repeatRuntimeDirectory, type RepeatRepositoryServices } from './modules/runs/repeatRepositoryHost.js'
import { SOURCE_OPERATION_EXTENSION } from '@foreman-code/contracts/source-operations'
import { BYTE_TRANSFER_NAMESPACE } from './modules/byte-transfer/carrier.js'
import { retainInstalledHarnessInventory } from './modules/harnesses/installedCodexInspection.js'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { RESOURCE_TELEMETRY_CAPABILITY, type TrustedTelemetryContext } from '@foreman-code/contracts/resource-telemetry'
import { createResourceTelemetryRuntime, type ResourceTelemetryRuntime } from './modules/resource-telemetry/runtime.js'
import { createPassiveTelemetryAuthorities } from './modules/resource-telemetry/productionAuthority.js'
import { createMainResourceTelemetryBindings } from './modules/resource-telemetry/ingestion/carrier.js'
import { registerResourceTelemetryRoutes } from './routes/resourceTelemetry.js'
import { registerResourceTelemetrySelectorRoutes } from './routes/resourceTelemetrySelector.js'
import { WorkspaceBoundLocationService } from './modules/workspace-roots/service.js'
import { ManagedWorkspaceRootService } from './modules/workspace-roots/managedRoot.js'
import { bootstrapLocalMainWorkspaceRoot } from './modules/workspace-roots/localMainBootstrap.js'
import { WorkspaceRepositoryService } from './modules/workspaces/repositoryService.js'
import { registerWorkspaceRepositoryRoutes } from './routes/workspaceRepository.js'
import { registerWorkspaceRootRoutes } from './modules/workspace-roots/transports.js'
import { RemoteJobMainRpcRequestRecordSchema } from '@foreman-code/contracts/remote-job-execution'
import { JOB_INPUT_NAMESPACE } from './modules/files/jobInputs/service.js'
import { PostgresWorkflowJobNodeStore, workflowJobStorePublication } from './modules/jobs/workflowStore.js'
import { createProductionJobs } from './modules/jobs/production.js'
import type { OperatorServices } from './mcp/operator/types.js'
import { registerJobRoutes } from './routes/jobs.js'
import { registerJobRuntimeProfileRoutes } from './routes/jobRuntimeProfiles.js'
import { registerSourceRoutes } from './routes/sources.js'
import { createClaudeProductionDiscovery } from './modules/harnesses/claudeSdk/bootstrap.js'
import { productionClaudeMetadata } from './modules/harnesses/claudeSdk/productionMetadata.js'
import { initializeNativeDefaults } from './modules/harnesses/initializeDefaults.js'
import { qualifyClaudeNativeProfile } from './modules/harnesses/claudeSdk/nativeProfileQualification.js'
import { installedClaudeProfilePin } from './modules/harnesses/claudeSdk/installedProfilePin.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from './modules/harnesses/claudeSdk/profileRevision.js'
import { discoverInventoryLauncher } from './modules/harnesses/hostDiscovery.js'
import { inventoryDriverPayloads } from './modules/harnesses/payloadDiscovery.js'
import { runCommand } from './modules/harnesses/process.js'
import { productionClaudeManager, type ClaudeProfileOwner } from './modules/harnesses/claudeSdk/production.js'
import { requireClaudeProductionCredentialDelivery } from './modules/harnesses/claudeSdk/productionCredentials.js'
import { ProviderAccountsService } from './modules/provider-accounts/service.js'
import { ProviderAccountsRepository } from './modules/provider-accounts/repository.js'
import { LocalProviderCredentials } from './modules/provider-accounts/localCredentials.js'
import { createProductionAccountSelection } from './modules/provider-accounts/productionSelection.js'
import { ProviderAccountWorkerAuthorityRequestSchema } from '@foreman-code/contracts/provider-accounts'
import { createRemoteAccountServices } from './modules/provider-accounts/remoteServices.js'
import { NativeProviderAccountCommands, type AccountNativeSelection } from './modules/provider-accounts/nativeCommands.js'
import { NativeProviderAccountOperations } from './modules/provider-accounts/nativeOperations.js'
import { NativeAccountJournal } from './modules/provider-accounts/nativeJournal.js'
import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { ProviderAccountConfigurationService } from './modules/harnesses/providerAccountConfiguration.js'
import { assertClaudeCredentialEndpoint } from './modules/harnesses/claudeSdk/mcpInspection.js'
import { PostgresClaudeInteractionAuthority } from './modules/harnesses/claudeSdk/domainAuthority.js'
import { productionSelectedProfileManager } from './modules/harnesses/selectedProfileProduction.js'
import { createProductionWorkerConversations } from './modules/conversations/workerProduction.js'
import { WorkerConversationCallbackSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { credentialAuthority } from './modules/interactions/wave25/credentialAuthority.js'
import type { GraphSqlClient } from './modules/run-graph/connection.js'
import { currentOperatorAuthority } from './modules/access/runAuthority.js'
import { requireAuthorization } from './modules/access/policy.js'
import { AcceptedHarnessProfileAdmission, AcceptedClaudeProfileAdmission, type AcceptedProfileAuthority } from './modules/harnesses/instanceSettings/acceptedProfile.js'
import { workflowProfileSelection } from './modules/harnesses/workflowProfileSelection.js'
import { authorizeOperatorProfileObservation } from './modules/harnesses/operatorProfileObservation.js'
import {
  HarnessExecutionRequestSchema,
  OperatorConfigurationVersionSchema,
  RETIRED_OPENCODE_MESSAGE,
  type AgentDefaults,
} from '@foreman-code/contracts'
import { inspectClaudeOperatorConfiguration } from './modules/harnesses/claudeSdk/operatorConfigurationInspection.js'
import { inspectWorkerClaudeOperatorConfiguration } from './modules/harnesses/workerClaudeOperatorInspection.js'
import { requireClaudePolicyQualification } from './modules/harnesses/claudeSdk/configuration.js'
import { qualificationError } from './modules/harnesses/qualificationErrors.js'
import { authorizeOperatorConfigurationRead } from './modules/operators/configurationRead.js'
import { operatorCodexFileAdmissions } from './modules/harnesses/operatorFiles/codex.js'
import { nativeCorrelation } from './modules/conversations/operatorChatRepository.js'
import { randomUUID } from 'node:crypto'
import { createWorkflowNativeCaptureChannel } from './modules/interactions/workflowNativeCapture.js'
import { createReviewNativeCaptureChannel } from './modules/interactions/reviewNativeCapture.js'
import { ReviewNativeProofServices } from './modules/interactions/reviewNativeProof.js'
import { readRetainedRemoteReviewer } from './modules/interactions/retainedRemoteReviewer.js'
import { PostgresRepeatReviewerBindings } from './modules/interactions/repeatReviewer.js'
import { createWorkflowRepositoryServices } from './modules/runs/workflowRepositoryServices.js'
import { createProductionWorkflowArtifactResultSource } from './modules/runs/remote/workflowArtifactResultProduction.js'
import { WorkflowArtifactResultAdoption } from './modules/runs/remote/workflowArtifactResultAdoption.js'
import { createWorkflowArtifactOutputsGate } from './modules/runs/remote/workflowArtifactAcceptance.js'
import { LocalWorkflowArtifactAuthority, workflowArtifactsAreLocal } from './modules/runs/remote/localWorkflowArtifactAuthority.js'
import { LocalWorkflowArtifacts } from './modules/runs/remote/localWorkflowArtifacts.js'
import { createLocalWorkflowNativeOutputs } from './modules/runs/remote/localWorkflowNativeOutputs.js'
import { readAcceptedRepeatRunLocked } from './modules/runs/repeatStartRead.js'
import { WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { qualifyCodex } from './modules/harnesses/codexProtocol.js'
import { PostgresWorkflowPhysicalArtifacts } from './modules/runs/remote/workflowPhysicalArtifacts.js'
import { readRuntimeIdentity } from './infrastructure/runtimeIdentity.js'
import { readTestResourcesIdentity } from './infrastructure/testRuntimeResources.js'
import { fileURLToPath } from 'node:url'
import { AppMcpRoutes } from './modules/harnesses/appMcpRoutes.js'
import { registerApprovalCheckpointResume } from './modules/runs/approvalCheckpointRegistration.js'
import { createCurrentNativeProductionFactory, isCurrentNativeProductionBinding } from './modules/runs/workflowProduction.js'
import { isDeepStrictEqual } from 'node:util'
import { NativeResponseJournal } from './modules/harnesses/recovery/responseJournal.js'
import { hasDetachedStdioProcess, hasNativeRestartDetachment, NativeProcessRegistry,
  type NativeProcessRecovery } from './modules/harnesses/recovery/processRegistry.js'
import { join, resolve } from 'node:path'

import type { ApiConfig } from './config.js'
import { buildApp } from './app.js'
import { registerProductionFileStorage } from './modules/files/production.js'
import { createProductionWorkflowFileContexts } from './modules/runs/remote/workflowNativeFilesProduction.js'
import {
  PostgresArtifactPublicationAuthority,
  PostgresAcceptedArtifactAttemptFence,
  type NativeArtifactAuthorityPorts,
} from './modules/runs/remote/nativeArtifactAuthority.js'
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
import { ClaudePluginSettingsService } from './modules/harnesses/claudePlugins.js'
import { readClaudePlugins } from './modules/computers/claudePlugins.js'
import { CodexPluginSettingsService } from './modules/harnesses/codexPluginSettings.js'
import { NativeCodexPlugins } from './modules/harnesses/codexPlugins.js'
import { MainCodexSelection } from './modules/computers/installedCodexSelection.js'
import { workspaceStorageRoot } from './modules/workspaces/storage.js'
import { HarnessDirectoryBrowser } from './modules/harnesses/directoryBrowser.js'
import { CodexMcpConnections } from './modules/harnesses/codexMcpConnections.js'
import type { CheckpointStore } from './infrastructure/checkpoints.js'
import type { createDatabase } from './infrastructure/database.js'
import { OperatorRuntimeOwner } from './infrastructure/operatorRuntimeOwner.js'
import { RuntimeShutdown } from './infrastructure/runtimeShutdown.js'
import { PostgresAccessService } from './modules/access/postgres.js'
import { PostgresLocalHumanAccess } from './modules/access/localHuman.js'
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
import { BugReportService } from './modules/bug-reports/service.js'
import { DomainError } from './modules/errors.js'
import { productionSubagentControls } from './modules/subagents/productionControls.js'
import { HarnessCatalogService } from './modules/harnesses/catalog.js'
import { FileCompatibilityCache } from './modules/harnesses/compatibility/cache.js'
import { scopedCompatibilityProbe } from './modules/harnesses/compatibility/scopedProbe.js'
import { HarnessCompatibilityService } from './modules/harnesses/compatibility/service.js'
import { HarnessQualificationRepository } from './modules/harnesses/qualification/repository.js'
import { HarnessQualificationRegistry } from './modules/harnesses/qualification/registry.js'
import { HarnessQualificationService } from './modules/harnesses/qualification/service.js'
import type { QualificationSuite } from './modules/harnesses/qualification/types.js'
import { withNativeQualificationOwnership } from './modules/harnesses/qualification/nativeOwnership.js'
import { qualificationIdentity, withQualificationIdentity } from './modules/harnesses/qualification/identity.js'
import type { CompatibilityHarness } from '@foreman-code/contracts'
import { NativeHarnessFactories } from './modules/harnesses/runtimeFactory.js'
import type { ProductionHarnessInfrastructure } from './modules/harnesses/productionInfrastructure.js'
import { productionCodexChatFiles, type ProductionCodexChatFiles } from './modules/harnesses/codexFiles/production.js'
import { McpDetectionService, WorkerLaunchCredentialService, type ExecutionCredentialProvider } from './modules/harnesses/mcpDetection.js'
import { productionOperatorManagers } from './modules/harnesses/operatorFiles/managers.js'
import { ExecutionReadinessService } from './modules/harnesses/executionReadiness.js'
import { NativeRollout } from './modules/harnesses/nativeRollout.js'
import type { NativeHarnessSessionManager } from './modules/harnesses/port.js'
import { NativeHarnessConfigurationQualifier } from './modules/harnesses/nativeConfigurationQualifier.js'
import { PostgresAppInteractionService } from './modules/interactions/app.js'
import { PostgresApprovalBudgetRepository } from './modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from './modules/interactions/execution.js'
import { PostgresWorkflowClosureStore } from './modules/interactions/workflowClosure.js'
import { retryStartupDatabase } from './infrastructure/startupDatabase.js'
import { OperatorInteractionService } from './modules/interactions/operator.js'
import { Wave25InteractionRepository as PostgresInteractionRepository } from './modules/interactions/wave25/repository.js'
import { ExecutionScopedNativeSessionManagerResolver,
  type NativeManagerResolutionContext } from './modules/interactions/runtimePorts.js'
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
import { requiredLocationAccess, WorkspaceLocationService } from './modules/workspaces/location.js'
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
import { HarnessInstallationMonitor } from './modules/harnesses/installationMonitor.js'
import { createInstalledNativeQualificationRetention } from './modules/harnesses/installedNativeQualificationRetention.js'
import { HostHarnessOverrideService, type HostHarnessOverrideAuthority } from './modules/harnesses/instanceSettings/service.js'
import { commandInputHash } from './modules/commands/postgres.js'
import { authorizeDeviceHost, assertDeviceHostInstallation } from './modules/devices/hostAuthorization.js'

/** The native owner supplies slot-specific installation and isolation qualification. */
export type ProductionProviderAccountSelection = AccountNativeSelection & {
  selectAccount?: NonNullable<ConstructorParameters<typeof NativeHarnessFactories>[0]['selectAccount']>
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
  infrastructure?: ProductionHarnessInfrastructure,
  accountSelection?: ProductionProviderAccountSelection,
) {
  const mainCodex = new MainCodexSelection(config.harnesses.codexBinary,
    resolve(config.harnesses.workspaceRoot, 'main-codex-selection.json'), systemMaintenancePorts())
  const mainBinaries = { get codexBinary() { return mainCodex.binary } }
  const workerExecution = new WorkerExecutionPolicy(config.workerExecution)
  if (infrastructure?.mode === 'replay' && (!infrastructure.auxiliary
    || !infrastructure.auxiliary.compatibility || !infrastructure.auxiliary.plugins
    || !infrastructure.auxiliary.mcp?.codex
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
        return jobRuntime.inputs.main.authorizedTransfer(id, transferContextForBinding(binding))
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
      }, readAcceptedTransfer: (...args) => {
        if (!trustedConnections) throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'Connection consent is unavailable.', 503)
        return trustedConnections.readAcceptedTransfer(...args)
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
  const remoteTelemetry = createMainResourceTelemetryBindings(() => telemetry?.service)
  const deviceRuntime = new ProductionDeviceRuntime(database.pool, infrastructure?.deviceListener, {
    extensions: [
      remoteTelemetry.extension,
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
          if (payload && typeof payload === 'object' && 'operation' in payload
            && typeof payload.operation === 'string' && payload.operation.startsWith('conversation-mcp.')) {
            if (context.bytes !== undefined) throw new DomainError('WORKER_CONVERSATION_MCP_DENIED', 'Chat MCP cannot carry transfer bytes.', 403)
            return { payload: await workerChats.mcp.handle(payload, context.binding, context.signal) }
          }
          if (!mainWorkerMcp) throw new DomainError('WORKER_MCP_UNAVAILABLE', 'The original Main worker MCP authority has not initialized.', 503)
          context.signal.throwIfAborted()
          const result = await mainWorkerMcp.handle(payload, context.binding, context.signal)
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
      { namespace: 'provider-accounts-v1', version: 1, role: 'duplex', maxJsonBytes: 65_536, maxBinaryBytes: 0,
        async handle(raw, context) {
          const request = ProviderAccountWorkerAuthorityRequestSchema.parse(raw)
          const target = request.kind === 'binding' ? request.binding.target : request.operation.binding.target
          const current = deviceRuntime.endpointForDomains().currentBinding(context.binding.deviceId)
          if (context.bytes !== undefined || !isDeepStrictEqual(current, context.binding)
            || target.hostRef.kind !== 'device' || target.hostRef.deviceId !== context.binding.deviceId
            || target.hostRef.mainId !== context.binding.mainId
            || target.applicationInstallationId !== context.binding.workerInstallationId
            || target.keyRevision !== context.binding.keyRevision
            || target.authorizationRevision !== context.binding.authorizationRevision) {
            throw new DomainError('ACCESS_DENIED', 'The original Worker account authority is unavailable.', 403)
          }
          let payload: { available: true } | { allowed: true }
          if (request.kind === 'binding') {
            const resolved = await providerAccounts.resolve(request.binding.provider, request.binding.accountId,
              { allowDefault: false, acceptedBinding: request.binding })
            if (!resolved) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'The accepted account is unavailable.', 409)
            payload = { available: true }
          } else {
            await providerAccounts.assertAuthenticationEligibility(request.operation)
            payload = { allowed: true }
          }
          if (!isDeepStrictEqual(current, deviceRuntime.endpointForDomains().currentBinding(context.binding.deviceId))) {
            throw new DomainError('ACCESS_DENIED', 'The original Worker account channel changed.', 403)
          }
          return { payload }
        } },
      { namespace: COMPUTER_ACCOUNTS_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 65_536, maxBinaryBytes: 0 },
      { namespace: COMPUTER_MAINTENANCE_NAMESPACE, version: COMPUTER_MAINTENANCE_VERSION, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      createProductionWorkerArtifactExtension({
        environment: process.env,
        releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)),
      }),
      { namespace: COMPUTER_GITHUB_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 16_384, maxBinaryBytes: 0 },
      { namespace: COMPUTER_SYNC_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: AGENT_SNAPSHOT_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: CI_RUNTIME_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: CI_HOST_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: 'host-harness-check-v1', version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: 'execution-v1', version: 1, role: 'duplex', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
        handle: async (payload, context) => {
          if (WorkerConversationCallbackSchema.safeParse(payload).success) {
            if (!workerChats || context.bytes !== undefined) throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE',
              'The Main conversation callback authority is unavailable.', 503)
            return { payload: await workerChats.bridge.handle(payload, context.binding, context.signal) }
          }
          if (RemoteJobMainRpcRequestRecordSchema.safeParse(payload).success) {
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
      ...(infrastructure?.deviceDomains?.extensions.filter(value => !['execution-v1', JOB_INPUT_NAMESPACE, BYTE_TRANSFER_NAMESPACE,
        remoteTelemetry.extension.namespace].includes(value.namespace)) ?? []),
    ],
    async bindingLost(binding) {
      const tasks: Promise<unknown>[] = []
      tasks.push(remoteTelemetry.lost(binding))
      try { if (rsync.kind === 'configured') tasks.push(rsync.rsyncWriters.bindingLost(binding)) } catch (error) { tasks.push(Promise.reject(error)) }
      try { const task = infrastructure?.deviceDomains?.bindingLost?.(binding); if (task) tasks.push(task) } catch (error) { tasks.push(Promise.reject(error)) }
      const results = await Promise.allSettled(tasks), failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Original device domain binding cleanup remains incomplete')
    },
    async bindingReady(binding, signal, endpoint) {
      if (runtimeServices.computerSync) {
        void runtimeServices.computerSync.paired({
          hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
          applicationInstallationId: binding.workerInstallationId,
          keyRevision: binding.keyRevision, authorizationRevision: binding.authorizationRevision,
        }).catch(error => app.log.warn({ err: error, deviceId: binding.deviceId }, 'Shared file pairing is pending'))
      }
      installationMonitor.workerReady(binding, signal)
      try {
        const session = await remoteTelemetry.ready(binding, signal, endpoint)
        if (session) void session.completion.catch(error => {
          if (!signal.aborted) app.log.error({ err: error, deviceId: binding.deviceId }, 'Remote resource telemetry collector failed')
        })
      } catch (error) {
        if (!signal.aborted) app.log.error({ err: error, deviceId: binding.deviceId }, 'Remote resource telemetry collector did not start')
      }
    },
    async reconcile(binding, signal, endpoint) {
      if (endpoint.capabilities(binding.deviceId).some((item) => item.namespace === 'harness-discovery-v1' && item.mainCanRequest)) {
        const result = await endpoint.request(binding.deviceId, 'harness-discovery-v1',
          { operation: 'discover', refreshId: randomUUID() }, { signal })
        signal.throwIfAborted()
        if (selectedSuites) await retainInstalledHarnessInventory({ registry: harnessRegistry, qualifications: qualificationRepository,
          binding, inventory: result.payload, suiteRevision: selectedSuites.codex.revision })
        else harnessRegistry.acceptRemoteSnapshot(binding, result.payload)
      }
      if (infrastructure?.deviceDomains) await infrastructure.deviceDomains.reconcile(binding, signal, endpoint)
      setImmediate(() => {
        if (!signal.aborted) {
          jobRuntime?.requestQueueWake()
          runtimeServices.ciEnrollment?.request()
        }
      })
    },
  })
  const commands = new PostgresCommandCoordinator(database.pool)
  const bugReports = new BugReportService(database.pool, commands)
  const accountCredentials = new LocalProviderCredentials(resolve(config.harnesses.workspaceRoot, 'provider-accounts'))
  const selectedAccounts: ProductionProviderAccountSelection = accountSelection ?? createProductionAccountSelection({
    path: resolve(config.harnesses.workspaceRoot, 'provider-account-qualifications.json'),
    managedPaths: accountId => accountCredentials.paths(accountId),
    validate: () => harnessRegistry.refreshMain(),
    pin: record => harnessRegistry.pinOverride(record.override),
    models: async (binding, generation) => {
      const options = await nativeConfigurations.options(binding.provider, binding)
      const selected = selectedAccounts.selectAccount?.(binding)
      if (!selected) throw new DomainError('PROVIDER_ACCOUNT_UNQUALIFIED', 'Account model installation is unavailable.', 409)
      return { binding, generation, observedAt: options.checkedAt,
        models: options.models.map(row => ({ ...row, name: row.name ?? row.id })), options }
    },
  })
  const accountCommands = new NativeProviderAccountCommands(selectedAccounts)
  const accountNative = processRegistry instanceof NativeProcessRegistry
    ? new NativeProviderAccountOperations(accountCommands,
      new NativeAccountJournal(resolve(config.harnesses.workspaceRoot, 'provider-account-operations')), processRegistry,
      input => providerAccounts.assertAuthenticationEligibility(input.operation))
    : accountCommands
  const providerAccounts: ProviderAccountsService = new ProviderAccountsService(database.pool,
    new ProviderAccountsRepository(database.pool, () => accountCredentials.hostId()), accountCredentials,
    accountNative, commands)
  providerAccounts.bindTarget(async sql => {
    const row = (await sql.query<{ id: string }>(
      'select id from application_installation where singleton=true')).rows[0]
    if (!row) throw new DomainError('PROVIDER_ACCOUNT_TARGET_UNAVAILABLE', 'The canonical Main installation is unavailable.', 503)
    return { hostRef: { kind: 'main', mainId: row.id }, applicationInstallationId: row.id,
      keyRevision: null, authorizationRevision: null }
  })
  providerAccounts.bindRouting(createRemoteAccountServices({ pool: database.pool, commands, local: providerAccounts,
    endpoint: () => deviceRuntime.endpointForDomains() }))
  const workflowAccountBindings = new Map<string, AcceptedProviderAccountBinding>()
  const accountConfigurations = new ProviderAccountConfigurationService(providerAccounts)
  // Producer/consumer halves are installed during construction. Neither HTTP,
  // MCP nor a caller-supplied JSON observation can manufacture these captures.
  const workflowCapture = createWorkflowNativeCaptureChannel()
  const reviewCapture = createReviewNativeCaptureChannel()
  let admitWorkflowFileContext: ReturnType<typeof createProductionWorkflowFileContexts> | undefined
  let artifactResultSource: ReturnType<typeof createProductionWorkflowArtifactResultSource> | undefined
  let artifactOutputsGate: ReturnType<typeof createWorkflowArtifactOutputsGate> | undefined
  let localWorkflowArtifacts: LocalWorkflowArtifacts | undefined
  const workflowRuntime = createWorkflowRepositoryServices(workflowCapture.verify, (sql, owner, capture) => {
    if (!remoteWorkflow) throw new DomainError('REMOTE_WORKFLOW_UNAVAILABLE', 'The actual original native physical composition is unavailable.', 503)
    return remoteWorkflow.assertPhysical(sql, owner, capture)
  }, async (sql, evidence, proof) => {
    if (!admitWorkflowFileContext) throw new DomainError('NATIVE_ARTIFACT_CONTEXT_UNAVAILABLE', 'The original Main file-context composition is unavailable.', 503)
    await admitWorkflowFileContext(sql, evidence, proof)
    if (await workflowArtifactsAreLocal(sql, proof.scope.runId, proof.ref.nodeId)) {
      const snapshot = await readAcceptedRepeatRunLocked(sql, proof.scope.runId)
      const node = snapshot.version.definition.nodes.find(item => item.id === proof.ref.nodeId)
      if (node && node.kind !== 'job' && node.artifactOutputs) {
        if (!localWorkflowArtifacts) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
          'Local workflow artifact storage is unavailable.', 503)
        await localWorkflowArtifacts.admitContextLocked(sql, workflowCapture.verify.read(evidence), proof)
      }
      return
    }
    await artifactResultSource?.retainOriginalLocked(sql, evidence, proof)
  })
  const workflowServices: RepeatRepositoryServices = { ...workflowRuntime.services,
    async reconcileWorkflowArtifacts(owner, run, execution, signal) {
      signal.throwIfAborted()
      const snapshot = await runs.getRepeatSnapshot(run.id, owner)
      const node = snapshot.version.definition.nodes.find((item) => item.id === execution.workflowNodeId)
      if (!node || node.kind === 'job' || !node.artifactOutputs) return
      if (await workflowArtifactsAreLocal(database.pool, execution.runId, execution.workflowNodeId)) {
        if (!localWorkflowArtifacts) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
          'Local workflow artifact storage is unavailable.', 503)
        await localWorkflowArtifacts.recover(owner, execution, signal)
        return
      }
      if (!artifactComposition || !workflowArtifacts) {
        throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The original artifact composition is unavailable.', 503)
      }
      await recoverWorkflowArtifactOutputs({ owner, execution, authority: artifactComposition.authority,
        outputs: workflowArtifacts.artifacts.outputs })
    },
    async assertWorkflowArtifactOutputsLocked(sql, run, version, execution) {
      if (await workflowArtifactsAreLocal(sql, execution.runId, execution.workflowNodeId)) {
        if (!localWorkflowArtifacts) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
          'Local workflow artifact storage is unavailable.', 503)
        await localWorkflowArtifacts.assertOutputsLocked(sql, run, version, execution)
        return
      }
      if (!artifactOutputsGate) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The original workflow artifact acceptance composition is unavailable.', 503)
      await artifactOutputsGate(sql, run, version, execution)
    },
    async admitPlacementExecutionLocked(sql, owner, run, execution, ref, inputDigest) {
      if (agentPlacement) { await agentPlacement.admitExecution(sql, owner, execution, ref, inputDigest, run.authorizationPrincipalId); return }
      if (await readAcceptedPlacement(sql, run.id, execution.workflowNodeId)) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual Agent placement producer is unavailable.', 503)
    },
    async preparePlacementExecution(owner, run, execution) {
      if (!artifactResultSource) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The original workflow artifact composition is unavailable.', 503)
      await owner.oneShotConnection().transaction(sql => artifactResultSource!.assertLaunchDeclarationLocked(sql, execution.id, run.id))
      if (agentPreparation) {
        const prepared = await approvals.withSourceObservationLane(owner, execution, () => agentPreparation!.prepare(owner, run, execution))
        if (prepared) return { ...prepared, revalidate: () => approvals.withSourceObservationLane(owner, execution, prepared.revalidate) }
      }
      const placed = await owner.oneShotConnection().transaction(sql => readAcceptedPlacement(sql, run.id, execution.workflowNodeId))
      if (placed) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual Agent source preparation producer is unavailable.', 503)
      await locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId, owner.client)
      const configuration = await workflows.getAgentConfiguration(execution.agentConfigurationVersionId)
      if (!configuration) throw new DomainError('AGENT_CONFIGURATION_NOT_FOUND', 'The accepted Agent configuration is unavailable.', 409)
      const access = requiredLocationAccess([configuration])
      await locations.revalidateSnapshot(run.workspaceId, run.executionLocation, access)
      const tree = await runWorktrees.prepare(run)
      if (!tree) return undefined
      return { workingDirectory: tree.workingDirectory,
        runtimeDirectory: repeatRuntimeDirectory(config.harnesses.workspaceRoot, { workspaceId: run.workspaceId,
          workflowId: run.workflowId, workflowVersionId: run.workflowVersionId, runId: run.id, executionSemanticsVersion: 3 }, execution),
        revalidate: async () => {
          owner.assertOwned()
          await locations.revalidateSnapshot(run.workspaceId, run.executionLocation, access)
          await runWorktrees.verify(tree)
        } }
    },
  }
  const reviewNativeProofs = new ReviewNativeProofServices(reviewCapture.verify,
    (sql, capture) => remoteWorkflow.assertReviewPhysical(sql, capture))
  const repository = new PostgresInteractionRepository(database.pool, reviewNativeProofs)
  const budgets = new PostgresApprovalBudgetRepository(database.pool)
  const projectRoot = config.workspaceStorageRoot ?? workspaceStorageRoot()
  const runWorktrees = new RunWorktrees(database.pool, join(config.harnesses.workspaceRoot, 'run-worktrees'))
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
    preparationTimeoutMs: config.harnesses.timeoutMs,
    workerExecution,
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
  const harnessRegistry = new ProductionHarnessRegistry(database.pool, mainBinaries,
    (client) => settings.getManagedHarnessDefaults(client), hostProfileEvidence,
    (deviceId) => { const view = deviceRuntime.presenceFor(deviceId); return view?.phase === 'ready' ? view.binding : null },
    process.env, infrastructure?.inventoryDiscovery ?? { launcher: discoverInventoryLauncher, payloads: inventoryDriverPayloads,
      claude: claudeDiscovery.discover }, (deviceId) => deviceRuntime.currentBinding(deviceId),
    (deviceId) => deviceRuntime.presenceFor(deviceId))
  const foundationSettings = new PostgresFoundationSettingsRepository(database.pool, projectRoot)
  const remoteExecution = new RemoteExecutionSettingsService(foundationSettings, commands, workerExecution,
    deviceRuntime, remoteExecutionStartupEnvironment({ listener: infrastructure?.deviceListener,
      workerExecution: config.workerExecution, environment: config.remoteExecutionEnvironment ?? {} }), config.port,
    error => app.log.error({ err: error }, 'device listener settings could not be applied'))
  const operators = new PostgresOperatorRepository(database.pool, accountConfigurations)
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
  } : qualificationSuites
  const qualificationRegistry = selectedSuites ? new HarnessQualificationRegistry(qualificationRepository, {
    codex: selectedSuites.codex.revision,
  }) : undefined
  const harnessQualifications = selectedSuites && qualificationRegistry ? new HarnessQualificationService(
    qualificationRepository, qualificationRegistry, selectedSuites,
    { get codex() { return mainCodex.binary } }, commands, settings,
    undefined, (harness) => harnessCompatibility.refreshAfterQualification(harness),
    (harness, binary, timeoutMs) => compatibilityProbe(timeoutMs, { harness, binary }),
    (harness, signal) => {
      if (harness !== 'codex') throw new DomainError('HARNESS_DRIVER_UNAVAILABLE', 'Unsupported qualification driver.', 409)
      return harnessRegistry.refreshMain(signal)
    },
    harness => commandInputHash(qualificationIdentity(harnessRegistry.pinDefault(harness), selectedSuites[harness].revision)),
  ) : undefined
  // Compatibility diagnostics do not grant execution readiness; automatic restoration uses the native suite.
  const harnessCompatibility = infrastructure?.auxiliary
    ? new HarnessCompatibilityService({ ...infrastructure.auxiliary.compatibility, commands })
    : new HarnessCompatibilityService({ probe: compatibilityProbe(), cache: new FileCompatibilityCache(), commands })
  const endpointHost = config.host === '0.0.0.0' ? '127.0.0.1'
    : config.host === '::' || config.host === '::1' ? '[::1]' : config.host
  // One endpoint for every role; the bearer credential decides Operator, Orchestrator or Coder.
  const appMcpEndpoint = `http://${endpointHost}:${config.port}/mcp`
  const nativeFactories = new NativeHarnessFactories({ get codexBinary() { return mainCodex.binary }, responseJournal,
    accounts: providerAccounts,
    ...(selectedAccounts.selectAccount ? { selectAccount: selectedAccounts.selectAccount } : {}),
    refreshInstallations: signal => harnessRegistry.refreshMain(signal),
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
    await withTransaction(database.pool, async (connection) => {
      await authorizeDeviceHost(connection, principal, action, hostRef, applicationInstallationId)
    })
  } }
  const profileAuthority: AcceptedProfileAuthority<ClaudeProfileOwner> = {
    async authorize(binding, selector, client) {
      binding.admissionSignal?.throwIfAborted()
      if (binding.kind === 'workflow') {
        const current = await credentialAuthority(client, binding.executionId, binding.purpose ?? 'workflow')
        if (current.run.id !== binding.runId || current.execution.attempt !== binding.attempt) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The exact Run attempt changed.', 409)
        if (!current.nativeSessionId && binding.purpose !== 'reviewer') {
          const owner = binding.getOwner()
          if (!owner || owner.runId !== binding.runId) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The original native launch owner is unavailable.', 409)
          owner.assertOwned(); await owner.readOneShotFence(owner.client)
        }
        const row = (await client.query<{ principal_id: string }>("select record->>'authorizationPrincipalId' as principal_id from runs where id=$1", [binding.runId])).rows[0]
        if (!row?.principal_id) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The accepted Run principal is unavailable.', 409)
        const principal = (await currentOperatorAuthority(client, row.principal_id)).principal
        requireAuthorization(principal, 'runs:start', { workspaceId: current.run.workspaceId, workflowId: current.run.workflowId })
      } else if (binding.kind === 'operator-observation') {
        await authorizeOperatorProfileObservation(client, binding, selector)
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
      } else await new PostgresClaudeInteractionAuthority(client, binding, { nativeCallbackContext: () => undefined }).profileAdmission()
      await assertDeviceHostInstallation(client, selector.target.hostRef, selector.target.applicationInstallationId)
      binding.admissionSignal?.throwIfAborted()
    },
    async current(binding, value, client) {
      if (value.driverId === 'claude') {
        await requireClaudeProductionCredentialDelivery(value.configuration, providerAccounts, value.target.hostRef)
        if (value.target.hostRef.kind === 'device') {
          const registry = harnessRegistry.pinOverride(value)
          const proof = await hostProfileEvidence.latest(value.instanceId, value.revision, client)
          const pin = installedClaudeProfilePin(value, registry, proof)
          harnessRegistry.installations.assertCurrent(registry)
          return { registry, pin, applicationInstallationId: value.target.applicationInstallationId,
            suiteRevision: CLAUDE_PROFILE_CHECK_REVISION }
        }
        const current = infrastructure?.claudeCurrentProfile ?? (infrastructure?.mode === 'replay' ? undefined : claudeDiscovery.current)
        if (!current) throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Claude replay requires its current installed profile metadata port.', 500)
        return current(binding, value, client)
      }
      if (binding.kind !== 'operator-observation' && !await harnessRegistry.profileEvidence(value, client)) {
        throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The exact accepted native profile proof is stale.', 409)
      }
      return { registry: harnessRegistry.pinOverride(value), applicationInstallationId: value.target.applicationInstallationId,
        suiteRevision: `${value.driverId}-profile-check-v1` }
    },
    assertCurrent: binding => harnessRegistry.installations.assertCurrent(binding),
    assertReady: host => hostProfileChecks.assertReady(host),
  }
  const selectedProfiles = new AcceptedHarnessProfileAdmission<ClaudeProfileOwner>(hostSettings, hostProfileEvidence, profileAuthority)
  const claudeProfiles = infrastructure?.claudeProfiles ?? new AcceptedClaudeProfileAdmission<ClaudeProfileOwner>(hostSettings, hostProfileEvidence, profileAuthority)
  const hostProfileChecks = new HostHarnessInstanceProfileChecks(hostSettings, hostProfileEvidence, commands, hostAuthority,
    new ProductionHostHarnessProfileQualifier(harnessRegistry, nativeFactories, () => deviceRuntime.endpointForDomains(), config.harnesses.workspaceRoot,
      infrastructure?.mode === 'replay' ? undefined : { async qualify(value, input) {
        const apiKey = await requireClaudeProductionCredentialDelivery(value.configuration, providerAccounts, value.target.hostRef)
        const current = await claudeDiscovery.currentForConfiguration(value, input.signal)
        const binding = harnessRegistry.pinOverride(value)
        const recovery = processRegistry.reserveLaunch(`claude-profile-check:${input.checkId}`)
        const close = async () => {
          await processRegistry.abandonReservedLaunch(recovery)
          if (!await processRegistry.closeOwner(recovery.owner)) throw new Error('Claude native profile qualification closure is unconfirmed.')
        }
        try { return await qualifyClaudeNativeProfile({ value, checkId: input.checkId, binding, pin: current.pin,
          ...(apiKey ? { apiKey } : {}),
          directory: resolve(config.harnesses.workspaceRoot, 'claude-native-qualification'), recovery, signal: input.signal,
          assertCurrent: async () => { await nativeFactories.assertInstallationUnchanged(binding, input.signal); harnessRegistry.installations.assertCurrent(binding) } }) }
        finally { await close() }
      } }, workerExecution, providerAccounts), selectedSuites ? createInstalledNativeQualificationRetention({
      repository: qualificationRepository, suiteRevision: selectedSuites.codex.revision,
      currentBinding: deviceId => deviceRuntime.endpointForDomains().captureRequest(deviceId, 'host-harness-check-v1')?.binding ?? null,
      currentInstallation: value => harnessRegistry.pinOverride(value).installation,
      async refreshInstallation(value, signal) {
        if (value.target.hostRef.kind !== 'device') return
        const captured = deviceRuntime.endpointForDomains().captureRequest(value.target.hostRef.deviceId, 'harness-discovery-v1')
        if (!captured) throw new DomainError('HARNESS_INVENTORY_STALE', 'The qualified Worker connection is unavailable.', 409)
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)])
        const result = await captured.request({ operation: 'discover', refreshId: randomUUID() }, { signal: bounded })
        bounded.throwIfAborted()
        await retainInstalledHarnessInventory({ registry: harnessRegistry, qualifications: qualificationRepository,
          binding: captured.binding, inventory: result.payload, suiteRevision: selectedSuites.codex.revision })
      },
    }) : undefined)
  const harnessInstances = new HostHarnessOverrideService(hostSettings, commands, hostAuthority, async (value, client) => {
    await requireClaudeProductionCredentialDelivery(value.configuration, providerAccounts, value.target.hostRef)
    const proof = await harnessRegistry.profileEvidence(value, client, { includeFailed: true })
    return proof ? { target: proof.target, configurationFingerprint: proof.configurationFingerprint,
      qualified: proof.qualified, ...(proof.failure ? { failure: proof.failure } : {}) } : null
  }, hostProfileChecks, configuration => {
    const binding = harnessRegistry.pinAccepted({ id: `operator-default-profile:${commandInputHash(configuration)}`, agentId: 'operator-default-setup', harness: configuration })
    const hostRef = binding.selection.hostRef
    if (hostRef.kind !== 'main' || !binding.installation.installationFingerprint) throw new DomainError('CLAUDE_INSTALLATION_UNAVAILABLE', 'The actual local Claude installation is unavailable.', 409)
    return { hostRef, applicationInstallationId: hostRef.mainId, harnessInstallationId: binding.selection.harnessInstallationId,
      installationFingerprint: binding.installation.installationFingerprint }
  }, accountConfigurations)
  accountConfigurations.bindProfiles(harnessInstances)
  const installationMonitor = new HarnessInstallationMonitor(harnessRegistry, hostProfileChecks,
    () => deviceRuntime.endpointForDomains(), async (binding, inventory) => {
      if (selectedSuites) await retainInstalledHarnessInventory({ registry: harnessRegistry,
        qualifications: qualificationRepository, binding, inventory, suiteRevision: selectedSuites.codex.revision })
      else harnessRegistry.acceptRemoteSnapshot(binding, inventory)
    }, async () => {
      if (!harnessQualifications) return
      const result = await harnessQualifications.verify('codex', { force: true })
      if (result.status !== 'qualified') throw new DomainError('HARNESS_REQUALIFICATION_FAILED',
        result.failureReason ?? 'The updated Codex installation failed its native checks.', 409)
    }, error => app.log.error({ err: error }, 'Automatic harness installation checks failed'),
    infrastructure?.installationRefreshIntervalMs)
  const claudeMetadata = infrastructure?.mode === 'replay' ? undefined : productionClaudeMetadata({ registry: harnessRegistry,
    accounts: providerAccounts,
    ...(selectedAccounts.selectAccount ? { selectAccount: selectedAccounts.selectAccount } : {}),
    processes: processRegistry, factories: nativeFactories, settings: hostSettings, defaults: () => settings.getHarnessDefaults(), current: claudeDiscovery.currentForConfiguration })
  const qualifier = new NativeHarnessConfigurationQualifier(config.harnesses.codexBinary, nativeFactories, claudeMetadata, providerAccounts)
  const harnessCatalog = new HarnessCatalogService(qualifier, settings, commands, config.harnesses.workspaceRoot, appMcpEndpoint)
  const nativeConfigurations = new NativeConfigurationService(
    config.harnesses.codexBinary, config.harnesses.workspaceRoot, nativeFactories, claudeMetadata, providerAccounts,
  )
  const appRoutes = new AppMcpRoutes(database.pool, appMcpEndpoint)
  const maintenancePorts = systemMaintenancePorts(process.env, { get codex() { return mainCodex.binary } })
  maintenancePorts.selectInstalledCodex = async signal => {
    const binary = await mainCodex.selectInstalled(signal)
    await harnessRegistry.refreshMain(signal)
    harnessCatalog.invalidateChecks()
    nativeConfigurations.invalidateOptions()
    return binary
  }
  const harnessSettings = {
    claudePlugins: new ClaudePluginSettingsService(maintenancePorts, commands),
    directories: new HarnessDirectoryBrowser([projectRoot], database.pool),
    plugins: new CodexPluginSettingsService(database.pool, infrastructure?.auxiliary?.plugins ?? new NativeCodexPlugins(() => mainCodex.binary, config.harnesses.workspaceRoot,
      processRegistry.scope('settings:plugins:codex')), () => processRegistry.closeOwner('settings:plugins:codex')),
    mcp: new HarnessMcpSettingsService(database.pool, commands, {
      codex: infrastructure?.auxiliary?.mcp.codex ?? new CodexMcpConnections(() => mainCodex.binary, config.harnesses.workspaceRoot, processRegistry.scope('settings:mcp:codex')),
    }, () => { harnessCatalog.invalidateChecks(); nativeConfigurations.invalidateOptions() }, async () => {
      await processRegistry.closeOwner('settings:mcp:codex')
    }, appMcpEndpoint),
  }
  const launchScopes = new WeakMap<NativeHarnessSessionManager, NativeProcessRecovery>()
  const claudeLaunches = new WeakMap<NativeHarnessSessionManager, ReturnType<typeof productionClaudeManager>>()
  const managers = new ExecutionScopedNativeSessionManagerResolver((context, getOwner) => {
    const configuration = context.configuration.harness
    const acceptedAccount = workflowAccountBindings.get(context.executionId)
    const accountBinding = acceptedAccount?.kind === 'slot' ? acceptedAccount : undefined
    if (configuration.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    if (configuration.harness !== context.harness) {
      throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The pinned configuration does not match the execution harness.', 409)
    }
    const remoteAccount = context.acceptedPlacement?.hostRef.kind === 'device'
      || context.configuration.harnessProfileSelection?.target.hostRef.kind === 'device'
    if (configuration.accountId && remoteAccount) {
      throw new DomainError('PROVIDER_ACCOUNT_LOCAL_ONLY', 'Managed provider accounts cannot run on another computer.', 409)
    }
    // Object allocation remains native/registry IO-free. The coordinator reserves
    // this SAME scope immediately before its lifetime/entered commits.
    const recovery = processRegistry.scope(`execution:${context.executionId}`)
    const remote = remoteWorkflow!.manager(context, getOwner)
    if (remote) return remote
    const nativeOutputs = configuration.harness === 'codex' && context.artifactOutputs && !context.purpose
      ? createLocalWorkflowNativeOutputs({ executionId: context.executionId, artifacts: () => {
        if (!localWorkflowArtifacts) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
          'Local workflow artifact storage is unavailable.', 503)
        return localWorkflowArtifacts
      }, stateDirectory: fileStorageRoot, assertCurrent: async signal => {
        signal?.throwIfAborted()
        const owner = getOwner()
        if (!owner || owner.runId !== context.runId) throw new DomainError('RUN_OWNERSHIP_LOST',
          'The local workflow no longer owns its native output turn.', 409)
        owner.assertOwned()
      }, qualification: { registry: processRegistry, qualify: qualifyCodex, command: runCommand } }) : undefined
    const selector = workflowProfileSelection(context,
      remoteWorkflow!.binding(context.executionId)?.executionPlacement?.workingTree.canonicalCwd)
    if (configuration.harness === 'claude') {
      if (!context.runId || !context.attempt) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE',
        'Claude requires the persisted Run and execution attempt.', 409)
      const claude = productionClaudeManager({ pool: database.pool, factories: nativeFactories, registry: harnessRegistry,
        accounts: providerAccounts,
        ...(accountBinding ? { accountBinding } : {}),
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
          const request = HarnessExecutionRequestSchema.parse({ ...context.workflowRequest,
            executionId: execution.id, runId: execution.runId,
            workspaceId: run.workspaceId, workflowNodeId: execution.workflowNodeId, workingDirectory: execution.workingDirectory,
            runtimeDirectory: execution.runtimeDirectory, configuration: context.configuration, input: execution.input })
          return execution.nativeSessionId ? { kind: 'workflow', correlationId: `execution:${execution.id}`, request }
            : { request, correlationId: `execution:${execution.id}` }
        },
      })
      claudeLaunches.set(claude.manager, claude)
      launchScopes.set(claude.manager, recovery)
      return claude.manager
    }
    if (selector) {
      if (!context.runId || !context.attempt) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The exact Run attempt is unavailable.', 409)
      const { manager } = productionSelectedProfileManager({ factories: nativeFactories, registry: harnessRegistry, profiles: selectedProfiles,
        ...(accountBinding ? { accountBinding } : {}),
        ...(context.nativeSessionId ? { nativeSessionId: context.nativeSessionId } : {}),
        selector, binding: { kind: 'workflow', runId: context.runId, executionId: context.executionId, attempt: context.attempt, getOwner,
          ...(context.purpose ? { purpose: context.purpose } : {}) },
        configuration, role: 'workflow', workingDirectory: context.workingDirectory, ownerAgentId: context.agentId,
        recovery, appMcpAccess: 'scoped', ...(nativeOutputs ? { nativeOutputs } : {}) })
      launchScopes.set(manager, recovery)
      return manager
    }
    const selection = harnessRegistry.initialized ? harnessRegistry.pinAccepted(context.configuration) : undefined
    const { manager } = nativeFactories.allocate({
      ...(accountBinding ? { accountBinding } : {}),
      ...(selection ? { selection } : {}),
      role: 'workflow', workingDirectory: context.workingDirectory, ownerAgentId: context.agentId,
      configured: { instanceId: selection?.instance.instanceId ?? context.agentId, instanceRevision: context.configuration.id, driverId: configuration.harness,
        enabled: true, configuration },
      processRecovery: recovery, appMcpAccess: 'scoped',
      harness: 'codex',
      ...(nativeOutputs ? { nativeOutputs } : {}),
    })
    launchScopes.set(manager, recovery)
    return manager
  })
  const validateContinuation = placedContinuationValidator(database.pool, locations, remoteWorkflow, {
    async assertCurrent(binding, signal) {
      signal?.throwIfAborted()
      const sql = interactionConnection.getStore() ?? database.pool
      if (!agentPlacement) {
        throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The current accepted placement authority is unavailable.', 503)
      }
      if (binding.placement.hostRef.kind === 'device') {
        const stored = (await sql.query<{ receipt: unknown }>(
          'select receipt from remote_execution_receipts where operation_id=$1',
          [binding.intent.operationId])).rows[0]
        const receipt = stored && RemoteOperationReceiptSchema.parse(stored.receipt)
        if (receipt?.native) {
          const authenticated = deviceRuntime.endpointForDomains().currentBinding(binding.placement.hostRef.deviceId)
          if (!authenticated) {
            throw new DomainError('REMOTE_DISPATCH_UNAVAILABLE', 'The authenticated execution connection is unavailable.', 503)
          }
          if (authenticated.bootId !== receipt.connection.bootId) {
            throw new DomainError('REMOTE_NATIVE_OWNER_CLOSED', 'The connected computer restarted during the run.', 409)
          }
          await assertRemoteExecutionAuthority(sql, locations, {
            version: 1, intent: binding.intent, placement: binding.placement, action: 'read',
          }, authenticated, agentPlacement)
          signal?.throwIfAborted()
          return
        }
      }
      const row = (await sql.query<{ principal_id: string; workspace_id: string }>("select record->>'authorizationPrincipalId' as principal_id,workspace_id from runs where id=$1", [binding.intent.runId])).rows[0]
      if (!row) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The current accepted placement authority is unavailable.', 503)
      const current = await credentialAuthority(sql as GraphSqlClient, binding.intent.executionId, 'workflow')
      await agentPlacement.assertPinsCurrent(sql, binding.placement,
        await readLiveManagementPrincipal(sql, row.principal_id), row.workspace_id,
        current.nativeSessionId ? { purpose: 'resident' } : undefined)
      signal?.throwIfAborted()
    },
  })
  const credentials = new WorkerCredentialService(database.pool, access)
  const prepareWorkflowManagerContext = async (context: NativeManagerResolutionContext) => {
    const prepared = await remoteWorkflow!.prepareContext(context)
    if (!context.runId) return prepared
    const row = (await database.pool.query<{ version: unknown; node_id: string }>(
      `select v.record as version,e.workflow_node_id as node_id from harness_executions e
       join runs r on r.id=e.run_id join workflow_versions v on v.id=r.workflow_version_id
       where e.id=$1 and r.id=$2`, [context.executionId, context.runId])).rows[0]
    if (!row) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The saved native execution is unavailable.', 409)
    const binding = await providerAccounts.runtimeBinding('run-node', context.purpose
      ? `${context.runId}:agent:${context.configuration.agentId}` : `${context.runId}:${row.node_id}`,
    context.configuration.harness, context.configuration.harnessProfileSelection)
    if (binding) workflowAccountBindings.set(context.executionId, binding)
    if (context.purpose) return prepared
    const node = WorkflowVersionV3Schema.parse(row.version).definition.nodes.find(item => item.id === row.node_id)
    return node && node.kind !== 'job' && node.artifactOutputs
      ? { ...prepared, artifactOutputs: node.artifactOutputs } : prepared
  }
  const launchCredentials: ExecutionCredentialProvider = {
    async restore(executionId, environment) {
      await validateContinuation(executionId)
      const credential = await credentials.restoreForExecution(executionId, environment)
      await appRoutes.refresh()
      return credential
    },
    async recoverRemote(executionId, applicationAccess, job) {
      const execution = await runs.getExecution(executionId)
      const binding = remoteWorkflow.binding(executionId)
      const retained = execution && await readRetainedRemoteReviewer(database.pool, execution)
      if (!execution || !binding || !retained || applicationAccess.executionId !== executionId
        || applicationAccess.operationId !== binding.intent.operationId || applicationAccess.attemptId !== binding.intent.attemptId
        || applicationAccess.bindingHash !== binding.intent.bindingHash || applicationAccess.agentId !== execution.agentId)
        throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The original process credential cannot be recovered.', 409)
      if (job) await credentials.bindReviewerJob(executionId, { principalId: retained.principalId }, job)
      const principal = await access.authenticate(applicationAccess.token, 'worker')
      if (principal.id !== retained.principalId || principal.agentId !== execution.agentId)
        throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The original process credential changed.', 409)
      return { principalId: principal.id, expiresAt: principal.expiresAt,
        environment: { agentId: execution.agentId, variables: { GRAPHQL_MCP_TOKEN: applicationAccess.token } } }
    },
    async bindReviewerJob(executionId, credential, job, lane) {
      await credentials.bindReviewerJob(executionId, credential, job, lane)
      await appRoutes.refresh()
    },
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
        || !run?.executionLocation) {
        throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Credential preflight requires the pinned execution identity.', 409)
      }
      const context = {
        executionId: execution.id, agentId: execution.agentId, harness: input.harness,
        workingDirectory: input.workingDirectory, configuration, runId: execution.runId, attempt: execution.attempt,
        ...(input.purpose ? { purpose: input.purpose } : {}),
      }
      const preparedContext = await prepareWorkflowManagerContext(context)
      const placement = preparedContext.acceptedPlacement
      if (!placement && run.executionLocation.runnerId !== locations.runnerId) {
        throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'An unplaced execution requires the local workspace runner.', 409)
      }
      let runnerId = run.executionLocation.runnerId
      if (placement?.hostRef.kind === 'main') runnerId = locations.runnerId
      if (placement?.hostRef.kind === 'device') runnerId = placement.registration!.workerInstallationId
      const { manager } = managers.resolve(preparedContext)
      const detection = remoteWorkflow.isRemote(input.executionId)
        ? remoteMcpPreflight(manager, preparedContext)
        : new McpDetectionService(nativeFactories.inspector(manager), appMcpEndpoint)
      if (input.harness === 'claude') {
        const claude = claudeLaunches.get(manager)
        if (!claude || configuration.harness.harness !== 'claude') throw new DomainError('CLAUDE_OWNER_UNAVAILABLE', 'The exact Claude launch is unavailable.', 409)
        const inspected = await nativeFactories.inspector(manager).inspect({ harness: 'claude', runnerId,
          workingDirectory: input.workingDirectory, serverName: PRODUCT_SLUG, phase: 'configuration', ...(input.signal ? { signal: input.signal } : {}) })
        assertClaudeCredentialEndpoint(inspected.entry, appMcpEndpoint)
        await credentials.revokeSupersededForExecution(input.executionId)
        input.signal?.throwIfAborted()
        const credential = await (input.purpose === 'reviewer' ? credentials.issueForReviewer(input.executionId) : credentials.issueForExecution(input.executionId))
        try {
          const token = readProductEnvironment(credential.environment.variables, 'MCP_TOKEN')
          const serverName = appMcpServerName(configuration.harness.mcpServers)
          const configured = configuration.harness.mcpServers[serverName]
          if (!token || configured?.type !== 'http' || configured.url !== appMcpEndpoint) throw new DomainError('APP_MCP_PREFLIGHT_FAILED', 'The accepted Claude settings cannot receive this scoped HTTP credential.', 409)
          const start = { ...await claude.inspectionStart(), environment: credential.environment }
          await claude.manager.refreshInspectionCredentials(start, { ...configuration.harness.mcpServers,
            [serverName]: { ...configured, headers: { Authorization: `Bearer ${token}` } } }, input.signal)
          const checked = await detection.preflight({ harness: 'claude', runnerId,
            workingDirectory: input.workingDirectory, ...(input.signal ? { signal: input.signal } : {}) })
          if (checked.detection.state !== 'connected' || checked.detection.credentialArrangement?.kind !== 'scoped_http_header') {
            componentLogger('harness').warn({ executionId: input.executionId, state: checked.detection.state,
              arrangement: checked.detection.credentialArrangement?.kind ?? null }, 'Claude scoped MCP credential preflight rejected')
            throw new DomainError('APP_MCP_PREFLIGHT_FAILED', 'Claude did not acknowledge the scoped HTTP credential on its current query.', 409)
          }
          await appRoutes.refresh()
          return { credential, detection: checked }
        } catch (error) {
          componentLogger('harness').warn({ executionId: input.executionId, code: error instanceof DomainError ? error.code
            : error instanceof Error ? error.constructor.name : typeof error }, 'Claude workflow credential preflight failed')
          await credentials.revoke(credential); throw error
        }
      }
      const launch = new WorkerLaunchCredentialService(detection, credentials, runnerId)
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
    new PostgresWorkflowClosureStore(database.pool, executionId =>
      processRegistry instanceof NativeProcessRegistry
        && hasNativeRestartDetachment(processRegistry.scope(`execution:${executionId}`))),
    new PostgresRepeatReviewerBindings(database.pool),
    { capture(input) {
      const evidence = workflowCapture.capture.capture(input)
      remoteWorkflow!.capture(input, workflowCapture.verify.read(evidence))
      return evidence
    } }, { capture(input) {
      const evidence = reviewCapture.capture.capture(input)
      remoteWorkflow.captureReview(reviewCapture.verify.read(evidence))
      return evidence
    } },
    async (executionId, signal, owner) => {
      signal.throwIfAborted()
      const placement = await readExecutionPlacement(database.pool, executionId)
      const closed = placement?.hostRef.kind === 'device'
        ? await remoteWorkflow.confirmClosedExecution(executionId, signal, owner)
          || await remoteWorkflowPreparationClosed(database.pool, executionId)
        : await processRegistry.closeOwner(`execution:${executionId}`, signal)
      signal.throwIfAborted()
      return closed
    },
    (executionId, manager) => {
      if (remoteWorkflow!.isRemote(executionId)) return
      const scope = launchScopes.get(manager)
      if (!scope || scope.owner !== `execution:${executionId}` || scope.launchId) throw new DomainError(
        'NATIVE_LAUNCH_RESERVATION_CONFLICT', 'The exact manager launch scope is unavailable or already reserved.', 409)
      if (hasDetachedStdioProcess(scope)) return
      Object.assign(scope, processRegistry.reserveLaunch(scope.owner))
    },
    prepareWorkflowManagerContext,
    executionId => remoteWorkflow.afterReviewCommit(executionId),
  )
  let telemetry: ResourceTelemetryRuntime | undefined
  const telemetryLifetime = new AbortController()
  let mainTelemetryContext: Extract<TrustedTelemetryContext, { kind: 'main-local' }> | null = null
  let jobRuntime: Awaited<ReturnType<typeof createProductionJobs>> | undefined
  let hostCi: HostCiService | undefined
  const engine = new LangGraphWorkflowEngine(
    runs, workflows, approvals, checkpoints.saver, config.harnesses.workspaceRoot,
    locations, launchCredentials, repository, async runId => {
      await hostCi?.cancelStoppedRun(runId)
    }, {}, (owner, version) => {
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
  const operatorConversations = new PostgresOperatorConversationRepository(database.pool, accountConfigurations)
  const agentConversations = new PostgresAgentChatRepository(database.pool, providerAccounts.acceptedBindings)
  const workerChats = createProductionWorkerConversations({ pool: database.pool,
    endpoint: () => deviceRuntime.endpointForDomains(), profiles: selectedProfiles, claudeProfiles,
    operators: operatorConversations, agents: agentConversations, registry: harnessRegistry,
    qualifications: qualificationRepository, access, mcpForward: () => selectedMainMcpForward(app),
    fileService: () => productionFileTools(app),
    files: (conversationId, configuration, workingDirectory) => async ({ host, assertHost, ...turn }) => {
      const admissions = 'operatorId' in configuration
        ? operatorCodexFileAdmissions(() => app, database.pool, configuration, workingDirectory, fileStorageRoot,
          { host, assertCurrent: assertHost })
        : postgresCodexChatFiles(database.pool, () => {
          if (!fileStorage) throw new Error('Production file storage is not registered.')
          return fileStorage
        }, async () => host, { assertCurrent: assertHost })
      return productionCodexChatFiles(() => app, conversationId, admissions).prepare(turn)
    },
    suiteRevisions: selectedSuites ? {
      codex: selectedSuites.codex.revision,
    } : {} })
  const agentChatProfileSelection = async (
    configuration: import('@foreman-code/contracts').AgentConfigurationVersion,
    workingDirectory: string, executionId?: string,
  ) => {
    if (!executionId) return { profileSelection: configuration.harnessProfileSelection, sourceExecution: undefined }
    const source = await runs.getExecution(executionId)
    if (!source || source.agentId !== configuration.agentId
      || source.agentConfigurationVersionId !== configuration.id || source.workingDirectory !== workingDirectory) {
      throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The chat source execution changed.', 409)
    }
    const placement = await readExecutionPlacement(database.pool, executionId)
    if (!placement) {
      if (await readAcceptedPlacement(database.pool, source.runId, source.workflowNodeId)) {
        throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The chat source placement is unavailable.', 409)
      }
      return { profileSelection: configuration.harnessProfileSelection, sourceExecution: undefined }
    }
    const native = await readNativePlacement(database.pool, executionId)
    if (!native) {
      throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The chat source working tree is unavailable.', 409)
    }
    const harness = configuration.harness.harness
    if (harness === 'opencode') throw new DomainError('HARNESS_RETIRED', 'OpenCode is retired; this chat source cannot continue.', 409)
    const profileSelection = workflowProfileSelection({ executionId, runId: source.runId, agentId: source.agentId,
      harness, configuration, workingDirectory, acceptedPlacement: placement },
    native?.workingTree.canonicalCwd)
    return { profileSelection, sourceExecution: { executionId, placement, workingTree: native.workingTree } }
  }
  const recoverChatCompaction = async (
      configuration: import('@foreman-code/contracts').OperatorConfigurationVersion | import('@foreman-code/contracts').AgentConfigurationVersion,
      conversationId: string, session: import('@foreman-code/contracts').NativeSessionReference,
      start: import('./modules/harnesses/port.js').NativeSessionStart, state: import('@foreman-code/contracts').CompactionState,
      principalId: string, signal: AbortSignal,
      profileSelection = configuration.harnessProfileSelection,
      sourceExecution?: import('@foreman-code/contracts/remote-execution-rpc').WorkerConversationBinding['sourceExecution'],
    ) => {
      if (session.harness === 'opencode' || configuration.harness.harness === 'opencode') {
        throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
      }
      if (profileSelection?.target.hostRef.kind === 'device') {
        const manager = workerChats.create({ configuration, conversationId, workingDirectory: sessionStartDirectory(start),
          appMcpAccess: 'none', observationPrincipalId: principalId, profileSelection, sourceExecution })
        try { return await manager.readCompaction!(session, start, state, signal) }
        finally { await manager.dispose?.() }
      }
      if (session.harness === 'claude') return recoverPersistedClaudeCompaction(state)
      const binding: ClaudeProfileOwner = 'operatorId' in configuration
        ? { kind: 'operator', conversationId, repository: operatorConversations, observationPrincipalId: principalId }
        : { kind: 'agent', conversationId, workspaceId: configuration.workspaceId,
          repository: agentConversations, observationPrincipalId: principalId }
      const accepted = profileSelection
        ? await selectedProfiles.admit({ ...binding, admissionSignal: signal }, profileSelection) : undefined
      const selection = accepted ? harnessRegistry.pinOverride(accepted.override)
        : harnessRegistry.pinAccepted({ id: configuration.id,
          agentId: 'operatorId' in configuration ? configuration.operatorId : configuration.agentId,
          harness: configuration.harness })
      const common = { selection, configured: selection.instance, role: 'diagnostics' as const,
        accountRecovery: processRegistry.scope('operatorId' in configuration
          ? `conversation:${conversationId}` : `conversation:agent-chat:${conversationId}`),
        workingDirectory: sessionStartDirectory(start),
        ownerAgentId: 'operatorId' in configuration ? configuration.operatorId : configuration.agentId,
        appMcpAccess: 'none' as const,
        ...(accepted ? { revalidateSelection: (effectSignal?: AbortSignal) => selectedProfiles.revalidate(
          { ...binding, admissionSignal: effectSignal ?? signal }, accepted) } : {}) }
      const { manager } = nativeFactories.allocate({ ...common, harness: session.harness })
      try {
        nativeFactories.admitAuxiliary(manager)
        return await manager.readCompaction!(session, start, state, signal)
      } finally { await nativeFactories.disposeAuxiliary(manager) }
    }
  const operatorAccountBindings = new Map<string, AcceptedProviderAccountBinding>()
  const resolveOperatorManager = productionOperatorManagers({
    app: () => app, pool: database.pool, config, workingDirectory: operatorWorkingDirectory,
    processRegistry, responseJournal, managers: operatorManagers, nativeFactories,
    accountBinding: conversationId => operatorAccountBindings.get(conversationId),
    createDevice: (configuration, conversationId, fileInputs) => workerChats!.create({
      configuration, conversationId, workingDirectory: operatorWorkingDirectory, appMcpAccess: fileInputs ? 'none' : 'scoped' }),
    createSelected: (configuration, conversationId, fileInputs, recovery) => {
      if (configuration.harness.harness === 'opencode') {
        throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
      }
      if (!configuration.harnessProfileSelection || configuration.harness.harness === 'claude') throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The selected Operator driver profile is unavailable.', 409)
      return productionSelectedProfileManager({ factories: nativeFactories, registry: harnessRegistry, profiles: selectedProfiles,
        ...(operatorAccountBindings.get(conversationId)
          ? { accountBinding: operatorAccountBindings.get(conversationId)! } : {}),
        selector: configuration.harnessProfileSelection, binding: { kind: 'operator', conversationId, repository: operatorConversations },
        configuration: configuration.harness, role: 'operator', workingDirectory: operatorWorkingDirectory, ownerAgentId: configuration.operatorId,
        recovery, appMcpAccess: 'scoped',
        ...(fileInputs ? { files: productionCodexChatFiles(() => app, conversationId, operatorCodexFileAdmissions(() => app, database.pool,
          configuration, operatorWorkingDirectory, fileStorageRoot)) } : {}),
      }).manager
    },
    createClaude: (configuration, conversationId, fileInputs, recovery) => {
      if (configuration.harness.harness !== 'claude') throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'Claude requires the pinned Claude configuration.', 409)
      const controlBinding: Extract<import('./modules/harnesses/claudeSdk/domainAuthority.js').ClaudeDomainBinding, { kind: 'operator' }>
        = { kind: 'operator', conversationId, repository: operatorConversations }
      const claude = productionClaudeManager({ pool: database.pool, factories: nativeFactories, registry: harnessRegistry,
        accounts: providerAccounts,
        ...(operatorAccountBindings.get(conversationId)
          ? { accountBinding: operatorAccountBindings.get(conversationId)! } : {}),
        profiles: claudeProfiles,
        ...(configuration.harnessProfileSelection ? { selector: configuration.harnessProfileSelection } : {}),
        binding: controlBinding, role: 'operator',
        configuration: configuration.harness, workingDirectory: operatorWorkingDirectory, ownerAgentId: configuration.operatorId,
        recovery, appMcpAccess: fileInputs ? 'none' : 'scoped', mode: infrastructure?.mode ?? 'native',
        ...(fileInputs ? { files: { service: () => productionFileTools(app), ...(infrastructure?.claudeFileSdk ? { sdk: infrastructure.claudeFileSdk } : {}) } } : {}),
        ...(infrastructure?.claudeClient ? { loadClient: infrastructure.claudeClient } : {}),
        inspectionStart: async () => {
          const row = await operatorConversations.active(conversationId)
          if (!row || !row.active_request_id && !controlBinding.controlPrincipalId
            || row.operator_configuration_version_id !== configuration.id) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE', 'The accepted Operator turn is unavailable.', 409)
          return { kind: 'operator', correlationId: nativeCorrelation(conversationId, row.active_request_id ?? 'session-control'), configuration,
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
    (manager) => workerChats!.inspector(manager) ?? nativeFactories.inspector(manager),
    async (manager, configuration, environment, signal) => {
      const claude = claudeLaunches.get(manager)
      const servers: ClaudeHarnessConfiguration['mcpServers'] = configuration.harness.harness === 'claude'
        ? configuration.harness.mcpServers : {}
      const serverName = appMcpServerName(servers)
      const configured = servers[serverName]
      const token = readProductEnvironment(environment.variables, 'MCP_TOKEN')
      const worker = workerChats!.deliverClaudeCredential(manager)
      if ((!claude && !worker) || !configured || configured.type !== 'http' || configured.url !== appMcpEndpoint || !token) throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'The accepted Claude HTTP credential arrangement is unavailable.', 409)
      if (worker) await worker(token, signal)
      else if (claude) await claude.manager.refreshInspectionCredentials({ ...await claude.inspectionStart(), environment }, {
          ...(configuration.harness.harness === 'claude' ? configuration.harness.mcpServers : {}),
          [serverName]: { ...configured, headers: { Authorization: `Bearer ${token}` } },
        }, signal)
      const context = manager.mcpInspectionContext ? await manager.mcpInspectionContext(signal)
        : { runnerId: 'runner-local', workingDirectory: operatorWorkingDirectory }
      const checked = await new McpDetectionService(workerChats!.inspector(manager) ?? nativeFactories.inspector(manager), appMcpEndpoint).preflight({
        harness: 'claude', ...context, signal,
      })
      if (checked.detection.state !== 'connected' || checked.detection.credentialArrangement?.kind !== 'scoped_http_header') throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'Claude did not acknowledge the scoped Operator credential on its current query.', 409)
    },
    async (principal, configuration, signal) => {
      if (configuration.harness.harness !== 'claude' || !configuration.harnessProfileSelection) throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Claude setup requires its exact saved host profile.', 409)
      const owner: ClaudeProfileOwner = { kind: 'operator-inspection', principalId: principal.id,
        configurationVersionId: configuration.id, configurationHash: configuration.contentHash, admissionSignal: signal }
      const accepted = await claudeProfiles.admit(owner, configuration.harnessProfileSelection)
      if (accepted.override.target.hostRef.kind === 'device') {
        return inspectWorkerClaudeOperatorConfiguration({ accepted, endpoint: deviceRuntime.endpointForDomains(),
          expectedEndpoint: appMcpEndpoint, signal,
          revalidate: async () => { await claudeProfiles.revalidate(owner, accepted) } })
      }
      const apiKey = await requireClaudeProductionCredentialDelivery(configuration.harness, providerAccounts,
        accepted.override.target.hostRef)
      const binding = harnessRegistry.pinOverride(accepted.override), binary = binding.installation.launcher.resolvedLauncher
      if (!binary) throw new DomainError('HARNESS_HOST_MISMATCH', 'Claude setup must inspect its actual local installed profile.', 409)
      const recovery = processRegistry.reserveLaunch(`operator-configuration-inspection:${randomUUID()}`)
      const close = async () => {
        await processRegistry.abandonReservedLaunch(recovery)
        if (!await processRegistry.closeOwner(recovery.owner)) throw new Error('Claude read-only configuration inspection closure is unconfirmed.')
      }
      try { return await inspectClaudeOperatorConfiguration({ accepted, binary, workingDirectory: operatorWorkingDirectory,
        ...(apiKey ? { apiKey } : {}),
        endpoint: appMcpEndpoint, recovery, signal, ...(infrastructure?.claudeClient ? {
          loadClient: (profilePath, processRecovery, selectedBinary) => infrastructure.claudeClient!({ profilePath, recovery: processRecovery, binary: selectedBinary }),
        } : {}),
        revalidate: async () => { await claudeProfiles.revalidate(owner, accepted); await nativeFactories.assertInstallationUnchanged(binding, signal) } }) }
      finally { await close() }
    },
  )
  resolveOperatorManager.prepareAccountBinding = async (configuration, conversationId) => {
    const binding = await providerAccounts.runtimeBinding('operator-command', `${conversationId}:session`,
      configuration.harness, configuration.harnessProfileSelection)
    if (binding) operatorAccountBindings.set(conversationId, binding)
    else operatorAccountBindings.delete(conversationId)
  }
  resolveOperatorManager.recoverCompaction = recoverChatCompaction
  const chat = new OperatorChatService(
    operatorConversations, operators,
    resolveOperatorManager, operatorWorkingDirectory, chatAuthority,
    async (principal, configuration, commandId) => {
      const selection = await withTransaction(database.pool,
        client => harnessInstances.selectionForConfiguration(principal, configuration, client))
      return selection ?? harnessInstances.prepareOperatorConfiguration(principal, 'http', configuration, commandId)
    },
  )
  const agentChatManagers = new Map<string, NativeHarnessSessionManager>()
  const resolveAgentChatManager: AgentChatManagerFactory = async (conversationId, configuration, workingDirectory, accountSource) => {
    if (configuration.harness.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    const existing = agentChatManagers.get(conversationId)
    if (existing) return existing
    const accountBinding = await providerAccounts.runtimeBinding('agent-conversation', conversationId,
      configuration.harness, configuration.harnessProfileSelection)
    const selected = await agentChatProfileSelection(configuration, workingDirectory, accountSource?.executionId)
    const selector = selected.profileSelection
    const resolved = agentChatManagers.get(conversationId)
    if (resolved) return resolved
    if (selector?.target.hostRef.kind === 'device') {
      const manager = workerChats!.create({ configuration, conversationId, workingDirectory, appMcpAccess: 'none',
        profileSelection: selector, sourceExecution: selected.sourceExecution })
      agentChatManagers.set(conversationId, manager)
      return manager
    }
    // Chat processes have their own owner scope; they never share a workflow execution's manager.
    const recovery = processRegistry.scope(`conversation:agent-chat:${conversationId}`)
    const sourceRecovery = accountSource
      ? { accountSourceRecovery: processRegistry.scope(`execution:${accountSource.executionId}`) } : {}
    const harness = configuration.harness
    if (harness.harness === 'claude') {
      const { manager } = productionClaudeManager({ pool: database.pool, factories: nativeFactories, registry: harnessRegistry,
        ...sourceRecovery,
        ...(accountBinding?.kind === 'slot' ? { accountBinding } : {}),
        accounts: providerAccounts,
        profiles: claudeProfiles,
        ...(selector ? { selector } : {}),
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
    if (selector) {
      const { manager } = productionSelectedProfileManager({ factories: nativeFactories, registry: harnessRegistry, profiles: selectedProfiles,
        ...sourceRecovery,
        ...(accountBinding?.kind === 'slot' ? { accountBinding } : {}),
        selector,
        binding: { kind: 'agent', conversationId, workspaceId: configuration.workspaceId, repository: agentConversations },
        configuration: harness, role: 'agent-chat', workingDirectory, ownerAgentId: configuration.agentId, recovery, appMcpAccess: 'none',
        files: productionCodexChatFiles(() => app, conversationId, chatFileAdmissions) })
      agentChatManagers.set(conversationId, manager)
      return manager
    }
    const selection = harnessRegistry.initialized ? harnessRegistry.pinAccepted(configuration) : undefined
    const { manager } = nativeFactories.allocate({
      ...sourceRecovery,
      ...(accountBinding?.kind === 'slot' ? { accountBinding } : {}),
      ...(selection ? { selection } : {}),
      role: 'agent-chat', workingDirectory, ownerAgentId: configuration.agentId,
      configured: { instanceId: selection?.instance.instanceId ?? configuration.agentId, instanceRevision: configuration.id, driverId: harness.harness,
        enabled: true, configuration: harness },
      processRecovery: recovery, appMcpAccess: 'none',
      harness: 'codex',
      chatFiles: productionCodexChatFiles(() => app, conversationId, chatFileAdmissions),
    })
    agentChatManagers.set(conversationId, manager)
    return manager
  }
  resolveAgentChatManager.recoverCompaction = async (configuration, conversationId, session, start, state, principalId, signal) => {
    const row = await agentConversations.get(conversationId)
    if (!row || row.agent_configuration_version_id !== configuration.id) {
      throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The chat configuration changed.', 409)
    }
    const executionId = row.record.origin.kind === 'run_execution' ? row.record.origin.executionId : undefined
    const selected = await agentChatProfileSelection(configuration, sessionStartDirectory(start), executionId)
    return recoverChatCompaction(configuration, conversationId, session, start, state, principalId, signal,
      selected.profileSelection, selected.sourceExecution)
  }
  resolveAgentChatManager.unavailable = async (configuration, workingDirectory, executionId) => {
    const { profileSelection } = await agentChatProfileSelection(configuration, workingDirectory, executionId)
    if (!profileSelection) return undefined
    if (hostProfileChecks.pending(profileSelection.target.hostRef)) {
      return { reason: 'harness_unavailable', message: 'This computer is checking its harness profile. Retry shortly.' }
    }
    const profile = await hostSettings.readAuthorized(client => hostSettings.latest(client, profileSelection.instanceId))
    if (!profile || !profile.enabled || profile.instanceRevision !== profileSelection.instanceRevision
      || !await harnessRegistry.profileEvidence(profile)) {
      return { reason: 'harness_unavailable', message: 'The harness profile used by this Run is unavailable.' }
    }
    return undefined
  }
  resolveAgentChatManager.release = (conversationId) => { agentChatManagers.delete(conversationId) }
  const agentChat = new AgentChatService(database.pool, agentConversations,
    new PostgresOperatorConversationRepository(database.pool, accountConfigurations), workflows, runs, resolveAgentChatManager, config.harnesses.workspaceRoot)
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
    reportDispatchFailure: (runId, code, error) => app.log.error({ runId, code, err: error }, 'current workflow dispatch remains unresolved'),
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
    startPublication: { ...binding.startPublication, workerExecution, accountBindings: providerAccounts.acceptedBindings,
      ...(selectedSuites ? { placementAdmission: {
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
    bugReports,
    providerAccounts,
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
    workflows: new WorkflowManagementService(database.pool, commands, {
      agentActiveTimeoutMs: config.harnesses.timeoutMs,
      accountConfigurations,
      worktrees: {
        readyRoot: (principal, workspaceId, sql) => {
          if (!runtimeServices.workspaceRepositories) return Promise.resolve(undefined)
          return runtimeServices.workspaceRepositories.readyRoot(principal, workspaceId, sql)
        },
        sources: {
          resolveRootBinding: (...args) => {
            if (!jobRuntime) throw new DomainError('SOURCE_UNAVAILABLE', 'Source services are not initialized.', 503)
            return jobRuntime.sources.resolveRootBinding(...args)
          },
          resolveApprovedSource: (...args) => {
            if (!jobRuntime) throw new DomainError('SOURCE_UNAVAILABLE', 'Source services are not initialized.', 503)
            return jobRuntime.sources.resolveApprovedSource(...args)
          },
        },
        roots: {
          resolve: (...args) => {
            if (!jobRuntime) throw new DomainError('SOURCE_UNAVAILABLE', 'Root services are not initialized.', 503)
            return jobRuntime.policies.resolve(...args)
          },
        },
      },
    }),
    agents: new AgentManagementService(database.pool),
    harnesses: harnessCatalog,
    harnessCompatibility,
    ...(harnessQualifications ? { harnessQualifications } : {}),
    remoteExecution,
    settings: new FoundationSettingsManagementService(foundationSettings, commands, harnessCatalog, operators, harnessInstances, accountConfigurations),
    workerExecution,
    runs: new RunManagementService(database.pool, commands, runs, engine, locations, currentProduction, async (executionId, session, cursor, signal) => {
      const owned = managers.residentForRead(executionId)
      if (!owned?.manager.subagentHistory || owned.context.harness !== session.harness) throw new DomainError('SUBAGENT_HISTORY_UNAVAILABLE', 'The original admitted parent history owner is unavailable.', 409)
      owned.assertCurrent()
      const page = await owned.manager.subagentHistory(session, cursor, signal)
      owned.assertCurrent()
      return page
    }, productionSubagentControls(managers)),
    commands,
    interactions: new OperatorInteractionService(interactions),
    // Reads and lifecycle mutations share the same canonical V3 journal.
    runGraph: new RunGraphReadService(database.pool, { qualifiedReads: true }),
    runPlacements: new RunPlacementReadService(database.pool, readRemoteObservations),
    placementChoices: new NodePlacementChoicesService(database.pool, new ProductionPlacementChoiceDiscovery(
      database.pool, () => {
        if (!jobRuntime) throw new DomainError('PLACEMENT_CHOICES_UNAVAILABLE', 'Computer choices are not initialized.', 503)
        return { roots: jobRuntime.policies, sources: jobRuntime.sources, profiles: hostSettings, registry: harnessRegistry }
      },
    )),
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
    detection, locations, workflows: operatorServices.workflows.current,
    provisioningRoot: projectRoot, harnessProfiles: harnessInstances,
    accountConfigurations,
  })
  const runtimeServices: OperatorServices & { jobs?: import('./modules/jobs/service.js').JobService;
    buildComputers?: import('./modules/settings/buildComputers.js').BuildComputerSettings
    jobRuntimeProfiles?: import('./modules/jobs/runtimeProfiles.js').JobRuntimeProfiles } = { ...operatorServices, extensions: operatorExtensions, harnessSettings }
  const localHuman = new PostgresLocalHumanAccess(database.pool, access)
  interactions.useWorkDirectionActions({
    start: (principal, source, input) => operatorServices.runs.start(principal, source, input),
    wake: () => engine.reconcile(),
  })
  const app = buildApp({
    ...(infrastructure?.closeInfrastructure ? { closeInfrastructure: infrastructure.closeInfrastructure } : {}),
    runtimeIdentity: async () => {
      const identity = await readRuntimeIdentity(database.pool,
        fileURLToPath(new URL('../../../', import.meta.url)), config.database.connectionString)
      const testResourcesId = readTestResourcesIdentity(config)
      return { ...identity, ...(testResourcesId ? { testResourcesId } : {}) }
    },
    localHuman,
    ...(config.browserOrigin ? { browserOrigin: config.browserOrigin } : {}),
    readiness: { database, checkpoints },
    readinessTimeoutMs: config.readinessTimeoutMs,
    product: { workspaces, workflows, runs, engine, interactions, chat },
    operator: { access, services: runtimeServices },
    appMcp: { access, commands, bugReports, interactions: Object.assign(new PostgresAppInteractionService(database.pool, repository, commands, interactions), {
      syncedFolder: (workspaceId: string, hostRef: { kind: 'main' } | { kind: 'device'; deviceId: string }) =>
        runtimeServices.computerSync?.sharedFolder(workspaceId, hostRef) ?? Promise.resolve(null) }) },
    workerArtifacts: () => workflowArtifacts?.extension,
    mcpDetection: { pool: database.pool, service: detection },
    logger,
  })
  app.addHook('onClose', () => providerAccounts.close())
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
  const startupLifetime = new AbortController()
  let schemaPreparation: Promise<void> | undefined
  let initialization: Promise<void> | undefined
  let nativeDefaultsInitialization: Promise<void> | undefined
  let reconciliation: Promise<void> | undefined
  let applicationClose: Promise<void> | undefined
  let stopComputerTimers = () => {}
  let stopSyncTimer = () => {}
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
      { name: 'shared file sync admission', run: () => {
        stopSyncTimer()
        runtimeServices.computerSync?.stopAdmission()
      } },
      { name: 'computer maintenance admission', run: () => {
        stopComputerTimers()
        runtimeServices.computerMaintenance?.stopAdmission()
      } },
      { name: 'passive resource telemetry admission', run: async () => { telemetryLifetime.abort() } },
      { name: 'device admission', run: () => deviceRuntime.stopAdmission() },
      { name: 'original rsync byte ownership', run: () => rsync.kind === 'configured' ? rsync.rsyncWriters.close() : undefined },
      { name: 'canonical harness inventory and profile checks', run: async () => {
        const inventoryClose = installationMonitor.close()
        harnessRegistry.stop()
        await Promise.all([inventoryClose, harnessInstances.closeChecks()])
      } },
      { name: 'diagnostic and configuration qualification admission', run: async () => { nativeFactories.stopAuxiliaries() } },
      { name: 'live harness qualification admission', run: async () => { harnessQualifications?.stop() } },
      { name: 'harness compatibility diagnostics', run: () => harnessCompatibility.close() },
      { name: 'native MCP settings', run: () => harnessSettings.mcp.shutdown() },
      { name: 'Codex plugin settings', run: () => harnessSettings.plugins.shutdown() },
      { name: 'harness qualification checks', run: () => Promise.all([harnessCatalog.shutdownChecks(), nativeConfigurations.shutdownChecks()]).then(() => undefined) },
      { name: 'Operator chat', run: () => chat.shutdown() },
      { name: 'Agent chat', run: () => agentChat.shutdown() },
      { name: 'automatic reviews', run: () => reviews.shutdown() },
      { name: 'workflow engine', run: () => engine.shutdown() },
    ],
    drain: [
      { name: 'startup schema preparation', run: () => schemaPreparation?.then(() => undefined, () => undefined) },
      { name: 'shared file sync work', run: () => runtimeServices.computerSync?.join() },
      { name: 'live harness qualification', run: () => harnessQualifications?.join() },
      // Initialization errors belong to initialize()'s caller, not to cleanup.
      // Wait for its last DB/filesystem operation even if startup was canceled.
      { name: 'initialization', run: () => initialization?.then(() => undefined, () => undefined) },
      { name: 'native defaults initialization', run: () => nativeDefaultsInitialization?.then(() => undefined, () => undefined) },
      { name: 'reconciliation', run: () => reconciliation },
    ],
    dispose: [
      { name: 'computer maintenance tasks', run: () => runtimeServices.computerMaintenance?.drain() },
      { name: 'worker conversation callback admissions', run: async () => { await workerChats?.close() } },
      { name: 'installed rsync canonical receiver', run: () => entrypoint ? entrypoint.close() : undefined },
      { name: 'workflow artifact byte receiver', run: async () => { await workflowArtifacts?.receiver.close() } },
      { name: 'passive resource telemetry collector', run: async () => { await telemetry?.close() } },
      { name: 'diagnostic and configuration qualification native managers', run: () => nativeFactories.disposeAuxiliaries() },
      { name: 'Job dispatch owners', run: async () => { await jobRuntime?.close() } },
      { name: 'Foreman Code MCP routes', run: () => appRoutes.close() },
      { name: 'execution native managers', run: async () => {
        // Preserve the manager and authenticated channels until every restart detach commits, including retries.
        try {
          await approvals.closeForRestart()
          await managers.dispose()
          await deviceRuntime.drain()
        } catch (error) {
          throw new AggregateError([error], 'Execution native manager disposal was incomplete.', { cause: error })
        }
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
    startupLifetime.abort()
    lifecycle.begin()
  }
  const assertOpen = (): void => {
    if (closing) throw new DomainError('NATIVE_RUNTIME_CLOSING', 'The native runtime is shutting down.', 503)
  }
  const startupDatabase = <T>(work: () => Promise<T>): Promise<T> =>
    retryStartupDatabase(work, { signal: startupLifetime.signal, check: assertOpen })
  const synchronizeOperatorDefaults = async (
    template: AgentDefaults['operator'],
  ): Promise<void> => {
    await withTransaction(database.pool, async client => {
      const current = await operators.ensureWithClient(client)
      if (isDeepStrictEqual(current.configuration.harness, template.harness)
        && isDeepStrictEqual(current.configuration.nativeTools, template.nativeTools)) return
      await operators.updateWithClient(
        client, template.harness, current.operator.currentConfigurationVersionId,
        template.showThinking ?? false, template.assignedSkills, template.harnessProfileSelection ?? null,
        template.nativeTools ?? null,
      )
    })
  }
  const prepareSchema = (): Promise<void> => {
    if (closing) return Promise.reject(new DomainError('NATIVE_RUNTIME_CLOSING', 'The native runtime is shutting down.', 503))
    schemaPreparation ??= Promise.resolve().then(async () => {
      await runtimeOwner.acquire()
      assertOpen()
      await startupDatabase(() => database.migrate())
      assertOpen()
      await startupDatabase(() => checkpoints.setup())
      assertOpen()
    })
    return schemaPreparation
  }
  const initialize = (): Promise<void> => {
    if (closing) return Promise.reject(new DomainError('NATIVE_RUNTIME_CLOSING', 'The native runtime is shutting down.', 503))
    if (initialized) return Promise.resolve()
    // Coalesce startup and publish its lifetime before starting any async work.
    initialization ??= Promise.resolve().then(async () => {
      assertOpen()
      await runtimeOwner.acquire()
      assertOpen()
      await startupDatabase(() => remoteExecution.initialize())
      assertOpen()
      if (infrastructure?.mode !== 'replay') await mainCodex.initialize()
      assertOpen()
      const canonicalDirectory = await ensureOperatorRuntimeDirectory(config.harnesses.workspaceRoot)
      assertOpen()
      if (canonicalDirectory !== operatorWorkingDirectory) {
        throw new DomainError('OPERATOR_RUNTIME_DIRECTORY_INVALID', 'The canonical Operator directory differs from the configured managed path.', 422)
      }
      const operator = await startupDatabase(() => operators.ensure())
      assertOpen()
      const defaults = await startupDatabase(() => foundationSettings.getAgentDefaults())
      assertOpen()
      if (!isDeepStrictEqual(operator.configuration.harness, defaults.value.operator.harness)
        || !isDeepStrictEqual(operator.configuration.nativeTools, defaults.value.operator.nativeTools)) {
        await startupDatabase(() => synchronizeOperatorDefaults(defaults.value.operator))
        assertOpen()
      }
      await startupDatabase(() => chatAuthority.revokeOrphanedCredentials())
      await startupDatabase(() => appRoutes.refresh())
      assertOpen()
      await startupDatabase(() => harnessSettings.mcp.recover())
      assertOpen()
      await startupDatabase(() => operatorServices.runs.recoverSubagentCommands())
      assertOpen()
      await startupDatabase(() => harnessSettings.plugins.recover())
      assertOpen()
      const machine = await deviceRuntime.initializeFromRuntime(() => startupDatabase(() => readRuntimeIdentity(database.pool,
        fileURLToPath(new URL('../../../', import.meta.url)), config.database.connectionString)))
      providerAccounts.bindTarget(async () => ({ hostRef: { kind: 'main', mainId: machine.installationId },
        applicationInstallationId: machine.installationId, keyRevision: null, authorizationRevision: null }))
      assertOpen()
      const connectionAuthority = new PostgresTrustedConnectionHumanAuthority(
        database.pool, machine.installationId,
      )
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
          return withTransaction(database.pool, async (sql) => {
            const proof = await readSourceCurrentNativeSession(sql, record, captures)
            return proof
          })
        }
        let proof = await readCurrent()
        if (!proof) return null
        const capture = captures.find(value => value.execution.id === record.receipt.executionId)!
        return { get proof() { return proof! }, signal: capture.signal, async assertCurrent() {
          capture.signal.throwIfAborted(); capture.assertCurrent()
          const current = await readCurrent()
          if (!sourceNativeSessionContinues(proof, current)) throw new DomainError('SOURCE_NATIVE_SESSION_CONFLICT', 'The original entered native owner or source lane is no longer current.', 409)
          proof = current
          capture.signal.throwIfAborted(); capture.assertCurrent()
        } }
      }
      jobRuntime = await createProductionJobs({ pool: database.pool, commands, locations, mainId: machine.installationId,
        availableMemory: async profile => {
          const fingerprint = profile.measurement?.fingerprint
          if (!telemetry || !fingerprint) return null
          const registration = profile.root.registration
          return telemetry.service.availableComputerMemory({ hostRef: profile.root.selection.hostRef,
            applicationInstallationId: registration?.workerInstallationId ?? fingerprint.mainInstallationId,
            bootId: fingerprint.bootId, keyRevision: registration?.keyRevision ?? null,
            authorizationRevision: registration?.authorizationRevision ?? null }, AbortSignal.timeout(5000))
        },
        workerExecution,
        runtimeRoot: config.harnesses.workspaceRoot, storageRoot: fileStorageRoot, endpoint: () => deviceRuntime.endpointForDomains(),
        activeNativeSession, captureNativeSession,
        ...(installedRsync ? { transferReceiver:installedRsync.receiver,
          transferPreparationClosed: async closure => {
            if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'Rsync cleanup is unavailable.', 409)
            await rsync.backend.retirePreparation(closure, AbortSignal.timeout(15_000))
          },
          transferMaterializationClosed: async record => {
            if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'Rsync cleanup is unavailable.', 409)
            await rsync.backend.retireMaterialization(record, AbortSignal.timeout(15_000))
          },
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
          harnessRegistry, { codex: selectedSuites.codex.revision },
          workerExecution, host => hostProfileChecks.assertReady(host),
          (hosts, signal) => installationMonitor.refreshHosts(hosts, signal), providerAccounts)
        agentPreparation = new AgentExecutionPreparation(jobRuntime.sources, agentPlacement)
        executionAuthority = createExecutionAuthorityExtension(database.pool, locations, agentPlacement)
      }
      const artifactPorts: NativeArtifactAuthorityPorts = { locations,
        producer: { assertPinsCurrent: (...args) => {
          if (!agentPlacement) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual artifact placement producer is unavailable.', 503)
          return agentPlacement.assertPinsCurrent(...args)
        } } }
      const artifactAuthority = new PostgresArtifactPublicationAuthority(machine.installationId, database.pool, artifactPorts)
      localWorkflowArtifacts = new LocalWorkflowArtifacts(database.pool,
        new LocalWorkflowArtifactAuthority(machine.installationId, database.pool, locations, artifactPorts.producer), () => {
          if (!fileStorage) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
            'Local workflow artifact storage is unavailable.', 503)
          return fileStorage
        })
      const outputAuthorization = infrastructure?.nativeOutputAuthorization?.(artifactAuthority)
        ?? createWorkerNativeOutputAuthorizationPort(artifactAuthority, async (input, connection, sql) => {
          const binding = deviceRuntime.currentBinding(connection.deviceId)
          const identity = binding && DeviceConnectionIdentitySchema.parse({ mainId: binding.mainId,
            deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId, keyRevision: binding.keyRevision,
            authorizationRevision: binding.authorizationRevision, bootId: binding.bootId,
            connectionGeneration: binding.connectionGeneration })
          const original = DeviceConnectionIdentitySchema.parse({ mainId: connection.mainId, deviceId: connection.deviceId,
            workerInstallationId: connection.workerInstallationId, keyRevision: connection.keyRevision,
            authorizationRevision: connection.authorizationRevision, bootId: connection.bootId,
            connectionGeneration: connection.connectionGeneration })
          if (!binding || !isDeepStrictEqual(identity, original)) {
            throw new DomainError('NATIVE_ARTIFACT_AUTHORITY_DENIED', 'The original artifact connection changed.', 403)
          }
          const row = (await sql.query<{ workspace_id: string; workflow_id: string }>(
            'select workspace_id,workflow_id from runs where id=$1 for share', [input.intent.runId])).rows[0]
          if (!row) throw new DomainError('NATIVE_ARTIFACT_CONTEXT_UNAVAILABLE', 'The original artifact Run is unavailable.', 409)
          return artifactAuthority.resolveWorkflowContext({ workspaceId: row.workspace_id, workflowId: row.workflow_id,
            runId: input.intent.runId, nodeId: input.intent.nodeId, executionId: input.intent.executionId,
            attemptId: input.intent.attemptId, placementHash: input.intent.bindingHash }, transferContextForBinding(binding), sql)
        })
      mainWorkerMcp = new MainWorkerMcpRelay(machine.installationId, database.pool, access, selectedMainMcpForward(app), outputAuthorization)
      artifactOutputsGate = createWorkflowArtifactOutputsGate(machine.installationId, artifactAuthority)
      artifactResultSource = createProductionWorkflowArtifactResultSource({ captures: workflowCapture.verify,
        physical: remoteWorkflow, authority: artifactAuthority })
      admitWorkflowFileContext = createProductionWorkflowFileContexts(machine.installationId, { captures: workflowCapture.verify,
        assertPhysical: remoteWorkflow.assertPhysical, authority: artifactAuthority, transferContext: remoteWorkflow.fileTransferContext })
      artifactComposition = { mainId: machine.installationId, authority: artifactAuthority,
        fence: new PostgresAcceptedArtifactAttemptFence(machine.installationId, artifactPorts) }
      mountArtifacts()
      await startupDatabase(() => bootstrapLocalMainWorkspaceRoot({ pool: database.pool, policies: jobRuntime!.policies,
        mainId: machine.installationId, runtimeRoot: config.harnesses.workspaceRoot, appStorageRoot: projectRoot }))
      runtimeServices.workspaceRoots = new WorkspaceBoundLocationService(database.pool, commands, jobRuntime.policies)
      locations.setRootPolicies(jobRuntime.policies)
      registerWorkspaceRootRoutes(app, runtimeServices.workspaceRoots)
      runtimeServices.sources = jobRuntime.sources
      runtimeServices.workspaceRepositories = new WorkspaceRepositoryService(database.pool, commands,
        runtimeServices.workspaces, runtimeServices.workspaceRoots, jobRuntime.policies, jobRuntime.sources,
        machine.installationId, projectRoot)
      registerWorkspaceRepositoryRoutes(app, runtimeServices.workspaceRepositories)
      const clouds = cloudCis(machine.installationId, workspaceMirrors(database.pool))
      runtimeServices.computerActivity = new ComputerActivityService(database.pool, machine.installationId,
        id => deviceRuntime.presenceFor(id), commands, clouds)
      registerComputerActivityRoutes(app, runtimeServices.computerActivity)
      runtimeServices.computerAccounts = new ComputerAccountsService(database.pool, machine.installationId,
        () => deviceRuntime.endpointForDomains(), commands)
      registerComputerAccountsRoutes(app, runtimeServices.computerAccounts)
      runtimeServices.computerMaintenance = new FleetMaintenanceService(database.pool, machine.installationId,
        () => deviceRuntime.endpointForDomains(), commands, new ComputerMaintenance(maintenancePorts), {
          codexUserMcpServers: () => harnessSettings.mcp.userServers('codex'),
          claudeUserMcpServers: () => claudeUserMcpServers(maintenancePorts),
          claudePlugins: async () => await maintenancePorts.find('claude')
            ? readClaudePlugins(maintenancePorts, AbortSignal.timeout(120_000)) : { plugins: [], marketplaces: [] },
          // Plugins from a local marketplace exist only on Main, so they are not copied to other computers.
          codexPlugins: async () => {
            if (!await maintenancePorts.find('codex')) return []
            const [plugins, marketplaces] = await Promise.all([
              installedPlugins(maintenancePorts, mainCodex.binary, AbortSignal.timeout(120_000)),
              pluginMarketplaces(maintenancePorts, mainCodex.binary, AbortSignal.timeout(60_000))])
            const local = new Set(marketplaces.filter(marketplace => marketplace.local).map(marketplace => marketplace.name))
            return plugins.filter(pluginId => !local.has(pluginId.split('@').at(-1)!))
          },
          codexMarketplaces: async () => await maintenancePorts.find('codex')
            ? (await pluginMarketplaces(maintenancePorts, mainCodex.binary, AbortSignal.timeout(60_000)))
              .flatMap(marketplace => marketplace.gitSource ? [{ name: marketplace.name, source: marketplace.gitSource }] : []) : [],
        })
      registerComputerMaintenanceRoutes(app, runtimeServices.computerMaintenance)
      if (closing) runtimeServices.computerMaintenance.stopAdmission()
      // Keep harnesses current and Main's MCP servers and plugins on every computer. Never under the test runners.
      if (!process.env.VITEST && process.env.NODE_ENV !== 'test' && process.env.FOREMAN_CODE_COMPUTER_UPKEEP !== '0') {
        const upkeep = () => { void runtimeServices.computerMaintenance!.keepCurrent().catch(error => app.log.warn({ err: error }, 'Computer upkeep failed')) }
        const firstUpkeep = setTimeout(upkeep, 120_000)
        const upkeepTimer = setInterval(upkeep, 6 * 60 * 60_000)
        // MCP server and plugin changes on Main reach the other computers within about a minute.
        const sourceSync = setInterval(() => { void runtimeServices.computerMaintenance!.syncChangedSources()
          .catch(error => app.log.warn({ err: error }, 'Fleet MCP and plugin sync failed')) }, 60_000)
        firstUpkeep.unref(); upkeepTimer.unref(); sourceSync.unref()
        stopComputerTimers = () => {
          clearTimeout(firstUpkeep)
          clearInterval(upkeepTimer)
          clearInterval(sourceSync)
        }
        if (closing) stopComputerTimers()
      }
      runtimeServices.computerGitHub = new ComputerGitHubService(database.pool, machine.installationId,
        () => deviceRuntime.endpointForDomains(), commands, {
          accountChanged: target => runtimeServices.computerAccounts!.invalidate(target),
        })
      runtimeServices.computerSync = new ComputerSyncService(database.pool, machine.installationId,
        () => deviceRuntime.endpointForDomains(), commands, undefined, () => {
          assertOpen()
          if (!runtimeOwner.active) throw new DomainError('NATIVE_RUNTIME_UNAVAILABLE', 'Shared file sync requires the runtime owner.', 503)
        })
      registerComputerSyncRoutes(app, runtimeServices.computerSync)
      const syncTimer = setInterval(() => {
        void runtimeServices.computerSync!.poll().catch(error => {
          app.log.warn({ err: error }, 'Shared file sync setup is pending')
        })
      }, 30_000)
      syncTimer.unref()
      stopSyncTimer = () => { clearInterval(syncTimer) }
      if (closing) { stopSyncTimer(); runtimeServices.computerSync.stopAdmission() }
      runtimeServices.buildComputers = jobRuntime.buildComputers
      registerBuildComputerRoutes(app, jobRuntime.buildComputers)
      runtimeServices.jobs = jobRuntime.jobs
      const readAgentFiles: ReadAgentFiles = async (hostRef, path, baseCommit) => {
        const signal = AbortSignal.timeout(150_000)
        if (hostRef.kind === 'main') return snapshotAgentWorktree(systemGitWorktreePorts(), { path, baseCommit }, signal)
        const endpoint = deviceRuntime.endpointForDomains()
        if (!endpoint.capabilities(hostRef.deviceId).some(value => value.namespace === AGENT_SNAPSHOT_NAMESPACE && value.mainCanRequest)) {
          throw new DomainError('COMPUTER_OFFLINE', 'The Agent\'s computer is offline or its app is too old to send its files.', 409)
        }
        const reply = AgentSnapshotResultSchema.parse((await endpoint.request(hostRef.deviceId, AGENT_SNAPSHOT_NAMESPACE,
          { path, baseCommit }, { signal })).payload)
        return { commit: reply.commit, bundle: reply.bundleBase64 === null ? null : Buffer.from(reply.bundleBase64, 'base64') }
      }
      // CI runs directly on build computers (Main included) from GitHub, like self-hosted runners.
      hostCi = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), new GitCiCommits(),
        new ProductionHostCiEndpoint(database.pool, machine.installationId, () => deviceRuntime.endpointForDomains(), new HostCiRunner(),
          clouds),
        agentSnapshots(database.pool, readAgentFiles))
      hostCi.start()
      app.addHook('onClose', async () => { await hostCi?.close() })
      runtimeServices.ci = hostCi
      runtimeServices.jobRuntimeProfiles = jobRuntime.profiles
      runtimeServices.ciRuntime = new CiRuntimeProvisioner(database.pool, jobRuntime.profiles, jobRuntime.sources,
        () => deviceRuntime.endpointForDomains(), commands, { changed: () => jobRuntime?.jobs.requestQueueWake(),
          main: () => jobRuntime?.mainCiRuntime })
      jobRuntime.jobs.runtimePreparation = runtimeServices.ciRuntime
      runtimeServices.ciEnrollment = new CiEnrollment(database.pool, commands, jobRuntime.profiles,
        runtimeServices.ciRuntime, new ProductionCiEnrollmentInventory(database.pool, jobRuntime.sources,
          () => deviceRuntime.endpointForDomains(), () => jobRuntime?.mainCiRuntime, workerExecution,
          new ManagedWorkspaceRootService(commands, runtimeServices.workspaceRoots, jobRuntime.policies)))
      jobRuntime.profiles.enrollment = runtimeServices.ciEnrollment
      jobRuntime.buildComputers.enrollment = runtimeServices.ciEnrollment
      runtimeServices.ciEnrollment.request()
      const enrollmentTimer = setInterval(() => runtimeServices.ciEnrollment?.request(), 30_000)
      enrollmentTimer.unref()
      app.addHook('onClose', async () => {
        clearInterval(enrollmentTimer)
        await runtimeServices.ciEnrollment?.close()
      })
      await startupDatabase(() => runtimeServices.ciRuntime!.recover())
      jobRuntime.jobs.requestQueueWake()
      registerSourceRoutes(app, jobRuntime.sources)
      registerJobRoutes(app, jobRuntime.jobs)
      registerJobRuntimeProfileRoutes(app, jobRuntime.profiles, runtimeServices.ciRuntime)
      assertOpen()
      await startupDatabase(() => harnessRegistry.initialize(machine.installationId))
      assertOpen()
      if (processRegistry instanceof NativeProcessRegistry) {
        const registry = processRegistry
        mainTelemetryContext = { kind: 'main-local', mainId: machine.installationId,
          // Approved canonical alias for the Main, not a separate hardware UUID.
          deviceId: machine.installationId, applicationInstallationId: machine.installationId,
          bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
          runtimeEpoch: await startupDatabase(() => runtimeOwner.readRuntimeEpoch()), capability: RESOURCE_TELEMETRY_CAPABILITY }
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
          // A Main inside a container sees only its namespace, never the whole computer.
          wholeHostVisible: !existsSync('/.dockerenv') && !existsSync('/run/.containerenv'), signal: telemetryLifetime.signal })
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
        await qualificationRegistry.load(startupDatabase)
      }
      harnessCompatibility.start()
      assertOpen()
      initialized = true
      // Reconcile chat turns interrupted by the previous process; never blocks startup.
      void agentChat.recover().catch((error: unknown) => app.log.error({ err: error }, 'agent chat recovery failed'))
      // Fill the settings status and model caches in the background so first reads do not wait on native checks.
      void Promise.allSettled([harnessCatalog.warmup(), nativeConfigurations.options('codex'), nativeConfigurations.options('claude'),
        harnessSettings.mcp.warmup(['codex']), harnessSettings.plugins.warmup(), harnessSettings.claudePlugins.warmup()])
      // Deployment can change the launcher or environment; restore a previously qualified Codex binary.
      if (harnessQualifications) void harnessQualifications.restore('codex').catch((error: unknown) =>
        app.log.warn({ err: error }, 'Main Codex requalification after restart failed'))
      installationMonitor.start(machine.installationId)
    })
    // On failure the startup caller closes the app. Only the shared shutdown
    // barrier may release the owner, after any already-admitted work drains.
    return initialization
  }
  // Native catalogs may need provider authentication or network access. Local HTTP
  // becomes available first; execution still uses its existing qualification gates.
  app.addHook('onListen', async () => {
    if (!initialized || closing || infrastructure?.mode === 'replay') return
    nativeDefaultsInitialization ??= (async () => {
      await initializeNativeDefaults({
        pool: database.pool,
        options: harness => startupDatabase(() => nativeConfigurations.options(harness)),
        appMcpEndpoint,
        signal: startupLifetime.signal,
      })
      assertOpen()
      await startupDatabase(() => harnessRegistry.refreshMain())
      assertOpen()
      const initializedDefaults = await startupDatabase(() => foundationSettings.getAgentDefaults())
      const currentOperator = await startupDatabase(() => operators.ensure())
      if (!isDeepStrictEqual(currentOperator.configuration.harness, initializedDefaults.value.operator.harness)) {
        await startupDatabase(() => synchronizeOperatorDefaults(initializedDefaults.value.operator))
      }
    })()
    await nativeDefaultsInitialization
  })
  const SNAPSHOT_RELEASE_INTERVAL_MS = 10 * 60_000
  let lastSnapshotRelease = 0
  const reconcile = (report: (error: unknown) => void): Promise<void> => {
    if (closing) return Promise.resolve()
    if (reconciliation) return reconciliation
    reconciliation = (async () => {
      if (jobRuntime) await jobRuntime.reconcileFailedCaptures(report)
      if (jobRuntime) await jobRuntime.reconcileMaterializationReservations(report)
      if (jobRuntime) await closeCompletedWorkflowSources(database.pool, jobRuntime.sources, report)
      // Age-based release is not urgent; storage pressure still releases on demand during approval and preparation.
      if (jobRuntime && Date.now() - lastSnapshotRelease >= SNAPSHOT_RELEASE_INTERVAL_MS) {
        lastSnapshotRelease = Date.now()
        await jobRuntime.sources.releaseUnusedSnapshots(report)
      }
      await engine.reconcile(report)
      if (closing) return
      await runWorktrees.cleanup(report)
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
  return { app, engine, prepareSchema, initialize, reconcile, shutdown, drainShutdown, rsync,
    registerFileStorage: () => {
      fileStorage ??= registerProductionFileStorage(app, database.pool, config)
      mountArtifacts()
      return fileStorage
    }, startDeviceListener: () => deviceRuntime.startListener() }
}
