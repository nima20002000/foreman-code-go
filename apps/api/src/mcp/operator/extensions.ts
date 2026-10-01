import type { HostHarnessOverrideService } from '../../modules/harnesses/instanceSettings/service.js'
import type pg from 'pg'
import type { PostgresCommandCoordinator } from '../../modules/commands/postgres.js'
import type { HarnessCatalogService } from '../../modules/harnesses/catalog.js'
import type { NativeConfigurationService } from '../../modules/harnesses/nativeConfiguration.js'
import type { McpDetectionService } from '../../modules/harnesses/mcpDetection.js'
import type { WorkspaceLocationService } from '../../modules/workspaces/location.js'
import { OperatorAgentMutationService } from '../../modules/workspaces/operatorAgents.js'
import { OperatorLifecycleService } from '../../modules/workspaces/operatorLifecycle.js'
import { OperatorWorkspaceControls } from '../../modules/workspaces/operatorControls.js'
import { VersionHistoryService } from '../../modules/workflows/historyManagement.js'
import { SkillCatalogService } from '../../modules/skills/catalog.js'

export function createOperatorExtensions(input: {
  pool:pg.Pool;commands:PostgresCommandCoordinator;catalog:HarnessCatalogService;native:NativeConfigurationService;
  detection:McpDetectionService;locations:WorkspaceLocationService;
  provisioningRoot?:string|undefined;
  harnessProfiles?: Pick<HostHarnessOverrideService, 'validateSelection'>;
}) {
  return {
    native:input.native,
    agents:new OperatorAgentMutationService(input.pool,input.commands,input.catalog,input.harnessProfiles),
    history:new VersionHistoryService(input.pool),
    lifecycle:new OperatorLifecycleService(input.commands),
    workspace:new OperatorWorkspaceControls(input.pool,input.commands,input.locations,input.detection,input.provisioningRoot),
    skills:new SkillCatalogService(input.pool,input.commands),
  }
}
export type OperatorExtensions = ReturnType<typeof createOperatorExtensions>
