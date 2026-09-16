import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import {
  AgentDefaultsUpdateInputSchema,
  AgentDefaultsUpdateResultSchema,
  ManagedAgentDefaultsSchema,
  ManagedWorkflowDefaultsSchema,
  WorkflowDefaultsUpdateInputSchema,
  WorkflowDefaultsUpdateResultSchema,
} from '@graphql/contracts/management'
import { hasAction } from '../../../modules/access/policy.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorRequestContext } from '../types.js'

export function registerSettingsTools(server: McpServer, context: OperatorRequestContext): void {
  const settings = context.services.settings
  if (!settings) return
  if (hasAction(context.principal, 'settings:read')) {
    server.registerTool('agent_defaults_get', {
      description: 'Read role defaults copied into future Orchestrator, Coder, and Operator configurations. Operator UI enablement does not disable management MCP.',
      inputSchema: z.object({}).strict(), outputSchema: ManagedAgentDefaultsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => invokeOperatorTool(context, 'agent_defaults_get', () => settings.getAgentDefaults(context.principal)))
    server.registerTool('workflow_defaults_get', {
      description: 'Read defaults copied into newly created workflows, including approval routing. Graph edges do not grant approval authority.',
      inputSchema: z.object({}).strict(), outputSchema: ManagedWorkflowDefaultsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => invokeOperatorTool(context, 'workflow_defaults_get', () => settings.getWorkflowDefaults(context.principal)))
  }
  if (hasAction(context.principal, 'settings:update')) {
    server.registerTool('agent_defaults_update', {
      description: 'Revision-check and replace role defaults for future Agents. Existing Agents and accepted Runs remain pinned.',
      inputSchema: AgentDefaultsUpdateInputSchema, outputSchema: AgentDefaultsUpdateResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => invokeOperatorTool(context, 'agent_defaults_update', () => settings.updateAgentDefaults(context.principal, 'mcp', input)))
    server.registerTool('workflow_defaults_update', {
      description: 'Revision-check and replace defaults for future workflows. Existing workflows and in-flight approvals do not change.',
      inputSchema: WorkflowDefaultsUpdateInputSchema, outputSchema: WorkflowDefaultsUpdateResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => invokeOperatorTool(context, 'workflow_defaults_update', () => settings.updateWorkflowDefaults(context.principal, 'mcp', input)))
  }
}
