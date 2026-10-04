import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { DomainError } from '../../../modules/errors.js'
import { toolFailure } from '../../shared/results.js'

import {
  RunEventsListInputSchema, RunGetInputSchema, RunListInputSchema, RunStopInputSchema,
  RunEventsPageSchema, RunStopResultSchema,
} from '@graphql/contracts/management'
import { ManualRunStartInputSchema, ManualRunStartResultSchema, SavedRunPageSchema, SavedRunDetailsSchema,
  RunActivitiesInputSchema, RunActivitiesPageSchema, RunHandoffsReadInputSchema,
  RunHandoffsReadSchema } from '@graphql/contracts/wave25'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerRunTools(server: McpServer, context: OperatorRequestContext): void {
  if (operatorToolAvailable(context, 'run_list')) server.registerTool('run_list', {
    description: 'List authorized durable runs with pagination.', inputSchema: RunListInputSchema,
    outputSchema: SavedRunPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'run_list', () => context.services.runs.list(context.principal, input)))
  if (operatorToolAvailable(context, 'run_get')) server.registerTool('run_get', {
    description: 'Read an authorized Run, result, execution attempts and activity from one backend snapshot. Current execution semantics 3 only; compact metadata is available from run_graph_snapshot_v1 (graph protocol 1). Includes persisted Stop causes and cleanup status.', inputSchema: RunGetInputSchema,
    outputSchema: SavedRunDetailsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'run_get', () => context.services.runs.get(context.principal, input.workspaceId, input.runId)))
  if (operatorToolAvailable(context, 'run_events_list')) server.registerTool('run_events_list', {
    description: 'Read a bounded page of existing persisted run activity.', inputSchema: RunEventsListInputSchema,
    outputSchema: RunEventsPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'run_events_list', () => context.services.runs.events(context.principal, input)))
  if (operatorToolAvailable(context, 'run_handoffs_get_v1')) server.registerTool('run_handoffs_get_v1', {
    description: 'Read the exact saved work connections, Run-wide usage, nullable limits, named route availability, notice delivery and unresolved work. Requires scoped runs:read and workflows:read. A listed route still requires live admission; this read grants no execution authority.',
    inputSchema: RunHandoffsReadInputSchema, outputSchema: RunHandoffsReadSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'run_handoffs_get_v1',
    () => context.services.runs.handoffs.read(context.principal, input)))
  if (operatorToolAvailable(context, 'run_activities_get_v1')) server.registerTool('run_activities_get_v1', {
    description: 'Read a bounded, redacted Activities page for an exact authorized Run. Use nextCursor for live catch-up and olderCursor for earlier retained history; an expired cursor requires a fresh initial read. Pending approvals remain in the authorized inbox.',
    inputSchema: RunActivitiesInputSchema, outputSchema: RunActivitiesPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'run_activities_get_v1',
    () => context.services.runs.activities.read(context.principal, input)))
  if (operatorToolAvailable(context, 'run_start')) server.registerTool('run_start', {
    description: 'Request one Run of the explicit saved version. Every new workflow uses semantics 3, with or without repeat. Pin 3 plus the current workflow revision, exact Agent configuration map and location revision. New v3 Start remains unavailable until native lifecycle qualification; graph read support is not admission. Retry only the same command for verified receipt readback, never a blind restart.', inputSchema: ManualRunStartInputSchema,
    outputSchema: ManualRunStartResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'run_start', () => context.services.runs.start(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'run_stop')) server.registerTool('run_stop', {
    description: 'Request ownership-aware Stop for an exact authorized Run. V3 Stop remains unavailable until its native occurrence lifecycle is qualified; it never falls through to legacy cleanup. A receipt or terminal record is not process-exit proof; processStopped remains false.', inputSchema: RunStopInputSchema,
    outputSchema: RunStopResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'run_stop', () => context.services.runs.stop(context.principal, 'mcp', input)))
}

const RunToolCallSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.enum([
    'run_start', 'run_stop', 'run_handoffs_get_v1', 'run_activities_get_v1',
    'run_subagents_list_v1', 'run_subagent_get_v1', 'run_subagent_messages_list_v1', 'run_subagent_tools_list_v1', 'run_subagent_input_v1', 'run_subagent_interrupt_v1',
  ]) }).passthrough(),
}).passthrough()

/** Called only after existing HTTP host/origin and Operator authentication.
 * Hidden tools stay hidden. Their denied invocation cannot bypass audit by
 * falling into an SDK unknown-tool response; no extra grants are issued. */
export async function unavailableRunToolCall(context: OperatorRequestContext, body: unknown) {
  const request = RunToolCallSchema.safeParse(body)
  if (!request.success || operatorToolAvailable(context, request.data.params.name)) return undefined
  const name = request.data.params.name
  const error = context.services.runs
    ? new DomainError('ACCESS_DENIED', 'The Run tool is not permitted by compatible scoped grants.', 403)
    : new DomainError('RUN_SERVICES_UNAVAILABLE', 'Run services are not composed in this application.', 503)
  if (error.status === 403) await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: request.data.id, result: toolFailure(error) }
}
