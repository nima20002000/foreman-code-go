import type { McpServer } from '@modelcontextprotocol/server'
import {
  HarnessMcpListInputSchema, HarnessMcpListResultSchema, HarnessMcpPlanInputSchema, HarnessMcpPlanResultSchema,
  HarnessMcpManagedInputSchema, HarnessMcpPlanGetInputSchema, HarnessMcpPlanSchema,
} from '@graphql/contracts/management'
import type { OperatorRequestContext } from '../types.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'

/** These tools cannot approve a plan, access credentials, or run an installer. */
export function registerHarnessMcpTools(server: McpServer, context: OperatorRequestContext): void {
  const service = context.services.harnessSettings?.mcp
  if (!service) return
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
    description: 'Request installation, removal, disabling, or enabling of the exact server-managed Operator MCP or read-only Linear MCP preset for Codex or OpenCode. Supply either installed or enabled, the native list revision, and a stable commandId. A signed-in human must apply the request in Harness Settings. This tool cannot approve its own MCP access or change a mismatched/inherited entry.',
    inputSchema: HarnessMcpManagedInputSchema, outputSchema: HarnessMcpPlanResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => invokeOperatorTool(context, 'harness_mcp_managed_request', () => service.planManaged(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'harness_mcp_change_get')) server.registerTool('harness_mcp_change_get', {
    description: 'Read your own MCP change request. Pending requires human review; uncertain must be inspected, never resubmitted as a delivery retry.',
    inputSchema: HarnessMcpPlanGetInputSchema, outputSchema: HarnessMcpPlanSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => invokeOperatorTool(context, 'harness_mcp_change_get', () => service.get(context.principal, input.planId)))
}
