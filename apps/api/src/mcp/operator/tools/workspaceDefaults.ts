import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { ManagedWorkspaceDefaultsSchema, WorkspaceDefaultsUpdateInputSchema, WorkspaceDefaultsUpdateResultSchema } from '@foreman-code/contracts/management'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerWorkspaceDefaultsTools(server: McpServer, context: OperatorRequestContext): void {
  const settings = context.services.settings
  if (!settings) return
  if (operatorToolAvailable(context, 'workspace_defaults_get')) server.registerTool('workspace_defaults_get', {
    description: 'Read the default parentPath, suggested name and starting description for new workspaces. Pass parentPath to workspace_create to create a project folder. Reading defaults does not grant filesystem access.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedWorkspaceDefaultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'workspace_defaults_get', () => settings.getWorkspaceDefaults(context.principal)))
  if (operatorToolAvailable(context, 'workspace_defaults_update')) server.registerTool('workspace_defaults_update', {
    description: 'Revision-check and save workspace creation defaults. Existing workspaces, paths and grants are unchanged.',
    inputSchema: WorkspaceDefaultsUpdateInputSchema, outputSchema: WorkspaceDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workspace_defaults_update', () => settings.updateWorkspaceDefaults(context.principal, 'mcp', input)))
}
