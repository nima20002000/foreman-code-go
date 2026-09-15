import type { ManagementPrincipal } from '@graphql/contracts/management'

import type { AgentManagementService } from '../../modules/workspaces/agents.js'
import type { GraphDraftService } from '../../modules/graph-drafts/service.js'
import type { HarnessCatalogService } from '../../modules/harnesses/catalog.js'
import type { RunManagementService } from '../../modules/runs/management.js'
import type { WorkflowManagementService } from '../../modules/workflows/management.js'
import type { WorkspaceManagementService } from '../../modules/workspaces/management.js'
import type { PostgresCommandCoordinator } from '../../modules/commands/postgres.js'
import type { WorkspaceLocationService } from '../../modules/workspaces/location.js'

export interface OperatorServices {
  workspaces: WorkspaceManagementService
  locations: WorkspaceLocationService
  workflows: WorkflowManagementService
  agents: AgentManagementService
  drafts: GraphDraftService
  harnesses: HarnessCatalogService
  runs: RunManagementService
  commands: PostgresCommandCoordinator
}

export interface OperatorRequestContext {
  principal: ManagementPrincipal
  services: OperatorServices
}
