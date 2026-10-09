import type { McpServer } from '@modelcontextprotocol/server'
import { OperatorToolSchemaInputSchema, OperatorToolSchemaResultSchema } from '@foreman-code/contracts/operator-mcp'
import { DomainError } from '../../../modules/errors.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorCatalog } from '../presentation.js'
import type { OperatorRequestContext } from '../types.js'
import { operatorCapabilities } from './context.js'

export function registerToolSchemaLookup(
  server: McpServer, context: OperatorRequestContext, catalog?: OperatorCatalog,
): void {
  if (!operatorToolAvailable(context, 'operator_tool_schema_get')) return
  server.registerTool('operator_tool_schema_get', {
    description: 'Read one available Operator tool’s complete input schema, instructions and permission requirements. '
      + 'Requires capabilities:read and the target tool’s original discovery grants. '
      + 'Set includeOutputSchema:true for its output schema. This read never invokes the target operation.',
    inputSchema: OperatorToolSchemaInputSchema,
    outputSchema: OperatorToolSchemaResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, callbackContext) => invokeOperatorTool(context, 'operator_tool_schema_get', async () => {
    const tools = await catalog?.(callbackContext) ?? []
    const tool = tools.find((candidate) => candidate.name === input.name)
    if (!tool) throw new DomainError('ACCESS_DENIED', 'The requested tool is unavailable to this caller.', 403)
    const requirement = operatorCapabilities(context, {}).requirements.find((entry) => entry.name === input.name)
    return {
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
      ...(input.includeOutputSchema && tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      permissionRequirements: {
        ...(requirement ? { actions: requirement.actions } : {}),
        detail: [tool.description, requirement?.detail].filter(Boolean).join(' '),
      },
    }
  }))
}
