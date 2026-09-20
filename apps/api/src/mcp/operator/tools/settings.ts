import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { OperatorChatSetupSchema } from '@graphql/contracts'

import {
  AgentDefaultsUpdateInputSchema,
  AgentDefaultsUpdateResultSchema,
  ManagedAgentDefaultsSchema,
  ManagedWorkflowDefaultsSchema,
  WorkflowDefaultsUpdateInputSchema,
  WorkflowDefaultsUpdateResultSchema,
} from '@graphql/contracts/management'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerSettingsTools(server: McpServer, context: OperatorRequestContext): void {
  if (context.services.operatorChat && operatorToolAvailable(context, 'operator_mcp_setup_get')) server.registerTool('operator_mcp_setup_get', {
    description: 'Check the saved Operator harness for the required enabled graphql-operator MCP endpoint and credential environment reference. This checks installation only; it does not install MCP, issue credentials, or prove provider authentication.',
    inputSchema: z.object({}).strict(), outputSchema: OperatorChatSetupSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'operator_mcp_setup_get', () => context.services.operatorChat!.setup(context.principal)))
  const settings = context.services.settings
  if (!settings) return
  if (operatorToolAvailable(context, 'agent_defaults_get')) server.registerTool('agent_defaults_get', {
    description: 'Read saved role defaults, including the shared Operator chat model, harness, effort, and thinking preferences. New Operator conversations inherit these settings. Operator UI enablement does not disable management MCP.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedAgentDefaultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'agent_defaults_get', () => settings.getAgentDefaults(context.principal)))
  if (operatorToolAvailable(context, 'workflow_defaults_get')) server.registerTool('workflow_defaults_get', {
    description: 'Read defaults copied into newly created workflows, including approval routing. Graph edges do not grant approval authority.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedWorkflowDefaultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'workflow_defaults_get', () => settings.getWorkflowDefaults(context.principal)))
  if (operatorToolAvailable(context, 'agent_defaults_update')) server.registerTool('agent_defaults_update', {
    description: 'Revision-check and replace role defaults, including the shared settings shown in Operator chat and Settings > Agents > Operator. New conversations inherit Operator changes; running turns and accepted Runs remain pinned. Requires global settings:update.',
    inputSchema: AgentDefaultsUpdateInputSchema, outputSchema: AgentDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'agent_defaults_update', () => settings.updateAgentDefaults(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workflow_defaults_update')) server.registerTool('workflow_defaults_update', {
    description: 'Revision-check and replace defaults for future workflows. Existing workflows and in-flight approvals do not change.',
    inputSchema: WorkflowDefaultsUpdateInputSchema, outputSchema: WorkflowDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_defaults_update', () => settings.updateWorkflowDefaults(context.principal, 'mcp', input)))
}
