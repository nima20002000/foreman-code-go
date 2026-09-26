import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowCapabilitiesSchema, CurrentWorkflowReadInputSchema,
  CurrentWorkflowReadResultSchema, CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema,
  CurrentWorkflowValidateInputSchema, CurrentWorkflowValidationSchema,
  CurrentEditReadInputSchema, CurrentEditReadResultSchema, CurrentEditMutationToolInputSchema,
} from '@graphql/contracts/wave25'
import { currentWorkflowAvailable, type CurrentWorkflowOperation } from '../../../modules/workflows/currentWorkflowPolicy.js'
import { DomainError } from '../../../modules/errors.js'
import { toolFailure, toolResult } from '../../shared/results.js'
import type { OperatorRequestContext } from '../types.js'

function available(context: OperatorRequestContext, operation: CurrentWorkflowOperation) {
  return !!context.services.workflows?.current && currentWorkflowAvailable(context.principal, operation)
}
async function invoke(context: OperatorRequestContext, operation: CurrentWorkflowOperation, work: () => unknown | Promise<unknown>) {
  try { return toolResult(await work()) } catch (error) {
    if (error instanceof DomainError && error.status === 403) await context.services.commands.recordDenied(
      context.principal.id, 'mcp', CURRENT_WORKFLOW_TOOLS[operation], `mcp:${CURRENT_WORKFLOW_TOOLS[operation]}`)
    return toolFailure(error)
  }
}
/** Versioned current authoring on the EXISTING authenticated Operator server.
 * These names describe actions, not different normal/parallel/repeat editors. */
export function registerCurrentWorkflowTools(server: McpServer, context: OperatorRequestContext) {
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  if (available(context, 'capabilities')) server.registerTool(CURRENT_WORKFLOW_TOOLS.capabilities, {
    description: 'Discover the single current execution semantics 3 for every graph. Repeat is optional. Save/read support is separate from separately qualified native Start/Stop/cleanup. Tool grants and resource scope still apply.',
    inputSchema: z.object({}).strict(), outputSchema: CurrentWorkflowCapabilitiesSchema, annotations: readOnly,
  }, async () => invoke(context, 'capabilities', () => context.services.workflows.current.capabilities(context.principal)))
  if (available(context, 'saved')) server.registerTool(CURRENT_WORKFLOW_TOOLS.saved, {
    description: 'Read the current or exact historical immutable v3 workflow version, independent of repeat and native owner. Requires workflows:read and graph:read; no private Agent configuration bodies.',
    inputSchema: CurrentWorkflowReadInputSchema, outputSchema: CurrentWorkflowReadResultSchema, annotations: readOnly,
  }, async (input) => invoke(context, 'saved', () => context.services.workflows.current.read(context.principal, input)))
  if (available(context, 'validate')) server.registerTool(CURRENT_WORKFLOW_TOOLS.validate, {
    description: 'Validate a complete v3 definition with exact current revision/version, Agent configuration map and workspace location revision. Ordinary, parallel/all-required, conditional/approval and optional finite repeat use the same validator. Requires workflow/graph/Agent/location read grants. Does not save, Stop or admit a Run.',
    inputSchema: CurrentWorkflowValidateInputSchema, outputSchema: CurrentWorkflowValidationSchema, annotations: readOnly,
  }, async (input) => invoke(context, 'validate', () => context.services.workflows.current.validate(context.principal, input)))
  if (available(context, 'editRead')) server.registerTool(CURRENT_WORKFLOW_TOOLS.editRead, {
    description: 'Reopen the caller-private durable current-v3 edit journal with exact draftId and optional intentId. Returns affected Run/version/configuration and content-free location pins, original command IDs and settlement obligations. Read never Stops or publishes; requires workflow/graph/Agent/location and every affected Run read grant.',
    inputSchema: CurrentEditReadInputSchema, outputSchema: CurrentEditReadResultSchema, annotations: readOnly,
  }, async (input) => invoke(context, 'editRead', () => context.services.workflows.current.readEdits(context.principal, input)))
  if (available(context, 'edits')) server.registerTool(CURRENT_WORKFLOW_TOOLS.edits, {
    description: 'Stage a full v3 definition with exact revision/version/configuration/location pins and stable draftId; advance or discard ONLY with the intent-returned commandId/intentId/draftId. Same durable journal for ordinary, parallel and repeat graphs. Optional stagedAgents uses exact Agent snapshots and baseRevision (null for new IDs); original expectedAgentConfigurationVersionIds remain original heads. Stage/Discard do not mutate Agents, Stop or publish. Staged Agent changes additionally require agents:create/update and graph read/edit grants for every referencing workflow; resulting Agent snapshots and metadata revisions return at intent.result.agents. Stop-and-save publishes only after every exact affected Run is genuinely settled; native v3 Stop requires the composed production binding. Never infer cleanup from a receipt or replace an uncertain command. Requires Save grants; Stop additionally requires every affected Run Stop grant.',
    inputSchema: CurrentEditMutationToolInputSchema, outputSchema: CurrentEditReadResultSchema,
    annotations: { ...readOnly, readOnlyHint: false, destructiveHint: true },
  }, async (input) => invoke(context, 'edits', () => context.services.workflows.current.mutateEdits(context.principal, 'mcp', input)))
  if (available(context, 'save')) server.registerTool(CURRENT_WORKFLOW_TOOLS.save, {
    description: 'Save one complete current v3 definition with exact revision, nullable first-save version, Agent configuration and location pins. Repeat is optional; topology never selects semantics. Requires workflow read/update, graph read/edit/save, Agent and location reads, plus referenced skill/harness grants. Does not edit shared Agents or Start/Stop work. Unsettled Runs or unresolved staged edits block executable changes. Geometry-only Save keeps the immutable version and semantic revision and never Stops. For concurrent layout edits, supply expectedGeometry with the exact persisted node id/position/width/height array; stale geometry returns LAYOUT_REVISION_CONFLICT and cannot overwrite newer positions. Read current geometry with workflow_get. Stage executable changes with workflow_edit_v3. Retry the exact command after an uncertain reply; changed input conflicts. Read back with workflow_saved_get_v3; run_start independently checks the native production binding.',
    inputSchema: CurrentWorkflowSaveInputSchema, outputSchema: CurrentWorkflowSaveResultSchema,
    annotations: { ...readOnly, readOnlyHint: false },
  }, async (input) => invoke(context, 'save', () => context.services.workflows.current.save(context.principal, 'mcp', input)))
}
const CallSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]), method: z.literal('tools/call'),
  params: z.object({ name: z.enum(Object.values(CURRENT_WORKFLOW_TOOLS)) }).passthrough() }).passthrough()
export async function unavailableCurrentWorkflowToolCall(context: OperatorRequestContext, body: unknown) {
  const call = CallSchema.safeParse(body)
  if (!call.success) return undefined
  const operation = (Object.keys(CURRENT_WORKFLOW_TOOLS) as CurrentWorkflowOperation[]).find((key) => CURRENT_WORKFLOW_TOOLS[key] === call.data.params.name)!
  if (available(context, operation)) return undefined
  const error = context.services.workflows?.current
    ? new DomainError('ACCESS_DENIED', 'Compatible scoped grants are required for this current workflow action.', 403)
    : new DomainError('WORKFLOW_SERVICES_UNAVAILABLE', 'Current workflow authoring is not composed.', 503)
  if (error.status === 403) await context.services.commands.recordDenied(context.principal.id, 'mcp', call.data.params.name, `mcp:${call.data.params.name}`)
  return { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(error) }
}
