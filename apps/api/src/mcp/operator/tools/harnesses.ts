import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import {
  HarnessCatalogEntrySchema, HarnessCatalogResultSchema, HarnessDefaultsUpdateInputSchema,
  HarnessDefaultsUpdateResultSchema, HarnessGetInputSchema,
} from '@graphql/contracts/management'
import { hasAction } from '../../../modules/access/policy.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorRequestContext } from '../types.js'

export function registerHarnessTools(server: McpServer, context: OperatorRequestContext): void {
  if (hasAction(context.principal, 'harnesses:read')) {
    server.registerTool('harness_list', {
      description: 'List qualified local harness capabilities and saved defaults.', inputSchema: z.object({}).strict(),
      outputSchema: HarnessCatalogResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => invokeOperatorTool(context, 'harness_list', async () => ({ items: await context.services.harnesses.list(context.principal) })))
    server.registerTool('harness_get', {
      description: 'Read one qualified harness capability and its saved defaults.', inputSchema: HarnessGetInputSchema,
      outputSchema: HarnessCatalogEntrySchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => invokeOperatorTool(context, 'harness_get', () => context.services.harnesses.get(context.principal, input.harness)))
  }
  if (hasAction(context.principal, 'harnesses:update')) {
    server.registerTool('harness_defaults_update', {
      description: 'Revision-check and replace defaults copied into future board agents.', inputSchema: HarnessDefaultsUpdateInputSchema,
      outputSchema: HarnessDefaultsUpdateResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => invokeOperatorTool(context, 'harness_defaults_update', () => context.services.harnesses.updateDefaults(context.principal, 'mcp', input)))
  }
}
