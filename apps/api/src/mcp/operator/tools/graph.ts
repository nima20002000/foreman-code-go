import type { McpServer } from '@modelcontextprotocol/server'

import {
  GraphDraftApplyInputSchema, GraphDraftDiscardInputSchema, GraphDraftGetInputSchema,
  GraphDraftOpenInputSchema, GraphSaveInputSchema, GraphValidateInputSchema,
  GraphDraftCommandResultSchema, GraphDraftDiscardResultSchema, GraphDraftSchema,
  GraphSaveCommandResultSchema, GraphValidationResultSchema,
} from '@graphql/contracts/management'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerGraphTools(server: McpServer, context: OperatorRequestContext): void {
  if (operatorToolAvailable(context, 'graph_draft_open')) server.registerTool('graph_draft_open', {
    description: 'Open or return the one durable working draft for a workflow.', inputSchema: GraphDraftOpenInputSchema,
    outputSchema: GraphDraftSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'graph_draft_open', () => context.services.drafts.open(context.principal, input.workspaceId, input.workflowId)))
  if (operatorToolAvailable(context, 'graph_draft_get')) server.registerTool('graph_draft_get', {
    description: 'Read a durable graph draft at its current revision.', inputSchema: GraphDraftGetInputSchema,
    outputSchema: GraphDraftSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'graph_draft_get', () => context.services.drafts.get(context.principal, input.workspaceId, input.workflowId, input.draftId)))
  if (operatorToolAvailable(context, 'graph_validate')) server.registerTool('graph_validate', {
    description: 'Validate whether a durable draft can be saved as an executable version.', inputSchema: GraphValidateInputSchema,
    outputSchema: GraphValidationResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'graph_validate', () => context.services.drafts.validate(context.principal, input.workspaceId, input.workflowId, input.draftId)))
  if (operatorToolAvailable(context, 'graph_draft_apply')) server.registerTool('graph_draft_apply', {
    description: 'Atomically apply typed graph and workflow-setting operations to the expected draft revision. Supports approval routing, execution condition, execution limits, required agent count, agent configuration, prompts, nodes and edges. Changes are drafts until graph_save succeeds.', inputSchema: GraphDraftApplyInputSchema,
    outputSchema: GraphDraftCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'graph_draft_apply', () => context.services.drafts.apply(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'graph_draft_discard')) server.registerTool('graph_draft_discard', {
    description: 'Discard exactly the expected durable draft revision.', inputSchema: GraphDraftDiscardInputSchema,
    outputSchema: GraphDraftDiscardResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'graph_draft_discard', () => context.services.drafts.discard(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'graph_save')) server.registerTool('graph_save', {
    description: 'Atomically validate and save the expected draft as an immutable workflow version.', inputSchema: GraphSaveInputSchema,
    outputSchema: GraphSaveCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'graph_save', () => context.services.drafts.save(context.principal, 'mcp', input)))
}
