import { MCP_DISPLAY_NAME, PRODUCT_SLUG } from '@foreman-code/contracts/product'
import { registerWorkspaceRootAdoptionTool } from '../../modules/workspace-roots/transports.js'
import { registerHostHarnessOverrideTools } from '../../modules/harnesses/instanceSettings/management.js'
import { registerJobTools } from './tools/jobs.js'
import { registerCiTools } from '../shared/ciTools.js'
import { registerJobRuntimeTools } from './tools/jobRuntimeProfiles.js'
import { registerFileReferenceTools } from './tools/fileReferences.js'
import { McpServer } from '@modelcontextprotocol/server'
import { paginateToolLists } from '../toolListPagination.js'
import { cacheToolSchemaConversions } from '../shared/schemaCache.js'
import { stripMcpInputSchemas } from '../shared/inputSchemas.js'
import { retryReadOnlyToolConnections } from '../shared/databaseReadRetry.js'
import { installOperatorPresentation, type OperatorCatalog } from './presentation.js'

import type { OperatorRequestContext } from './types.js'
import { registerRunGraphTools } from './tools/runGraph.js'
import { registerRunInspectionTools } from './tools/runInspection.js'
import { registerWorkflowScheduleTools } from './tools/workflowSchedules.js'
import { registerCurrentWorkflowTools } from './tools/currentWorkflow.js'
import { registerFileRetentionTools } from './tools/fileRetention.js'
import { authorizationPrincipal } from '../../modules/access/policy.js'
import { OPERATOR_TOOL_GROUPS, OPERATOR_TOOLS, type OperatorToolGroup } from './catalog.js'
import { registerToolDefinition, toolAvailable, type OperatorToolDefinition } from './definition.js'
import { invokeOperatorTool } from './invoke.js'

export function createOperatorMcpServer(context: OperatorRequestContext): McpServer {
  const server = new McpServer({ name: PRODUCT_SLUG, title: MCP_DISPLAY_NAME, version: '1.0.0' })
  cacheToolSchemaConversions(server, 'operator')
  stripMcpInputSchemas(server)
  retryReadOnlyToolConnections(server)
  paginateToolLists(server)
  const catalog = installOperatorPresentation(server)
  registerOperatorTools(server, context, catalog)
  return server
}

/** Registers the registry tools this caller can discover, in order. */
export function registerOperatorToolGroup(server: McpServer, context: OperatorRequestContext,
  tools: readonly OperatorToolDefinition[], catalog?: OperatorCatalog | undefined): void {
  for (const tool of tools) {
    if (toolAvailable(context, tool)) registerToolDefinition(server, context, tool, { invoke: invokeOperatorTool, catalog, tools: OPERATOR_TOOLS })
  }
}

export function registerOperatorTools(server: McpServer, context: OperatorRequestContext, catalog?: OperatorCatalog): void {
  context = { ...context, principal: authorizationPrincipal(context.principal) }
  const group = (name: OperatorToolGroup) => registerOperatorToolGroup(server, context, OPERATOR_TOOL_GROUPS[name], catalog)
  group('bugReports')
  group('resourceTelemetry')
  group('harnessRegistry')
  if (context.services.workspaceRoots) registerWorkspaceRootAdoptionTool(server, context.services.workspaceRoots, context.principal, context.services.commands)
  group('workspaceRoots')
  if (context.services.harnessInstances) registerHostHarnessOverrideTools(server, context.services.harnessInstances, context.principal)
  group('sources')
  registerJobTools(server, context)
  registerCiTools(server, context)
  registerJobRuntimeTools(server, context)
  group('buildComputers')
  group('devices')
  group('trustedConnections')
  registerFileReferenceTools(server, context)
  group('capabilities')
  group('harnesses')
  group('harnessMcp')
  group('claudePlugins')
  group('settings')
  group('providerAccounts')
  group('agentChat')
  group('sessionControls')
  group('workspaceDefaults')
  registerFileRetentionTools(server, context)
  group('workspaces')
  registerCurrentWorkflowTools(server, context)
  group('workflows')
  registerWorkflowScheduleTools(server, context)
  group('agents')
  group('runs')
  group('placement')
  group('subagents')
  registerRunInspectionTools(server, context)
  if (context.services.runGraph) registerRunGraphTools(server, context, context.services.runGraph)
  group('interactions')
  group('extensions')
  group('toolSchema')
}
