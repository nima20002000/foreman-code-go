import type { McpServer } from '@modelcontextprotocol/server'

import {
  WorkspaceArchiveInputSchema, WorkspaceCreateInputSchema, WorkspaceGetInputSchema,
  WorkspaceListInputSchema, WorkspaceUpdateInputSchema,
  ManagedWorkspaceCommandResultSchema, ManagedWorkspacePageSchema, ManagedWorkspaceSchema,
} from '@graphql/contracts/management'
import { hasAction } from '../../../modules/access/policy.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorRequestContext } from '../types.js'

export function registerWorkspaceTools(server: McpServer, context: OperatorRequestContext): void {
  if (hasAction(context.principal, 'workspaces:read')) {
    server.registerTool('workspace_list', {
      description: 'List authorized workspaces with revisions and archive state.', inputSchema: WorkspaceListInputSchema,
      outputSchema: ManagedWorkspacePageSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => invokeOperatorTool(context, 'workspace_list', () => context.services.workspaces.list(context.principal, input)))
    server.registerTool('workspace_get', {
      description: 'Read an authorized workspace by stable ID.', inputSchema: WorkspaceGetInputSchema,
      outputSchema: ManagedWorkspaceSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => invokeOperatorTool(context, 'workspace_get', () => context.services.workspaces.get(context.principal, input.workspaceId)))
  }
  if (hasAction(context.principal, 'workspaces:create')) server.registerTool('workspace_create', {
    description: 'Create an empty durable workspace.', inputSchema: WorkspaceCreateInputSchema,
    outputSchema: ManagedWorkspaceCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workspace_create', () => context.services.workspaces.create(context.principal, 'mcp', input)))
  if (hasAction(context.principal, 'workspaces:update')) server.registerTool('workspace_update', {
    description: 'Revision-check and rename or describe a workspace.', inputSchema: WorkspaceUpdateInputSchema,
    outputSchema: ManagedWorkspaceCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workspace_update', () => context.services.workspaces.update(context.principal, 'mcp', input)))
  if (hasAction(context.principal, 'workspaces:archive')) server.registerTool('workspace_archive', {
    description: 'Archive a settled workspace while retaining its history.', inputSchema: WorkspaceArchiveInputSchema,
    outputSchema: ManagedWorkspaceCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workspace_archive', () => context.services.workspaces.archive(context.principal, 'mcp', input)))
}
