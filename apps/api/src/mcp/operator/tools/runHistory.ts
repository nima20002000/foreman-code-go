import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  RunBoardSnapshotGetInputSchema, RunBoardSnapshotGetResultSchema,
  RunDropdownListInputSchema, RunDropdownPageSchema,
} from '@foreman-code/contracts/run-snapshots'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../../modules/access/policy.js'
import { DomainError } from '../../../modules/errors.js'
import { toolFailure } from '../../shared/results.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorRequestContext } from '../types.js'

export const RUN_HISTORY_TOOLS = { list: 'run_summaries_list', snapshot: 'run_board_snapshot_get' } as const
export type RunHistoryToolName = typeof RUN_HISTORY_TOOLS[keyof typeof RUN_HISTORY_TOOLS]

/** Discovery is not authorization: RunHistoryService locks/rechecks live grants
 * and validates the persisted hierarchy on every HTTP and MCP read. */
export function runHistoryToolsAvailable(context: OperatorRequestContext): boolean {
  return !!context.services.runs?.history && hasAction(context.principal, 'runs:read')
    && context.principal.grants.some((grant) => grant.actions.includes('runs:read')
      && !Object.values(grant.scope).some((ids) => ids?.length === 0))
}

export function runHistoryToolAvailable(context: OperatorRequestContext, name: RunHistoryToolName,
  resource: AuthorizedResource): boolean {
  if (!runHistoryToolsAvailable(context)) return false
  if (isAuthorized(context.principal, 'runs:read', resource)) return true
  if (name !== RUN_HISTORY_TOOLS.list || !resource.workspaceId || !resource.workflowId || resource.runId) return false
  return context.principal.grants.some((grant) => grant.scope.runIds?.some((runId) =>
    isAuthorized(context.principal, 'runs:read', { ...resource, runId })))
}

export function registerRunHistoryTools(server: McpServer, context: OperatorRequestContext): void {
  const reads = context.services.runs?.history
  if (!reads || !runHistoryToolsAvailable(context)) return
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  server.registerTool(RUN_HISTORY_TOOLS.list, {
    description: 'Read Run dropdown summaries for one workspace and workflow. Requires live runs:read; Run-only grants see only their Runs. Default 50, maximum 100. Newest admission first with stable Run-ID tie-breaking; replay opaque cursors in the same workflow. startedAt is null until actually started. Pre-capture V3 Runs at this base were manual-only. Older Runs without provable trigger provenance are omitted from summaries, not relabeled. No graph, prompt, session or configuration body.',
    inputSchema: RunDropdownListInputSchema, outputSchema: RunDropdownPageSchema, annotations,
  }, async (input) => invokeOperatorTool(context, RUN_HISTORY_TOOLS.list, () => reads.list(context.principal, input)))
  server.registerTool(RUN_HISTORY_TOOLS.snapshot, {
    description: 'Read an immutable admission-time Run Board snapshot in an exact workspace/workflow/Run scope. Requires live runs:read. Includes saved node names, Agent/configuration-version IDs, layout and edges only. Old Runs without capture return unavailable/legacy_run, never today\'s graph. Does not require access to live Agents or start/modify a Run.',
    inputSchema: RunBoardSnapshotGetInputSchema, outputSchema: RunBoardSnapshotGetResultSchema, annotations,
  }, async (input) => invokeOperatorTool(context, RUN_HISTORY_TOOLS.snapshot, () => reads.snapshot(context.principal, input)))
}

const ToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({
    name: z.enum([RUN_HISTORY_TOOLS.list, RUN_HISTORY_TOOLS.snapshot]),
  }).passthrough() }).passthrough()

/** The existing authenticated transport calls this only AFTER Host/Origin and
 * credential validation. A forged call to a hidden tool still gets a denial. */
export async function unavailableRunHistoryToolCall(context: OperatorRequestContext, body: unknown) {
  const call = ToolCall.safeParse(body)
  if (!call.success || runHistoryToolsAvailable(context)) return undefined
  const name = call.data.params.name
  const error = context.services.runs?.history
    ? new DomainError('ACCESS_DENIED', 'Run history requires a compatible runs:read grant.', 403)
    : new DomainError('RUN_HISTORY_UNAVAILABLE', 'Run history services are not composed in this application.', 503)
  if (error.status === 403) await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(error) }
}

/** Keep the frozen CurrentOperatorCapabilitiesSchema intact. These tools have
 * typed tools/list schemas, but its tools/requirements enum has no SCH-05 names. */
export function runHistoryCapabilityLimit(context: OperatorRequestContext) {
  return {
    feature: 'run_board_history', state: context.services.runs?.history ? 'limited' as const : 'unsupported' as const,
    detail: context.services.runs?.history
      ? 'run_summaries_list and run_board_snapshot_get are read-only and require compatible live runs:read grants. Discover availability and frozen input/output schemas through tools/list. Their names cannot appear in this response\'s tools/requirements arrays until the frozen capability-name enum is extended. Legacy Runs have no Board capture; older non-V3 Runs without provable trigger provenance cannot appear in the two-trigger dropdown contract.'
      : 'Run history services are not composed; no snapshot or dropdown read is promised.',
  }
}
