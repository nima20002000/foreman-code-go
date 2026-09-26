import type { RunGraphReadApi } from '../../modules/run-graph/readService.js'
import type { OperatorExtensions } from './extensions.js'
import type { HarnessMcpSettingsService } from '../../modules/harnesses/mcpSettings.js'
import type { HarnessDirectoryBrowser } from '../../modules/harnesses/directoryBrowser.js'
import type { CodexPluginSettingsService } from '../../modules/harnesses/codexPluginSettings.js'
import type { OperatorChatService } from '../../modules/conversations/operatorChat.js'

import type { ManagementPrincipal } from '@graphql/contracts/management'

import type { AgentManagementService } from '../../modules/workspaces/agents.js'
import type { Wave25ApprovalDraftService } from '../../modules/workflows/approvalDraftService.js'
import type { GraphDraftService } from '../../modules/graph-drafts/service.js'
import type { HarnessCatalogService } from '../../modules/harnesses/catalog.js'
import type { RunManagementService } from '../../modules/runs/management.js'
import type { WorkflowManagementService } from '../../modules/workflows/management.js'
import type { WorkspaceManagementService } from '../../modules/workspaces/management.js'
import type { PostgresCommandCoordinator } from '../../modules/commands/postgres.js'
import type { WorkspaceLocationService } from '../../modules/workspaces/location.js'
import type { FoundationSettingsManagementService } from '../../modules/settings/management.js'
import type { OperatorInteractionService } from '../../modules/interactions/operator.js'

export interface OperatorServices {
  executionReadiness?: import('../../modules/harnesses/executionReadiness.js').ExecutionReadinessService
  runGraph?: RunGraphReadApi
  operatorChat?: Pick<OperatorChatService, 'setup' | 'create' | 'get' | 'send' | 'handoffHistory'>
  harnessSettings?: { mcp: HarnessMcpSettingsService; directories: HarnessDirectoryBrowser; plugins?: CodexPluginSettingsService }
  extensions?: OperatorExtensions
  workerToolsMcpImplemented?: boolean
  workspaces: WorkspaceManagementService
  locations: WorkspaceLocationService
  workflows: WorkflowManagementService
  agents: AgentManagementService
  drafts: GraphDraftService
  approvalDrafts?: Wave25ApprovalDraftService
  harnesses: HarnessCatalogService
  settings?: FoundationSettingsManagementService
  runs: RunManagementService
  commands: PostgresCommandCoordinator
  interactions?: OperatorInteractionService
}

export interface OperatorRequestContext {
  principal: ManagementPrincipal
  services: OperatorServices
}
