import type { OpenCodeHarnessConfiguration } from '@foreman-code/contracts'
import { WORKER_NATIVE_OUTPUT_TOOL_NAMES, type WorkerNativeOutputOperation } from '@foreman-code/contracts/worker-native-output'
import { APP_MCP_SERVER_NAMES } from '@foreman-code/contracts/product'
import { evaluateOpenCodePermission, nativeOpenCodeMcpToolName,
  type OpenCodePermissionEffect } from '../../harnesses/openCodePermissionPolicy.js'

/** MCP output calls do not expose host paths. Native permission patterns apply
 * to the tool's wildcard request, with the saved ordered policy unchanged. */
export function openCodeWorkflowOutputAllowed(configuration: OpenCodeHarnessConfiguration,
  operation: WorkerNativeOutputOperation): boolean {
  return APP_MCP_SERVER_NAMES.some(serverName => openCodeWorkflowOutputPolicy(configuration, operation,
    nativeOpenCodeMcpToolName(WORKER_NATIVE_OUTPUT_TOOL_NAMES[operation], serverName)) !== 'deny')
}

export function openCodeWorkflowOutputPolicy(configuration: OpenCodeHarnessConfiguration,
  operation: WorkerNativeOutputOperation,
  nativeTool = nativeOpenCodeMcpToolName(WORKER_NATIVE_OUTPUT_TOOL_NAMES[operation])): OpenCodePermissionEffect {
  const serverName = APP_MCP_SERVER_NAMES.find(name =>
    nativeOpenCodeMcpToolName(WORKER_NATIVE_OUTPUT_TOOL_NAMES[operation], name) === nativeTool)
  if (!serverName || configuration.nativeAgent !== 'build'
    || configuration.advanced?.mcp.serverEnabled[serverName] === false) return 'deny'
  return evaluateOpenCodePermission(nativeTool, '*', configuration.advanced?.permissionRules ?? [], 'allow')
}
