import type { McpServer } from '@modelcontextprotocol/server'

import {
  RunEventsListInputSchema, RunGetInputSchema, RunListInputSchema, RunStartInputSchema, RunStopInputSchema,
  RunDetailsSchema, RunEventsPageSchema, RunPageSchema, RunStartResultSchema, RunStopResultSchema,
} from '@graphql/contracts/management'
import { hasAction } from '../../../modules/access/policy.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorRequestContext } from '../types.js'

export function registerRunTools(server: McpServer, context: OperatorRequestContext): void {
  if (hasAction(context.principal, 'runs:read')) {
    server.registerTool('run_list', {
      description: 'List authorized durable runs with pagination.', inputSchema: RunListInputSchema,
      outputSchema: RunPageSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => invokeOperatorTool(context, 'run_list', () => context.services.runs.list(context.principal, input)))
    server.registerTool('run_get', {
      description: 'Read an authorized run, result and execution attempts.', inputSchema: RunGetInputSchema,
      outputSchema: RunDetailsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => invokeOperatorTool(context, 'run_get', () => context.services.runs.get(context.principal, input.workspaceId, input.runId)))
    server.registerTool('run_events_list', {
      description: 'Read a bounded page of existing persisted run activity.', inputSchema: RunEventsListInputSchema,
      outputSchema: RunEventsPageSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input) => invokeOperatorTool(context, 'run_events_list', () => context.services.runs.events(context.principal, input)))
  }
  if (hasAction(context.principal, 'runs:start')) server.registerTool('run_start', {
    description: 'Durably accept one run of an explicit current saved workflow version.', inputSchema: RunStartInputSchema,
    outputSchema: RunStartResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'run_start', () => context.services.runs.start(context.principal, 'mcp', input)))
  if (hasAction(context.principal, 'runs:stop')) server.registerTool('run_stop', {
    description: 'Request ownership-aware cancellation and report whether process exit is confirmed.', inputSchema: RunStopInputSchema,
    outputSchema: RunStopResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'run_stop', () => context.services.runs.stop(context.principal, 'mcp', input)))
}
