import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  RUN_GRAPH_MCP_TOOLS, RunGraphReadRequestSchema, RunGraphEventsRequestSchema,
  RunGraphSnapshotSchema, RunGraphEventsResponseSchema, RunGraphCapabilitiesSchema,
} from '@graphql/contracts/wave25'
import type { OperatorRequestContext } from '../types.js'
import type { RunGraphReadApi } from '../../../modules/run-graph/readService.js'
import { RunGraphError, runGraphErrorResponse } from '../../../modules/run-graph/errors.js'

/** New versioned tools; do not widen strict legacy capability/catalog enums. */
export function registerRunGraphTools(server: McpServer, context: OperatorRequestContext, reads: RunGraphReadApi): void {
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  const invoke = async (name: string, work: () => Promise<unknown> | unknown) => {
    try {
      const value = await work()
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> }
    } catch (error) {
      const safe = error instanceof RunGraphError ? error : new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      if (safe.code === 'GRAPH_READ_ACCESS_DENIED') await context.services.commands.recordDenied(
        context.principal.id, 'mcp', safe.code, `mcp:${name}`).catch(() => undefined)
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(runGraphErrorResponse(safe)) }] }
    }
  }
  server.registerTool(RUN_GRAPH_MCP_TOOLS.capabilities, {
    description: 'Read graph v1 capabilities, including the source-controlled v2 authoring and new-Run admission state.',
    inputSchema: z.object({}).strict(), outputSchema: RunGraphCapabilitiesSchema, annotations,
  }, async () => invoke(RUN_GRAPH_MCP_TOOLS.capabilities, () => reads.capabilities(context.principal)))
  server.registerTool(RUN_GRAPH_MCP_TOOLS.snapshot, {
    description: 'Read a coherent, bounded graph snapshot for the exact authorized workspace/workflow/Run/version. No native bodies or filesystem details.',
    inputSchema: RunGraphReadRequestSchema, outputSchema: RunGraphSnapshotSchema, annotations,
  }, async (input) => invoke(RUN_GRAPH_MCP_TOOLS.snapshot, () => reads.snapshot(context.principal, input)))
  server.registerTool(RUN_GRAPH_MCP_TOOLS.events, {
    description: 'Read complete semantic batches after an exact decimal cursor, or an explicit reset. Never advance past throughSequence.',
    inputSchema: RunGraphEventsRequestSchema, outputSchema: RunGraphEventsResponseSchema, annotations,
  }, async (input) => invoke(RUN_GRAPH_MCP_TOOLS.events, () => reads.events(context.principal, input)))
}
