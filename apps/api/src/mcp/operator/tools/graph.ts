import type { McpServer } from '@modelcontextprotocol/server'

import {
  GraphDraftApplyInputSchema, GraphDraftDiscardInputSchema, GraphDraftGetInputSchema,
  GraphDraftOpenInputSchema, GraphSaveInputSchema, GraphValidateInputSchema,
  GraphDraftCommandResultSchema, GraphDraftDiscardResultSchema, GraphDraftSchema,
  GraphSaveCommandResultSchema, GraphValidationResultSchema,
} from '@graphql/contracts/management'
import { GraphDraftApplyV2InputSchema, GraphDraftV2Schema, GraphDraftCommandV2ResultSchema, GraphSaveV2InputSchema, GraphSaveCommandV2ResultSchema } from '@graphql/contracts/wave25'
import { GraphEditReadInputSchema, GraphEditReadResultSchema, GraphEditStageInputSchema, GraphEditAdvanceInputSchema, GraphEditDiscardInputSchema } from '@graphql/contracts/wave25'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'
import { approvalDraftToolDescription } from '../../../modules/workflows/approvalMcpMetadata.js'

export function registerGraphTools(server: McpServer, context: OperatorRequestContext): void {
  if (operatorToolAvailable(context, 'graph_draft_open')) server.registerTool('graph_draft_open', {
    description: 'Open or return the one durable working draft for a workflow.', inputSchema: GraphDraftOpenInputSchema,
    outputSchema: GraphDraftSchema.or(GraphDraftV2Schema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'graph_draft_open', () => context.services.drafts.open(context.principal, input.workspaceId, input.workflowId)))
  if (operatorToolAvailable(context, 'graph_draft_get')) server.registerTool('graph_draft_get', {
    description: 'Read the shared durable draft. With action: read_edits, read your principal/scope-bound private staged payload, exact affected Run/version plan, Stop/save command identities, persisted receipts and current settlement. Omit intentId to recover your unresolved intent after refresh/reopen. Requires graph:read plus agents:read for staged Agent content and runs:read for every affected scope; never returns another principal’s intent.', inputSchema: GraphEditReadInputSchema.or(GraphDraftGetInputSchema),
    outputSchema: GraphEditReadResultSchema.or(GraphDraftSchema).or(GraphDraftV2Schema),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'graph_draft_get', async () => 'action' in input ? context.services.drafts.editIntents.read(context.principal, input) : context.services.drafts.get(context.principal, input.workspaceId, input.workflowId, input.draftId)))
  if (operatorToolAvailable(context, 'graph_validate')) server.registerTool('graph_validate', {
    description: 'Validate draft executability. This does not reserve publication; graph_save separately rechecks live authority, revisions and all affected Run settlement.', inputSchema: GraphValidateInputSchema,
    outputSchema: GraphValidationResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'graph_validate', () => context.services.drafts.validate(context.principal, input.workspaceId, input.workflowId, input.draftId)))
  if (operatorToolAvailable(context, 'graph_draft_apply')) server.registerTool('graph_draft_apply', {
    description: `Atomically apply typed graph and workflow-setting operations to the expected draft revision. Supports approval routing, execution condition, execution limits, required agent count, agent configuration, prompts, nodes and edges. Use executionSemanticsVersion: 2 for explicit workflow.set_entry, node.set_choice, and typed relationship.put. Meaningful changes are drafts until graph_save succeeds. A layout-only node.move preserves a clean draft publication watermark and does not create an executable version. ${approvalDraftToolDescription}`, inputSchema: GraphDraftApplyInputSchema.or(GraphDraftApplyV2InputSchema),
    outputSchema: GraphDraftCommandResultSchema.or(GraphDraftCommandV2ResultSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'graph_draft_apply', () => context.services.drafts.apply(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'graph_draft_discard')) server.registerTool('graph_draft_discard', {
    description: 'With action: discard_edits, discard only your exact private intent using its persisted discardCommandId. Never issues Stop, mutates the shared draft, or erases layout. An uncertain save must first be reconciled; submitted Stop effects cannot be undone. Without action, retain the original expected-revision shared-draft discard contract.', inputSchema: GraphEditDiscardInputSchema.or(GraphDraftDiscardInputSchema),
    outputSchema: GraphEditReadResultSchema.or(GraphDraftDiscardResultSchema),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'graph_draft_discard', async () => 'action' in input ? context.services.drafts.editIntents.discard(context.principal, 'mcp', input) : context.services.drafts.discard(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'graph_save')) server.registerTool('graph_save', {
    description: 'Atomically validate the exact draft revision. Unchanged executable meaning and configuration pins reuse the immutable version, including layout-only saves. Meaningful publication fails with WORKFLOW_RUNS_UNSETTLED while any Run of this workflow, or any workspace Run pinned to an existing staged Agent being changed, is active or has outstanding cleanup, interaction or review obligations. Without an action, no Stop or replacement Start is performed. Use existing run_stop only with explicit authority and retain its exact command ID on uncertainty; accepted is not settled. Reconcile uncertain graph_save using the same command ID and input. All authority, revision, version and concurrent Start fences are checked at publication. To use the full Stop-and-save protocol, first supply action: stage_edits with the exact draft/base pins and typed operations; this persists a private immutable payload and complete affected-set plan without Stop or shared-draft writes. Then explicitly invoke action: stop_and_save using the returned intentId and advanceCommandId. This stops only planned unsettled Runs through run_stop and waits for terminal, native, interaction, review and cleanup settlement before the shared save service publishes once. Repeat the SAME action/command after uncertain replies, including refresh/reopen. Natural completion remains natural; no automatic Start occurs. Staging/advance require graph:read, graph:edit, graph:save, agents:read for Agent content and runs:read across the affected set. Actual Stop additionally requires runs:stop for every unsettled affected Run; shared Agent edits retain cross-workflow graph grants. Read back using graph_draft_get action: read_edits. Discard via graph_draft_discard action: discard_edits.', inputSchema: GraphEditStageInputSchema.or(GraphEditAdvanceInputSchema).or(GraphSaveInputSchema).or(GraphSaveV2InputSchema),
    outputSchema: GraphEditReadResultSchema.or(GraphSaveCommandResultSchema).or(GraphSaveCommandV2ResultSchema),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'graph_save', async () => {
    if ('action' in input) return input.action === 'stage_edits'
      ? context.services.drafts.editIntents.stage(context.principal, 'mcp', input)
      : context.services.drafts.editIntents.advance(context.principal, 'mcp', input, context.services.runs.stop.bind(context.services.runs))
    return context.services.drafts.save(context.principal, 'mcp', input)
  }))
}
