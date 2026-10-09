import type { McpServer } from '@modelcontextprotocol/server'

import { AgentGetInputSchema, ManagedAgentDetailSchema, ManagedAgentPageSchema } from '@foreman-code/contracts/management'
import { OperatorAgentListInputSchema } from '@foreman-code/contracts/operator-mcp'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerAgentTools(server: McpServer, context: OperatorRequestContext): void {
  if (operatorToolAvailable(context, 'agent_list')) server.registerTool('agent_list', {
    description: 'List authorized logical agents and metadata revisions (10 by default).', inputSchema: OperatorAgentListInputSchema,
    outputSchema: ManagedAgentPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'agent_list', () => context.services.agents.list(context.principal, input)))
  if (operatorToolAvailable(context, 'agent_get')) server.registerTool('agent_get', {
    description: 'Read a logical agent and the workflows that reference it.', inputSchema: AgentGetInputSchema,
    outputSchema: ManagedAgentDetailSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'agent_get', () => context.services.agents.get(context.principal, input.workspaceId, input.agentId)))
}
