import type { McpServer } from '@modelcontextprotocol/server'
import {
  ClaudePluginListInputSchema, ClaudePluginListResultSchema,
  ClaudePluginChangeInputSchema, ClaudePluginChangeResultSchema,
  ClaudePluginMarketplaceAddInputSchema, ClaudePluginMarketplaceAddResultSchema,
} from '@foreman-code/contracts/management'
import type { OperatorRequestContext } from '../types.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'

export function registerClaudePluginTools(server: McpServer, context: OperatorRequestContext): void {
  const service = context.services.harnessSettings?.claudePlugins
  if (!service) return
  if (operatorToolAvailable(context, 'claude_plugins_list')) server.registerTool('claude_plugins_list', {
    description: 'List installed or available user-scope Claude Code plugins and marketplaces on Main. Supports search and pagination. Read the revision before changing plugins or adding a marketplace. Native Claude is the source of truth.',
    inputSchema: ClaudePluginListInputSchema, outputSchema: ClaudePluginListResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input, extra) => invokeOperatorTool(context, 'claude_plugins_list', () =>
    service.list(context.principal, input, extra.mcpReq.signal)))
  if (operatorToolAvailable(context, 'claude_plugin_change')) server.registerTool('claude_plugin_change', {
    description: 'Install, uninstall, enable or disable a user-scope Claude Code plugin on Main. Supply expectedRevision from claude_plugins_list and a stable commandId for retries; an uncertain result is checked again with the same ID without repeating the native command. A command_review result requires review of the displayed marketplace command; accept its hash with a new commandId. New Claude sessions use the changed plugins. Use computers_maintenance_start sync-plugins to copy Main plugins to paired computers.',
    inputSchema: ClaudePluginChangeInputSchema, outputSchema: ClaudePluginChangeResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, input => invokeOperatorTool(context, 'claude_plugin_change', () => service.change(context.principal, input, 'mcp')))
  if (operatorToolAvailable(context, 'claude_plugin_marketplace_add')) server.registerTool('claude_plugin_marketplace_add', {
    description: 'Add a Git/GitHub Claude Code plugin marketplace on Main. Supply expectedRevision from claude_plugins_list and a stable commandId for retries; uncertain results are checked again without repeating the addition. Local machine paths are unsupported. Returns the persisted marketplace list.',
    inputSchema: ClaudePluginMarketplaceAddInputSchema, outputSchema: ClaudePluginMarketplaceAddResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, input => invokeOperatorTool(context, 'claude_plugin_marketplace_add', () =>
    service.addMarketplace(context.principal, input, 'mcp')))
}
