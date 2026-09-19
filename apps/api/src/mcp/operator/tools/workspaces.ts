import type { McpServer } from '@modelcontextprotocol/server'

import {
  WorkspaceArchiveInputSchema, WorkspaceCreateInputSchema, WorkspaceGetInputSchema,
  WorkspaceListInputSchema, WorkspaceUpdateInputSchema,
  ManagedWorkspaceCommandResultSchema, ManagedWorkspacePageSchema, ManagedWorkspaceSchema,
  WorkspaceLocationSetInputSchema, WorkspaceLocationSetResultSchema,
  WorkspaceLocationValidateInputSchema, WorkspaceLocationValidationSchema,
} from '@graphql/contracts/management'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerWorkspaceTools(server: McpServer, context: OperatorRequestContext): void {
  if (operatorToolAvailable(context, 'workspace_list')) server.registerTool('workspace_list', {
    description: 'List authorized workspaces with revisions and archive state.', inputSchema: WorkspaceListInputSchema,
    outputSchema: ManagedWorkspacePageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workspace_list', () => context.services.workspaces.list(context.principal, input)))
  if (operatorToolAvailable(context, 'workspace_get')) server.registerTool('workspace_get', {
    description: 'Read an authorized workspace by stable ID.', inputSchema: WorkspaceGetInputSchema,
    outputSchema: ManagedWorkspaceSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workspace_get', () => context.services.workspaces.get(context.principal, input.workspaceId)))
  if (operatorToolAvailable(context, 'workspace_create')) server.registerTool('workspace_create', {
    description: 'Create an empty durable workspace.', inputSchema: WorkspaceCreateInputSchema,
    outputSchema: ManagedWorkspaceCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workspace_create', () => context.services.workspaces.create(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workspace_update')) server.registerTool('workspace_update', {
    description: 'Revision-check and rename or describe a workspace.', inputSchema: WorkspaceUpdateInputSchema,
    outputSchema: ManagedWorkspaceCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workspace_update', () => context.services.workspaces.update(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workspace_archive')) server.registerTool('workspace_archive', {
    description: 'Archive a settled workspace while retaining its history.', inputSchema: WorkspaceArchiveInputSchema,
    outputSchema: ManagedWorkspaceCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workspace_archive', () => context.services.workspaces.archive(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workspace_location_validate')) server.registerTool('workspace_location_validate', {
    description: 'Validate an existing runner-owned directory without changing it or starting a harness.',
    inputSchema: WorkspaceLocationValidateInputSchema,
    outputSchema: WorkspaceLocationValidationSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => invokeOperatorTool(context, 'workspace_location_validate', () => context.services.locations.validate(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workspace_location_set')) server.registerTool('workspace_location_set', {
    description: 'Revision-check and save a validated canonical workspace execution location.',
    inputSchema: WorkspaceLocationSetInputSchema,
    outputSchema: WorkspaceLocationSetResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => invokeOperatorTool(context, 'workspace_location_set', () => context.services.locations.set(context.principal, 'mcp', input)))
}
