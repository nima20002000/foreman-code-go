import type { McpServer } from '@modelcontextprotocol/server'

import {
  WorkflowArchiveInputSchema, WorkflowCreateInputSchema, WorkflowGetInputSchema,
  WorkflowListInputSchema, WorkflowUpdateInputSchema,
  ManagedWorkflowCommandResultSchema, ManagedWorkflowPageSchema, ManagedWorkflowSchema,
} from '@graphql/contracts/management'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerWorkflowTools(server: McpServer, context: OperatorRequestContext): void {
  if (operatorToolAvailable(context, 'workflow_list')) server.registerTool('workflow_list', {
    description: 'List authorized workflows, including empty workflows.', inputSchema: WorkflowListInputSchema,
    outputSchema: ManagedWorkflowPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_list', () => context.services.workflows.list(context.principal, input)))
  if (operatorToolAvailable(context, 'workflow_get')) server.registerTool('workflow_get', {
    description: 'Read a workflow and its current saved version reference.', inputSchema: WorkflowGetInputSchema,
    outputSchema: ManagedWorkflowSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_get', () => context.services.workflows.get(context.principal, input.workspaceId, input.workflowId)))
  if (operatorToolAvailable(context, 'workflow_create')) server.registerTool('workflow_create', {
    description: 'Create a named durable empty workflow.', inputSchema: WorkflowCreateInputSchema,
    outputSchema: ManagedWorkflowCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_create', () => context.services.workflows.create(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workflow_update')) server.registerTool('workflow_update', {
    description: 'Revision-check and rename or describe a workflow without saving its graph.', inputSchema: WorkflowUpdateInputSchema,
    outputSchema: ManagedWorkflowCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_update', () => context.services.workflows.update(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workflow_archive')) server.registerTool('workflow_archive', {
    description: 'Archive a settled workflow while retaining versions and runs.', inputSchema: WorkflowArchiveInputSchema,
    outputSchema: ManagedWorkflowCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_archive', () => context.services.workflows.archive(context.principal, 'mcp', input)))
}
