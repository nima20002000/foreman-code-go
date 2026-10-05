import type { McpServer } from '@modelcontextprotocol/server'
import { RespondToInteractionRequestSchema, RespondToInteractionResponseSchema } from '@graphql/contracts'
import {
  InteractionGetInputSchema,
  InteractionSummaryInputSchema, InteractionSummaryResultSchema,
  InteractionListInputSchema,
  ManagedInteractionPageSchema,
  ManagedInteractionSchema,
} from '@foreman-code/contracts/management'

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
    description: 'List authorized native interactions across User and Orchestrator handlers with scoped pending counts. This is read-only monitoring.',
    inputSchema: InteractionListInputSchema, outputSchema: ManagedInteractionPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'interaction_list', () => service.list(context.principal, input)))
  if (operatorToolAvailable(context, 'interaction_get')) server.registerTool('interaction_get', {
    description: 'Read one authorized native interaction and its review status, including canceled history. This is read-only monitoring.',
    inputSchema: InteractionGetInputSchema, outputSchema: ManagedInteractionSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'interaction_get', () => service.get(context.principal, input.interactionId)))
  if (operatorToolAvailable(context, 'interaction_respond')) server.registerTool('interaction_respond', {
    description: 'Respond to a user-handled native interaction using its offered option and revision. '
      + 'For questions or forms, supply response matching the option input schema. Requires scoped read and respond grants. '
      + 'Designated Orchestrator interactions remain assigned to their bound reviewer.',
    inputSchema: RespondToInteractionRequestSchema, outputSchema: RespondToInteractionResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'interaction_respond', () => service.respond(context.principal, input, 'mcp')))
}
