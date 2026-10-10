import { CurrentWorkflowCreateInputSchema } from '@foreman-code/contracts/wave25'
import { registerCurrentWorkflowTools } from './currentWorkflow.js'
import { SavedManagedWorkflowCommandResultSchema as ManagedWorkflowCommandResultSchema,
  SavedManagedWorkflowPageSchema as ManagedWorkflowPageSchema, SavedManagedWorkflowSchema as ManagedWorkflowSchema } from '@foreman-code/contracts/wave25'
import type { McpServer } from '@modelcontextprotocol/server'

import {
  WorkflowBatchArchiveInputSchema, WorkflowBatchArchiveResultSchema,
  WorkflowArchiveInputSchema, WorkflowGetInputSchema,
  WorkflowUpdateInputSchema,
} from '@foreman-code/contracts/management'
import { OperatorWorkflowListInputSchema, WorkflowSummaryPageSchema } from '@foreman-code/contracts/operator-mcp'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerWorkflowTools(server: McpServer, context: OperatorRequestContext): void {
  registerCurrentWorkflowTools(server, context)
  if (operatorToolAvailable(context, 'workflow_list')) server.registerTool('workflow_list', {
    description: 'List authorized workflow summaries, including empty workflows (10 by default). Use detail:full or workflow_get for the saved definition. Pass pageInfo.nextCursor as cursor; null means the end.', inputSchema: OperatorWorkflowListInputSchema,
    outputSchema: WorkflowSummaryPageSchema.or(ManagedWorkflowPageSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ detail, ...input }) => invokeOperatorTool(context, 'workflow_list', async () => {
    const page = await context.services.workflows.list(context.principal, input)
    if (detail === 'full') return page
    return { detail: 'compact', pageInfo: page.pageInfo, items: page.items.map(({ workflow, ...item }) => ({
      ...item, workflow: { id: workflow.id, workspaceId: workflow.workspaceId, name: workflow.name },
      detailsOmitted: true,
    })) }
  }))
  if (operatorToolAvailable(context, 'workflow_get')) server.registerTool('workflow_get', {
    description: 'Read a workflow and its current saved version reference.', inputSchema: WorkflowGetInputSchema,
    outputSchema: ManagedWorkflowSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_get', () => context.services.workflows.get(context.principal, input.workspaceId, input.workflowId)))
  if (operatorToolAvailable(context, 'workflow_create')) server.registerTool('workflow_create', {
    description: 'Create a named semantics-3 workflow using global workflow defaults. '
      + 'Omit initialSave for an unsaved workflow, or provide initialSave '
      + '{graph, expectedAgentConfigurationVersionIds, expectedLocationRevision} to atomically create and save. '
      + 'The graph omits workflow identity, name, description, defaultWorktree and timestamps; '
      + 'creation supplies those fields. Invalid graphs or stale pins leave no workflow. '
      + 'Initial save additionally requires workflows:read/update, graph:read/edit/save, agents:read '
      + 'and workspace_locations:read, and referenced skill/harness/source grants, '
      + 'scoped to the workspace without workflow-ID restrictions. '
      + 'Read back with workflow_saved_get_v3; retry the same commandId and input after an uncertain reply. '
      + 'Use workflow_validate_v3 and workflow_save_v3 for later graph edits, with or without repeat. '
      + 'Omit defaultWorktree to copy the ready workspace project root; pass null to opt out '
      + 'or {rootBinding,branchPrefix?} to select an approved immutable Git source. '
      + 'Worktree selection requires sources:read, source_roots:read and workspace_locations:read. '
      + 'Agents inherit that root unless node.placement overrides it; each writable execution gets '
      + 'its own directory and uniquely suffixed branch.',
    inputSchema: CurrentWorkflowCreateInputSchema,
    outputSchema: ManagedWorkflowCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_create', () => context.services.workflows.create(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workflow_update')) server.registerTool('workflow_update', {
    description: 'Revision-check and rename or describe a workflow. For current graph and workflow settings use workflow_validate_v3 and workflow_save_v3 with exact pins; unresolved staged edits require their existing Stop-and-save/Discard protocol. Global workflow_defaults_update affects only future workflows.', inputSchema: WorkflowUpdateInputSchema,
    outputSchema: ManagedWorkflowCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_update', () => context.services.workflows.update(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workflow_batch_archive')) server.registerTool('workflow_batch_archive', {
    description: 'Atomically delete (archive) 1–100 selected workflows, retaining versions and runs. Requires archive permission for every workflow and its expected revision. Active runs or any conflict reject the entire batch. Retry an uncertain outcome with the same commandId and input.',
    inputSchema: WorkflowBatchArchiveInputSchema, outputSchema: WorkflowBatchArchiveResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_batch_archive', () => context.services.workflows.archiveBatch(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workflow_archive')) server.registerTool('workflow_archive', {
    description: 'Archive a settled workflow while retaining versions and runs.', inputSchema: WorkflowArchiveInputSchema,
    outputSchema: ManagedWorkflowCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_archive', () => context.services.workflows.archive(context.principal, 'mcp', input)))
}
