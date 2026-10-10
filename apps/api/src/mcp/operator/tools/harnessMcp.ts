import type { McpServer } from '@modelcontextprotocol/server'
import {
  HarnessMcpListInputSchema, HarnessMcpListResultSchema, HarnessMcpPlanInputSchema, HarnessMcpPlanResultSchema,
  HarnessMcpManagedInputSchema, HarnessMcpPlanGetInputSchema, HarnessMcpPlanSchema, HarnessMcpReconcileInputSchema,
  CodexPluginListInputSchema, CodexPluginListResultSchema, CodexPluginGetInputSchema, CodexPluginDetailResultSchema,
  CodexPluginChangeInputSchema, CodexPluginChangeResultSchema, CodexPluginReconcileInputSchema,
} from '@foreman-code/contracts/management'
import type { OperatorRequestContext } from '../types.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'

/** Native MCP connections and Codex plugins: the Operator applies changes directly (owner decision: no human gate).
 * Tools never read credentials; uncertain native writes are reconciled, never replayed. */
export function registerHarnessMcpTools(server: McpServer, context: OperatorRequestContext): void {
  const service = context.services.harnessSettings?.mcp
  if (!service) return
  if (context.services.harnessSettings?.plugins && operatorToolAvailable(context, 'codex_plugins_list')) server.registerTool('codex_plugins_list', {
    description: 'List installed or available Codex plugins with search and pagination. Set refresh true to await a current native catalog instead of a cached observation. Native Codex is the source of truth. Install or remove one with codex_plugin_change. Plugins can add hooks, skills, and external access.',
    inputSchema: CodexPluginListInputSchema, outputSchema: CodexPluginListResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input, extra) => invokeOperatorTool(context, 'codex_plugins_list', () => context.services.harnessSettings!.plugins!.list(context.principal, input, extra.mcpReq.signal)))
  if (context.services.harnessSettings?.plugins && operatorToolAvailable(context, 'codex_plugin_get')) server.registerTool('codex_plugin_get', {
    description: 'Read a Codex plugin and its verified bundled skills, hooks, and MCP server names when package contents are locally available. Set refresh true to await the current native catalog. Unknown means bundle contents could not be verified, including unavailable, unreadable, or unsupported local contents. Install or remove it with codex_plugin_change.',
    inputSchema: CodexPluginGetInputSchema, outputSchema: CodexPluginDetailResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input, extra) => invokeOperatorTool(context, 'codex_plugin_get', () => context.services.harnessSettings!.plugins!.get(context.principal, input.pluginId, { signal: extra.mcpReq.signal, refresh: input.refresh })))
  if (operatorToolAvailable(context, 'harness_mcp_servers_list')) server.registerTool('harness_mcp_servers_list', {
    description: 'List native user/inherited MCP connections for Codex. Unchanged user configuration is cached for at most five minutes; expired reads wait for inspection and report failures. Returns no tokens or secret arguments. Configuration evidence is not live connection health.',
    inputSchema: HarnessMcpListInputSchema, outputSchema: HarnessMcpListResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => invokeOperatorTool(context, 'harness_mcp_servers_list', () => service.list(context.principal, input.harness)))
  if (operatorToolAvailable(context, 'harness_mcp_change_request')) server.registerTool('harness_mcp_change_request', {
    description: 'Add, remove, or enable/disable a native MCP connection and apply it now, using the list revision and a stable commandId. Local programs must already be installed; this tool does not install packages. Do not put secrets in arguments. Protected App MCP entries are changed with harness_mcp_managed_request. Returns the applied plan; status uncertain means use harness_mcp_change_reconcile, never resubmit. Reuse the same commandId to retry a busy or lost response.',
    inputSchema: HarnessMcpPlanInputSchema, outputSchema: HarnessMcpPlanSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => invokeOperatorTool(context, 'harness_mcp_change_request', () => service.applyChange(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'harness_mcp_managed_request')) server.registerTool('harness_mcp_managed_request', {
    description: 'Request installation, removal, disabling, or enabling of the exact Foreman Code MCP (foreman-code, with existing graphql entries supported; one connection for Operator, Orchestrator and Coder credentials) or read-only Linear MCP preset. Supply either installed or enabled, the native revision, and a stable commandId. Applies it now. Foreman Code MCP installation or repair installs the local launcher with automatic per-credential instance routing, preserving native tool, approval and disabled policies, and removes retired graphql-app/graphql-operator entries in the same write; a standard Linear endpoint can be explicitly converted to read-only. Customized and inherited entries cannot be changed here. Status uncertain means use harness_mcp_change_reconcile, never resubmit.',
    inputSchema: HarnessMcpManagedInputSchema, outputSchema: HarnessMcpPlanSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => invokeOperatorTool(context, 'harness_mcp_managed_request', () => service.applyManaged(context.principal, input, 'mcp')))
  if (operatorToolAvailable(context, 'harness_mcp_change_get')) server.registerTool('harness_mcp_change_get', {
    description: 'Read your own MCP change. Pending means it was not applied yet (busy or expired); retry the original command. For an uncertain write use harness_mcp_change_reconcile. Never resubmit an uncertain native write.',
    inputSchema: HarnessMcpPlanGetInputSchema, outputSchema: HarnessMcpPlanSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => invokeOperatorTool(context, 'harness_mcp_change_get', () => service.get(context.principal, input.planId)))
  if (operatorToolAvailable(context, 'harness_mcp_change_reconcile')) server.registerTool('harness_mcp_change_reconcile', {
    description: 'Settle a submitting or uncertain native MCP write by inspecting the current native configuration at expectedRevision. Never repeats the write. Set acceptObservedState to record the current configuration when the original result cannot be proven. Reuse commandId to retry.',
    inputSchema: HarnessMcpReconcileInputSchema, outputSchema: HarnessMcpPlanResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => invokeOperatorTool(context, 'harness_mcp_change_reconcile', () => service.reconcile(context.principal, input, 'mcp')))
  if (context.services.harnessSettings?.plugins && operatorToolAvailable(context, 'codex_plugin_change')) server.registerTool('codex_plugin_change', {
    description: 'Install or remove one Codex plugin now. Use the revision and artifactIdentity from codex_plugins_list/codex_plugin_get and a stable commandId; the same commandId never repeats a native command. Status uncertain means use codex_plugin_reconcile.',
    inputSchema: CodexPluginChangeInputSchema, outputSchema: CodexPluginChangeResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => invokeOperatorTool(context, 'codex_plugin_change', () => context.services.harnessSettings!.plugins!.change(context.principal, input, 'mcp')))
  if (context.services.harnessSettings?.plugins && operatorToolAvailable(context, 'codex_plugin_reconcile')) server.registerTool('codex_plugin_reconcile', {
    description: 'Settle an uncertain Codex plugin change by reading the native plugin state. Never repeats the install or removal.',
    inputSchema: CodexPluginReconcileInputSchema, outputSchema: CodexPluginChangeResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => invokeOperatorTool(context, 'codex_plugin_reconcile', () => context.services.harnessSettings!.plugins!.reconcile(context.principal, input, 'mcp')))
}
