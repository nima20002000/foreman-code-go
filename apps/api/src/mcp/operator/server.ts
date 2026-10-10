import { MCP_DISPLAY_NAME, PRODUCT_SLUG } from '@foreman-code/contracts/product'
import { registerSessionControlTools } from './tools/sessionControls.js'
import { registerSubagentTools } from './tools/subagents.js'
import { operatorToolAvailable } from './availability.js'
import { registerHarnessRegistryTools } from '../../modules/harnesses/registryManagement.js'
import { registerWorkspaceRootTools } from '../../modules/workspace-roots/transports.js'
import { registerHostHarnessOverrideTools } from '../../modules/harnesses/instanceSettings/management.js'
import { registerResourceTelemetryTools } from './resourceTelemetry.js'
import { registerResourceTelemetrySelectorTools } from './resourceTelemetrySelector.js'
import { registerJobTools } from './tools/jobs.js'
import { registerCiTools } from '../shared/ciTools.js'
import { registerJobRuntimeTools } from './tools/jobRuntimeProfiles.js'
import { registerTrustedConnectionTools } from '../../modules/devices/trustedConnectionManagement.js'
import { registerBuildComputerTools } from './tools/buildComputers.js'
import { registerDeviceOperatorTools } from './tools/devices.js'
import { registerSourceTools } from '../../modules/sources/mcp.js'
import { registerFileReferenceTools } from './tools/fileReferences.js'
import { McpServer } from '@modelcontextprotocol/server'
import { paginateToolLists } from '../toolListPagination.js'
import { installOperatorPresentation, type OperatorCatalog } from './presentation.js'
import { registerToolSchemaLookup } from './tools/toolSchema.js'

import type { OperatorRequestContext } from './types.js'
import { registerAgentTools } from './tools/agents.js'
import { registerExtendedOperatorTools } from './tools/extensions.js'
import { registerContextTools } from './tools/context.js'
import { registerHarnessTools } from './tools/harnesses.js'
import { registerClaudePluginTools } from './tools/claudePlugins.js'
import { registerHarnessMcpTools } from './tools/harnessMcp.js'
import { registerRunGraphTools } from './tools/runGraph.js'
import { registerRunInspectionTools } from './tools/runInspection.js'
import { registerRunTools } from './tools/runs.js'
import { registerRunPlacementTool, registerNodePlacementChoicesTool } from '../../modules/placement/transports.js'
import { registerWorkflowTools } from './tools/workflows.js'
import { registerWorkflowScheduleTools } from './tools/workflowSchedules.js'
import { registerWorkspaceTools } from './tools/workspaces.js'
import { registerInteractionTools } from './tools/interactions.js'
import { registerSettingsTools } from './tools/settings.js'
import { registerProviderAccountTools } from './tools/providerAccounts.js'
import { registerAgentChatTools } from './tools/agentChat.js'
import { registerWorkspaceDefaultsTools } from './tools/workspaceDefaults.js'
import { registerFileRetentionTools } from './tools/fileRetention.js'
import { registerBugReportTools } from './tools/bugReports.js'

export function createOperatorMcpServer(context: OperatorRequestContext): McpServer {
  const server = new McpServer({ name: PRODUCT_SLUG, title: MCP_DISPLAY_NAME, version: '1.0.0' })
  paginateToolLists(server)
  const catalog = installOperatorPresentation(server)
  registerOperatorTools(server, context, catalog)
  return server
}

export function registerOperatorTools(server: McpServer, context: OperatorRequestContext, catalog?: OperatorCatalog): void {
  registerBugReportTools(server, context)
  if (context.services.resourceTelemetry) {
    const audit = (tool: string) => ({ record: (principalId: string, source: 'http' | 'mcp', selectorKey: string) =>
      context.services.commands.recordDenied(principalId, source, tool, selectorKey) })
    if (operatorToolAvailable(context, 'resource_telemetry_read')) registerResourceTelemetryTools(server, context.principal, context.services.resourceTelemetry.reads, audit('resource_telemetry_read'))
    if (operatorToolAvailable(context, 'resource_telemetry_selector_get')) registerResourceTelemetrySelectorTools(server, context.principal, context.services.resourceTelemetry.selectors, audit('resource_telemetry_selector_get'))
  }
  if (context.services.harnessRegistry) registerHarnessRegistryTools(server, context.services.harnessRegistry, context.principal)
  if (context.services.workspaceRoots) registerWorkspaceRootTools(server, context.services.workspaceRoots, context.principal, context.services.commands)
  if (context.services.harnessInstances) registerHostHarnessOverrideTools(server, context.services.harnessInstances, context.principal)
  registerSourceTools(server, context)
  registerJobTools(server, context)
  registerCiTools(server, context)
  registerJobRuntimeTools(server, context)
  registerBuildComputerTools(server, context)
  registerDeviceOperatorTools(server, context)
  if (context.services.trustedConnections) registerTrustedConnectionTools(server, context.services.trustedConnections, context.principal)
  registerFileReferenceTools(server, context)
  registerContextTools(server, context, catalog)
  registerHarnessTools(server, context)
  registerHarnessMcpTools(server, context)
  registerClaudePluginTools(server, context)
  registerSettingsTools(server, context)
  registerProviderAccountTools(server, context)
  registerAgentChatTools(server, context)
  registerSessionControlTools(server, context)
  registerWorkspaceDefaultsTools(server, context)
  registerFileRetentionTools(server, context)
  registerWorkspaceTools(server, context)
  registerWorkflowTools(server, context)
  registerWorkflowScheduleTools(server, context)
  registerAgentTools(server, context)
  registerRunTools(server, context)
  if (context.services.runPlacements && operatorToolAvailable(context, 'run_node_placement_get')) {
    registerRunPlacementTool(server, context.services.runPlacements, context.principal, context.services.commands)
  }
  if (context.services.placementChoices && operatorToolAvailable(context, 'workflow_node_placement_choices')) {
    registerNodePlacementChoicesTool(server, context.services.placementChoices, context.principal, context.services.commands)
  }
  registerSubagentTools(server, context)
  registerRunInspectionTools(server, context)
  if (context.services.runGraph) registerRunGraphTools(server, context, context.services.runGraph)
  registerInteractionTools(server, context)
  registerExtendedOperatorTools(server, context)
  registerToolSchemaLookup(server, context, catalog)
}
