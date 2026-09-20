import type { McpServer } from '@modelcontextprotocol/server'
import {
  InteractionGetInputSchema,
  InteractionSummaryInputSchema, InteractionSummaryResultSchema,
  InteractionListInputSchema,
  InteractionRespondInputSchema,
  InteractionRespondResultSchema,
  ManagedInteractionPageSchema,
  ManagedInteractionSchema,
} from '@graphql/contracts/management'

import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerInteractionTools(server: McpServer, context: OperatorRequestContext): void {
  const service = context.services.interactions
  if (!service) return
  if (operatorToolAvailable(context, 'interaction_summary')) server.registerTool('interaction_summary', {
    description: 'Read pending counts over all authorized scopes and the optional handler filter; no decision authority is granted.',
    inputSchema: InteractionSummaryInputSchema, outputSchema: InteractionSummaryResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'interaction_summary', () => service.summary(context.principal, input)))
  if (operatorToolAvailable(context, 'interaction_list')) server.registerTool('interaction_list', {
    description: 'List authorized native interactions across handlers, with scoped counts and response permissions. Reading is not approval authority.',
    inputSchema: InteractionListInputSchema, outputSchema: ManagedInteractionPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'interaction_list', () => service.list(context.principal, input)))
  if (operatorToolAvailable(context, 'interaction_get')) server.registerTool('interaction_get', {
    description: 'Read one authorized native interaction, its review failure, retry timing and cleanup status (including canceled history), and handler-specific response permissions.',
    inputSchema: InteractionGetInputSchema, outputSchema: ManagedInteractionSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'interaction_get', () => service.get(context.principal, input.interactionId)))
  if (operatorToolAvailable(context, 'interaction_respond')) server.registerTool('interaction_respond', {
    description: 'Choose one server-generated opaque option for an Operator-assigned native request. This tool cannot override an Orchestrator assignment or bypass its exact-node direct-edge requirement in the Run’s immutable workflow version. Read permission never grants approval authority.',
    inputSchema: InteractionRespondInputSchema, outputSchema: InteractionRespondResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'interaction_respond', () => service.respond(context.principal, input)))
}
