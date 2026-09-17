import { McpServer } from '@modelcontextprotocol/server'

import type { OperatorRequestContext } from './types.js'
import { registerAgentTools } from './tools/agents.js'
import { registerExtendedOperatorTools } from './tools/extensions.js'
import { registerContextTools } from './tools/context.js'
import { registerGraphTools } from './tools/graph.js'
import { registerHarnessTools } from './tools/harnesses.js'
import { registerHarnessMcpTools } from './tools/harnessMcp.js'
import { registerRunTools } from './tools/runs.js'
import { registerWorkflowTools } from './tools/workflows.js'
import { registerWorkspaceTools } from './tools/workspaces.js'
import { registerInteractionTools } from './tools/interactions.js'
import { registerSettingsTools } from './tools/settings.js'
import { registerWorkspaceDefaultsTools } from './tools/workspaceDefaults.js'

export function createOperatorMcpServer(context: OperatorRequestContext): McpServer {
  const server = new McpServer({ name: 'graphql-operator', version: '1.0.0' })
  registerContextTools(server, context)
  registerHarnessTools(server, context)
  registerHarnessMcpTools(server, context)
  registerSettingsTools(server, context)
  registerWorkspaceDefaultsTools(server, context)
  registerWorkspaceTools(server, context)
  registerWorkflowTools(server, context)
  registerAgentTools(server, context)
  registerGraphTools(server, context)
  registerRunTools(server, context)
  registerInteractionTools(server, context)
  registerExtendedOperatorTools(server, context)
  return server
}
