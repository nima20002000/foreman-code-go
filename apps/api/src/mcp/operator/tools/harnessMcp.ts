import type { McpServer } from '@modelcontextprotocol/server'
import {
  HarnessMcpListInputSchema, HarnessMcpListResultSchema, HarnessMcpPlanInputSchema, HarnessMcpPlanResultSchema,
  HarnessMcpManagedInputSchema, HarnessMcpPlanGetInputSchema, HarnessMcpPlanSchema,
  CodexPluginListInputSchema, CodexPluginListResultSchema, CodexPluginGetInputSchema, CodexPluginDetailResultSchema,
} from '@graphql/contracts/management'
import type { OperatorRequestContext } from '../types.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'

/** These tools cannot approve a plan, access credentials, or run an installer. */
export function registerHarnessMcpTools(server: McpServer, context: OperatorRequestContext): void {
  const service = context.services.harnessSettings?.mcp
  if (!service) return
  if (context.services.harnessSettings?.plugins && operatorToolAvailable(context, 'codex_plugins_list')) server.registerTool('codex_plugins_list', {
    description: 'List installed or available Codex plugins with search and pagination. Native Codex is the source of truth. Plugin installation and removal are human-only because plugins can add hooks, skills, and external access.',
    inputSchema: CodexPluginListInputSchema, outputSchema: CodexPluginListResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input, extra) => invokeOperatorTool(context, 'codex_plugins_list', () => context.services.harnessSettings!.plugins!.list(context.principal, input, extra.mcpReq.signal)))
  if (context.services.harnessSettings?.plugins && operatorToolAvailable(context, 'codex_plugin_get')) server.registerTool('codex_plugin_get', {
    description: 'Read a Codex plugin and its verified bundled skills, hooks, and MCP server names when package contents are locally available. Unknown means bundle contents could not be verified, including unavailable, unreadable, or unsupported local contents. Plugin installation and removal require the signed-in human browser.',
    inputSchema: CodexPluginGetInputSchema, outputSchema: CodexPluginDetailResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input, extra) => invokeOperatorTool(context, 'codex_plugin_get', () => context.services.harnessSettings!.plugins!.get(context.principal, input.pluginId, extra.mcpReq.signal)))
  if (operatorToolAvailable(context, 'harness_mcp_servers_list')) server.registerTool('harness_mcp_servers_list', {
    description: 'List native user/inherited MCP connections for Codex or OpenCode. Returns no tokens or secret arguments. Configuration evidence is not live connection health.',
    inputSchema: HarnessMcpListInputSchema, outputSchema: HarnessMcpListResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => invokeOperatorTool(context, 'harness_mcp_servers_list', () => service.list(context.principal, input.harness)))
  if (operatorToolAvailable(context, 'harness_mcp_change_request')) server.registerTool('harness_mcp_change_request', {
    description: 'Request addition, removal, or enablement of a native MCP connection using the list revision and a stable commandId. A signed-in human must review it in Settings. Local programs must already be installed. This tool does not itself install packages. Do not put secrets in arguments. Protected App MCP changes and self-approval are refused.',
    inputSchema: HarnessMcpPlanInputSchema, outputSchema: HarnessMcpPlanResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => invokeOperatorTool(context, 'harness_mcp_change_request', () => service.plan(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'harness_mcp_managed_request')) server.registerTool('harness_mcp_managed_request', {
    description: 'Request installation, removal, disabling, or enabling of the exact Operator MCP or read-only Linear MCP preset. Supply either installed or enabled, the native revision, and a stable commandId. A signed-in human applies it in Harness Settings. Operator installation or repair installs the local launcher with automatic per-credential instance routing, preserving native tool and approval policies; a standard Linear endpoint can be explicitly converted to read-only. Customized and inherited entries cannot be changed here. This tool cannot approve or reconcile its own native writes.',
    inputSchema: HarnessMcpManagedInputSchema, outputSchema: HarnessMcpPlanResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => invokeOperatorTool(context, 'harness_mcp_managed_request', () => service.planManaged(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'harness_mcp_change_get')) server.registerTool('harness_mcp_change_get', {
    description: 'Read your own MCP change request. Pending requires human review. For uncertain writes, ask the signed-in owner to use Reconcile in MCP Settings. Refresh alone does not resolve them. Never resubmit an uncertain native write.',
    inputSchema: HarnessMcpPlanGetInputSchema, outputSchema: HarnessMcpPlanSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => invokeOperatorTool(context, 'harness_mcp_change_get', () => service.get(context.principal, input.planId)))
}
