import type { OpenCodeHarnessConfiguration } from '@graphql/contracts'
import { WORKER_NATIVE_OUTPUT_TOOL_NAMES, type WorkerNativeOutputOperation } from '@graphql/contracts/worker-native-output'
import { evaluateOpenCodePermission, nativeOpenCodeMcpToolName,
  type OpenCodePermissionEffect } from '../../harnesses/openCodePermissionPolicy.js'

/** MCP output calls do not expose host paths. Native permission patterns apply
 * to the tool's wildcard request, with the saved ordered policy unchanged. */
export function openCodeWorkflowOutputAllowed(configuration: OpenCodeHarnessConfiguration,
  operation: WorkerNativeOutputOperation): boolean {
  return openCodeWorkflowOutputPolicy(configuration, operation) !== 'deny'
}

export function openCodeWorkflowOutputPolicy(configuration: OpenCodeHarnessConfiguration,
  operation: WorkerNativeOutputOperation): OpenCodePermissionEffect {
  if (configuration.nativeAgent !== 'build' || configuration.advanced?.mcp.serverEnabled.graphql === false) return 'deny'
  const nativeTool = nativeOpenCodeMcpToolName(WORKER_NATIVE_OUTPUT_TOOL_NAMES[operation])
  return evaluateOpenCodePermission(nativeTool, '*', configuration.advanced?.permissionRules ?? [], 'allow')
}
