import type { McpServer } from '@modelcontextprotocol/server'
import {
  InteractionGetInputSchema,
  InteractionListInputSchema,
  InteractionRespondInputSchema,
  InteractionRespondResultSchema,
  ManagedInteractionPageSchema,
  ManagedInteractionSchema,
} from '@graphql/contracts/management'

import { hasAction } from '../../../modules/access/policy.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorRequestContext } from '../types.js'

export function registerInteractionTools(server: McpServer, context: OperatorRequestContext): void {
  const service = context.services.interactions
  if (!service) return
  if (hasAction(context.principal, 'interactions:read')) {
    server.registerTool('interaction_list', {
      description: 'List authorized durable native approval interactions assigned to Operator.',
      inputSchema: InteractionListInputSchema, outputSchema: ManagedInteractionPageSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => invokeOperatorTool(context, 'interaction_list', () => service.list(context.principal, input)))
    server.registerTool('interaction_get', {
      description: 'Read one authorized Operator-assigned native approval interaction.',
      inputSchema: InteractionGetInputSchema, outputSchema: ManagedInteractionSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => invokeOperatorTool(context, 'interaction_get', () => service.get(context.principal, input.interactionId)))
  }
  if (hasAction(context.principal, 'interactions:respond')) {
    server.registerTool('interaction_respond', {
      description: 'Choose one server-generated opaque response option for an Operator-assigned native request.',
      inputSchema: InteractionRespondInputSchema, outputSchema: InteractionRespondResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async (input) => invokeOperatorTool(context, 'interaction_respond', () => service.respond(context.principal, input)))
  }
}
