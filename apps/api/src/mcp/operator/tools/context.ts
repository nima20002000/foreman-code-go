import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { OperatorCapabilitiesSchema } from '@graphql/contracts/management'

import { hasAction } from '../../../modules/access/policy.js'
import { invokeOperatorTool } from '../invoke.js'
import { OPERATOR_TOOL_ACTIONS } from '../catalog.js'
import type { OperatorRequestContext } from '../types.js'

export function registerContextTools(server: McpServer, context: OperatorRequestContext): void {
  if (!hasAction(context.principal, 'capabilities:read')) return
  server.registerTool('operator_get_capabilities', {
    description: 'List the Operator operations currently permitted for this authenticated caller.',
    inputSchema: z.object({}).strict(),
    outputSchema: OperatorCapabilitiesSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'operator_get_capabilities', async () => ({
    endpoint: '/mcp/operator', audience: 'operator', protocol: '2026-07-28',
    tools: OPERATOR_TOOL_ACTIONS.filter((item) => hasAction(context.principal, item.action)).map((item) => item.name),
    workerToolsMcp: { implemented: false, endpoint: '/mcp/tools' },
  })))
}
