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
  registerRunInspectionTools(server, context)
  if (context.services.runGraph) registerRunGraphTools(server, context, context.services.runGraph)
  registerInteractionTools(server, context)
  registerExtendedOperatorTools(server, context)
}
