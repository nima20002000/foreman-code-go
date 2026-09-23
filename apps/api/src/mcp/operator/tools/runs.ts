import type { McpServer } from '@modelcontextprotocol/server'
import { RUN_CURRENT_MCP_TOOL, RunCurrentRequestSchema, RunCurrentResponseSchema } from '@graphql/contracts/run-current'

import {
  RunEventsListInputSchema, RunGetInputSchema, RunListInputSchema, RunStartInputSchema, RunStopInputSchema,
  RunDetailsSchema, RunEventsPageSchema, RunPageSchema, RunStartResultSchema, RunStopResultSchema,
} from '@graphql/contracts/management'
import { RunStartV2InputSchema, CompatibleWorkflowRunSchema } from '@graphql/contracts/wave25'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerRunTools(server: McpServer, context: OperatorRequestContext): void {
  // This bounded read uses the same runs:read grant as run_get and is included
  // in both tools/list and operator_get_capabilities discovery.
  if (operatorToolAvailable(context, RUN_CURRENT_MCP_TOOL)) server.registerTool(RUN_CURRENT_MCP_TOOL, {
    description: 'Read bounded semantics-1 current Run lifecycle, latest attempt per pinned node and cleanup status. No history or native bodies. Settlement remains unconfirmed even for terminal outcomes; use run_events_list explicitly for paginated history.',
    inputSchema: RunCurrentRequestSchema, outputSchema: RunCurrentResponseSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, RUN_CURRENT_MCP_TOOL,
    () => context.services.runs.current(context.principal, input)))
  if (operatorToolAvailable(context, 'run_list')) server.registerTool('run_list', {
    description: 'List authorized durable runs with pagination.', inputSchema: RunListInputSchema,
    outputSchema: RunPageSchema.extend({ items: CompatibleWorkflowRunSchema.array() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'run_list', () => context.services.runs.list(context.principal, input)))
  if (operatorToolAvailable(context, 'run_get')) server.registerTool('run_get', {
    description: 'Read an authorized Run, result, execution attempts and liveActivity from one backend snapshot. Each exact workflow node has a coherent Working, Waiting or Idle state and a safe event-backed action. liveActivity uses the Run’s saved workflow version, decimal event identities and an event count; terminal Runs have no live actions. Includes persisted automatic Stop causes and cleanup status; a canceled outcome does not hide reviewer failure.', inputSchema: RunGetInputSchema,
    outputSchema: RunDetailsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'run_get', () => context.services.runs.get(context.principal, input.workspaceId, input.runId)))
  if (operatorToolAvailable(context, 'run_events_list')) server.registerTool('run_events_list', {
    description: 'Read a bounded page of existing persisted run activity.', inputSchema: RunEventsListInputSchema,
    outputSchema: RunEventsPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'run_events_list', () => context.services.runs.events(context.principal, input)))
  if (operatorToolAvailable(context, 'run_start')) server.registerTool('run_start', {
    description: 'Durably accept one run of an explicit current saved workflow version. Nodes using routed Orchestrator approval require direct edges. Interrupted Runs and pending native cleanup must be stopped/resolved first.', inputSchema: RunStartInputSchema.or(RunStartV2InputSchema),
    outputSchema: RunStartResultSchema.extend({ run: CompatibleWorkflowRunSchema }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'run_start', () => context.services.runs.start(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'run_stop')) server.registerTool('run_stop', {
    description: 'Request ownership-aware cancellation and report whether process exit is confirmed.', inputSchema: RunStopInputSchema,
    outputSchema: RunStopResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'run_stop', () => context.services.runs.stop(context.principal, 'mcp', input)))
}
