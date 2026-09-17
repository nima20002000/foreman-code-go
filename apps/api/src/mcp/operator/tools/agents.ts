import type { McpServer } from '@modelcontextprotocol/server'

import { AgentGetInputSchema, AgentListInputSchema, ManagedAgentDetailSchema, ManagedAgentPageSchema } from '@graphql/contracts/management'
import { hasAction } from '../../../modules/access/policy.js'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerAgentTools(server: McpServer, context: OperatorRequestContext): void {
  if (!hasAction(context.principal, 'agents:read')) return
  if (operatorToolAvailable(context, 'agent_list')) server.registerTool('agent_list', {
    description: 'List authorized logical agents and metadata revisions.', inputSchema: AgentListInputSchema,
    outputSchema: ManagedAgentPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'agent_list', () => context.services.agents.list(context.principal, input)))
  if (operatorToolAvailable(context, 'agent_get')) server.registerTool('agent_get', {
    description: 'Read a logical agent and the workflows that reference it.', inputSchema: AgentGetInputSchema,
    outputSchema: ManagedAgentDetailSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'agent_get', () => context.services.agents.get(context.principal, input.workspaceId, input.agentId)))
}
