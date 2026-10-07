import type { DeviceManagementService } from '../../modules/devices/management.js'
import type { FileReferenceService } from '../../modules/files/references/service.js'
import type { RunGraphReadApi } from '../../modules/run-graph/readService.js'
import type { OperatorExtensions } from './extensions.js'
import type { HarnessMcpSettingsService } from '../../modules/harnesses/mcpSettings.js'
import type { HarnessDirectoryBrowser } from '../../modules/harnesses/directoryBrowser.js'
import type { CodexPluginSettingsService } from '../../modules/harnesses/codexPluginSettings.js'
import type { OperatorChatService } from '../../modules/conversations/operatorChat.js'
import type { AgentChatService } from '../../modules/conversations/agentChat.js'
import type { FileRetentionService } from '../../modules/files/retention.js'

import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import type { AgentManagementService } from '../../modules/workspaces/agents.js'
import type { HarnessCatalogService } from '../../modules/harnesses/catalog.js'
import type { RunManagementService } from '../../modules/runs/management.js'
import type { WorkflowManagementService } from '../../modules/workflows/management.js'
import type { WorkspaceManagementService } from '../../modules/workspaces/management.js'
import type { PostgresCommandCoordinator } from '../../modules/commands/postgres.js'
import type { WorkspaceLocationService } from '../../modules/workspaces/location.js'
import type { FoundationSettingsManagementService } from '../../modules/settings/management.js'
import type { OperatorInteractionService } from '../../modules/interactions/operator.js'

export interface OperatorServices {
  ci?: import('../../modules/jobs/ci.js').CiService
  workerExecution?: import('../../modules/settings/workerExecution.js').WorkerExecutionPolicy
  jobs?: import('../../modules/jobs/service.js').JobService
  jobRuntimeProfiles?: import('../../modules/jobs/runtimeProfiles.js').JobRuntimeProfiles
  resourceTelemetry?: {
    reads: import('@foreman-code/contracts/resource-telemetry').TelemetryReadService<ManagementPrincipal>
    selectors: import('@foreman-code/contracts/resource-telemetry').TelemetrySelectorService<ManagementPrincipal>
  }
  workspaceRoots?: import('../../modules/workspace-roots/service.js').WorkspaceBoundLocationService
  harnessInstances?: import('../../modules/harnesses/instanceSettings/service.js').HostHarnessOverrideService
  harnessRegistry?: import('../../modules/harnesses/productionRegistry.js').ProductionHarnessRegistry
  trustedConnections?: import('../../modules/devices/trustedConnectionManagement.js').TrustedConnectionManagementService
  computerActivity?: import('../../modules/computers/activity.js').ComputerActivityService
  computerAccounts?: import('../../modules/computers/accounts.js').ComputerAccountsService
  computerGitHub?: import('../../modules/computers/github.js').ComputerGitHubService
  buildComputers?: import('../../modules/settings/buildComputers.js').BuildComputerSettings
  devices?: DeviceManagementService
  sources?: import('../../modules/sources/service.js').PostgresSourceService
  fileReferences?: FileReferenceService
  executionReadiness?: import('../../modules/harnesses/executionReadiness.js').ExecutionReadinessService
  runGraph?: RunGraphReadApi
  runPlacements?: import('../../modules/placement/readService.js').RunPlacementReadService
  operatorChat?: Pick<OperatorChatService, 'readSessionControls' | 'changeSessionControls' | 'setup' | 'create' | 'list' | 'get' | 'history' | 'activityPage' | 'send' | 'handoffHistory' | 'cancel' | 'respond'>
  agentChat?: AgentChatService
  fileRetention?: FileRetentionService
  harnessSettings?: { mcp: HarnessMcpSettingsService; directories: HarnessDirectoryBrowser; plugins?: CodexPluginSettingsService }
  extensions?: OperatorExtensions
  workerToolsMcpImplemented?: boolean
  workspaces: WorkspaceManagementService
  locations: WorkspaceLocationService
  workflows: WorkflowManagementService
  agents: AgentManagementService
  harnesses: HarnessCatalogService
  harnessCompatibility?: import('../../modules/harnesses/compatibility/service.js').HarnessCompatibilityService
  harnessQualifications?: import('../../modules/harnesses/qualification/service.js').HarnessQualificationService
  settings?: FoundationSettingsManagementService
  runs: RunManagementService
  commands: PostgresCommandCoordinator
  interactions?: OperatorInteractionService
}

export interface OperatorRequestContext {
  principal: ManagementPrincipal
  services: OperatorServices
}
