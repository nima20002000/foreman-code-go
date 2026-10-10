import type { McpServer } from '@modelcontextprotocol/server'
import { RespondToInteractionRequestSchema, RespondToInteractionResponseSchema } from '@foreman-code/contracts'
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
    description: 'Read pending approval and workflow direction counts over authorized scopes and the optional handler filter; no decision authority is granted.',
    inputSchema: InteractionSummaryInputSchema, outputSchema: InteractionSummaryResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'interaction_summary', () => service.summary(context.principal, input)))
  if (operatorToolAvailable(context, 'interaction_list')) server.registerTool('interaction_list', {
    description: 'List authorized native approvals and owner-handled workflow direction waits with scoped pending counts. Direction waits offer finish with findings, continue in a new Run, or stop.',
    inputSchema: InteractionListInputSchema, outputSchema: ManagedInteractionPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'interaction_list', () => service.list(context.principal, input)))
  if (operatorToolAvailable(context, 'interaction_get')) server.registerTool('interaction_get', {
    description: 'Read one authorized approval or workflow direction interaction, its offered choices and response availability, including canceled history.',
    inputSchema: InteractionGetInputSchema, outputSchema: ManagedInteractionSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'interaction_get', () => service.get(context.principal, input.interactionId)))
  if (operatorToolAvailable(context, 'interaction_respond')) server.registerTool('interaction_respond', {
    description: 'Respond to a user-handled approval or workflow direction interaction using its offered option and revision. '
      + 'For questions or forms, supply response matching the option input schema. Requires scoped read and respond grants. '
      + 'Direction finish accepts the recorded findings; continue requires direction and runs:start, workflows:read and workspace_locations:read grants; stop requires runs:stop. '
      + 'Designated Orchestrator interactions remain assigned to their bound reviewer.',
    inputSchema: RespondToInteractionRequestSchema, outputSchema: RespondToInteractionResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'interaction_respond', () => service.respond(context.principal, input, 'mcp')))
}
