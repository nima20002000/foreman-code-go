import { registerSubagentTools } from './tools/subagents.js'
import { operatorToolAvailable } from './availability.js'
import { registerHarnessRegistryTools } from '../../modules/harnesses/registryManagement.js'
import { registerWorkspaceRootTools } from '../../modules/workspace-roots/transports.js'
import { registerHostHarnessOverrideTools } from '../../modules/harnesses/instanceSettings/management.js'
import { registerResourceTelemetryTools } from './resourceTelemetry.js'
import { registerResourceTelemetrySelectorTools } from './resourceTelemetrySelector.js'
import { registerJobTools } from './tools/jobs.js'
import { registerJobRuntimeTools } from './tools/jobRuntimeProfiles.js'
import { registerTrustedConnectionTools } from '../../modules/devices/trustedConnectionManagement.js'
import { registerDeviceOperatorTools } from './tools/devices.js'
import { registerSourceTools } from '../../modules/sources/mcp.js'
import { registerFileReferenceTools } from './tools/fileReferences.js'
import { McpServer } from '@modelcontextprotocol/server'

import type { OperatorRequestContext } from './types.js'
import { registerAgentTools } from './tools/agents.js'
import { registerExtendedOperatorTools } from './tools/extensions.js'
import { registerContextTools } from './tools/context.js'
import { registerHarnessTools } from './tools/harnesses.js'
import { registerHarnessMcpTools } from './tools/harnessMcp.js'
import { registerRunGraphTools } from './tools/runGraph.js'
import { registerRunInspectionTools } from './tools/runInspection.js'
import { registerRunTools } from './tools/runs.js'
import { registerWorkflowTools } from './tools/workflows.js'
import { registerWorkflowScheduleTools } from './tools/workflowSchedules.js'
import { registerWorkspaceTools } from './tools/workspaces.js'
import { registerInteractionTools } from './tools/interactions.js'
import { registerSettingsTools } from './tools/settings.js'
import { registerAgentChatTools } from './tools/agentChat.js'
import { registerWorkspaceDefaultsTools } from './tools/workspaceDefaults.js'
import { registerFileRetentionTools } from './tools/fileRetention.js'

export function createOperatorMcpServer(context: OperatorRequestContext): McpServer {
  const server = new McpServer({ name: 'graphql', version: '1.0.0' })
  registerOperatorTools(server, context)
  return server
}

export function registerOperatorTools(server: McpServer, context: OperatorRequestContext): void {
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
  registerJobRuntimeTools(server, context)
  registerDeviceOperatorTools(server, context)
  if (context.services.trustedConnections) registerTrustedConnectionTools(server, context.services.trustedConnections, context.principal)
  registerFileReferenceTools(server, context)
  registerContextTools(server, context)
  registerHarnessTools(server, context)
  registerHarnessMcpTools(server, context)
  registerSettingsTools(server, context)
  registerAgentChatTools(server, context)
  registerWorkspaceDefaultsTools(server, context)
  registerFileRetentionTools(server, context)
  registerWorkspaceTools(server, context)
  registerWorkflowTools(server, context)
  registerWorkflowScheduleTools(server, context)
  registerAgentTools(server, context)
  registerRunTools(server, context)
  registerSubagentTools(server, context)
  registerRunInspectionTools(server, context)
  if (context.services.runGraph) registerRunGraphTools(server, context, context.services.runGraph)
  registerInteractionTools(server, context)
  registerExtendedOperatorTools(server, context)
}
