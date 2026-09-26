import type { McpServer } from '@modelcontextprotocol/server'

import {
  WorkflowBatchArchiveInputSchema, WorkflowBatchArchiveResultSchema,
  WorkflowArchiveInputSchema, WorkflowCreateInputSchema, WorkflowGetInputSchema,
  WorkflowListInputSchema, WorkflowUpdateInputSchema,
  ManagedWorkflowCommandResultSchema, ManagedWorkflowPageSchema, ManagedWorkflowSchema,
} from '@graphql/contracts/management'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerWorkflowTools(server: McpServer, context: OperatorRequestContext): void {
  if (operatorToolAvailable(context, 'workflow_list')) server.registerTool('workflow_list', {
    description: 'List one cursor page of authorized workflows, including empty workflows. Pass pageInfo.nextCursor as cursor to load more; null means the end.', inputSchema: WorkflowListInputSchema,
    outputSchema: ManagedWorkflowPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_list', () => context.services.workflows.list(context.principal, input)))
  if (operatorToolAvailable(context, 'workflow_get')) server.registerTool('workflow_get', {
    description: 'Read a workflow and its current saved version reference.', inputSchema: WorkflowGetInputSchema,
    outputSchema: ManagedWorkflowSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_get', () => context.services.workflows.get(context.principal, input.workspaceId, input.workflowId)))
  if (operatorToolAvailable(context, 'workflow_create')) server.registerTool('workflow_create', {
    description: 'Create a named durable workflow using global workflow defaults. It inherits the workspace execution folder; do not configure a separate workflow path.', inputSchema: WorkflowCreateInputSchema,
    outputSchema: ManagedWorkflowCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_create', () => context.services.workflows.create(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workflow_update')) server.registerTool('workflow_update', {
    description: 'Revision-check and rename or describe a workflow. For workflow settings, open a graph draft, apply workflow.set_approval, workflow.set_execution_condition, workflow.set_execution_limits or workflow.set_required_agent_count, then graph_save. Global workflow_defaults_update affects only future workflows.', inputSchema: WorkflowUpdateInputSchema,
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
