import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  CANONICAL_RUN_GRAPH_MCP_TOOLS as RUN_GRAPH_MCP_TOOLS,
  CanonicalRunGraphReadRequestSchema as RunGraphReadRequestSchema,
  CanonicalRunGraphEventsRequestSchema as RunGraphEventsRequestSchema,
  CanonicalRunGraphSnapshotSchema as RunGraphSnapshotSchema,
  CanonicalRunGraphEventsResponseSchema as RunGraphEventsResponseSchema,
  CanonicalRunGraphCurrentSchema, RunGraphCapabilitiesSchema,
} from '@graphql/contracts/wave25'
import type { OperatorRequestContext } from '../types.js'
import { canonicalRunGraphReadApi } from '../../../modules/run-graph/repeatReadService.js'
import type { RunGraphReadApi } from '../../../modules/run-graph/readService.js'
import { RunGraphError, runGraphErrorResponse } from '../../../modules/run-graph/errors.js'

/** New versioned tools; do not widen strict legacy capability/catalog enums. */
export function registerRunGraphTools(server: McpServer, context: OperatorRequestContext, reads: RunGraphReadApi): void {
  const canonical = canonicalRunGraphReadApi(reads)
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
  }, async (input) => invoke(RUN_GRAPH_MCP_TOOLS.snapshot, async () => RunGraphSnapshotSchema.parse(await canonical.snapshot(context.principal, input))))
  server.registerTool(RUN_GRAPH_MCP_TOOLS.current, {
    description: 'Read the exact authorized canonical current cut. Legacy semantics return their unchanged snapshot; v3 returns occurrence-qualified current metadata. Requires runs:read; unqualified v3 remains unavailable.',
    inputSchema: RunGraphReadRequestSchema, outputSchema: CanonicalRunGraphCurrentSchema, annotations,
  }, async (input) => invoke(RUN_GRAPH_MCP_TOOLS.current,
    async () => CanonicalRunGraphCurrentSchema.parse(await canonical.current(context.principal, input))))
  server.registerTool(RUN_GRAPH_MCP_TOOLS.events, {
    description: 'Read complete semantic batches after an exact decimal cursor, or an explicit reset. Never advance past throughSequence.',
    inputSchema: RunGraphEventsRequestSchema, outputSchema: RunGraphEventsResponseSchema, annotations,
  }, async (input) => invoke(RUN_GRAPH_MCP_TOOLS.events, async () => RunGraphEventsResponseSchema.parse(await canonical.events(context.principal, input))))
}
