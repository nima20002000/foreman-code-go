import type { McpServer } from '@modelcontextprotocol/server'
import { REPEAT_OPERATOR_TOOL_NAMES, RepeatCapabilitiesResultSchema, type ManagementPrincipal, type RepeatOperatorToolName } from '@graphql/contracts/management'
import { z } from 'zod'
import {
  RepeatCapabilityRequestSchema,
  RepeatRunReadInputSchema,
  RepeatRunReadbackSchema,
  RepeatMutationInputSchema,
  RepeatMutationToolInputSchema,
  RepeatMutationToolResultSchema,
  RepeatGetInputSchema,
  RepeatGetToolInputSchema,
  RepeatGetToolResultSchema,
} from '@graphql/contracts/wave25'

import type { PostgresCommandCoordinator } from '../../modules/commands/postgres.js'
import { DomainError } from '../../modules/errors.js'
import type { RepeatAuthoringService } from '../../modules/repeats/authoring.js'
import type { RepeatReadbackService } from '../../modules/repeats/readback.js'
import { toolFailure, toolResult } from '../shared/results.js'

import { operatorToolAvailable } from './availability.js'
import type { OperatorRequestContext } from './types.js'

export type { RepeatOperatorToolName } from '@graphql/contracts/management'

export interface RepeatOperatorContext {
  principal: ManagementPrincipal
  commands: PostgresCommandCoordinator
  authoring: RepeatAuthoringService
  readback: RepeatReadbackService
  /** Shell passes operatorToolAvailable(context, name) after registering names in the shared catalog. */
  available(name: RepeatOperatorToolName): boolean
}

async function invoke(context: RepeatOperatorContext, name: string, work: () => Promise<unknown> | unknown) {
  try { return toolResult(await work()) } catch (error) {
    if (error instanceof DomainError && error.status === 403) {
      await context.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
    }
    return toolFailure(error)
  }
}

export function registerRepeatTools(server: McpServer, context: RepeatOperatorContext): void {
  if (context.available('repeat_capabilities_get')) server.registerTool('repeat_capabilities_get', {
    description: 'Discover saved bounded-repeat authoring/readback limits and explicit unavailable native Start/Stop completion gates. supported=false is not permission to start; no nesting or arbitrary cycles.',
    inputSchema: RepeatCapabilityRequestSchema,
    outputSchema: RepeatCapabilitiesResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invoke(context, 'repeat_capabilities_get', () => context.authoring.capabilities(context.principal, input)))

  if (context.available('repeat_get')) server.registerTool('repeat_get', {
    description: 'Read the saved repeat version, or action=read_edits with draftId and optional intentId to reconcile the caller-private durable edit journal. Private edits require Agent, workspace-location and affected-Run read grants. Read never Stops, publishes, or restarts.',
    inputSchema: RepeatGetToolInputSchema,
    outputSchema: RepeatGetToolResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invoke(context, 'repeat_get', () => {
    const value = RepeatGetInputSchema.parse(input)
    return 'action' in value ? context.authoring.editIntents.read(context.principal, value)
      : context.readback.workflow(context.principal, value)
  }))

  if (context.available('repeat_update')) server.registerTool('repeat_update', {
    description: 'Direct save without action; action=stage_edits privately journals a finite repeat plan with exact workflow revision/version, Agent map, location revision and stable editor draftId; action=stop_and_save or discard_edits uses ONLY the intent-returned commandId, intentId and draftId. Same durable board protocol and HTTP service. Requires workflow read/update, graph read/edit/save Agent read and workspace-location read; Stop separately requires every exact affected-Run Stop grant. Stage/Discard never Stop or publish. Advance may return waiting/blocked/uncertain: acceptance is not native/cleanup settlement. Read with repeat_get; retry exact identities, never restart. Native v3 Stop remains fail-closed until its owner registers support.',
    inputSchema: RepeatMutationToolInputSchema,
    outputSchema: RepeatMutationToolResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invoke(context, 'repeat_update', () => context.authoring.mutate(context.principal, 'mcp', RepeatMutationInputSchema.parse(input))))

  if (context.available('repeat_run_get')) server.registerTool('repeat_run_get', {
    description: 'Read persisted per-occurrence repeat identity and decision metadata for an exact Run. Authorized result detail is opt-in and bounded.',
    inputSchema: RepeatRunReadInputSchema,
    outputSchema: RepeatRunReadbackSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invoke(context, 'repeat_run_get', () => context.readback.run(context.principal, input)))
}

const RepeatToolCallSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.enum(REPEAT_OPERATOR_TOOL_NAMES) }).passthrough(),
}).passthrough()

/** Authentication/host/origin checks precede this function in the existing MCP
 * transport. No alternate endpoint or injected privileged principal is used. */
export async function unavailableRepeatToolCall(context: OperatorRequestContext, body: unknown) {
  const request = RepeatToolCallSchema.safeParse(body)
  if (!request.success || operatorToolAvailable(context, request.data.params.name)) return undefined
  const name = request.data.params.name
  const error = context.services.repeats
    ? new DomainError('ACCESS_DENIED', 'The repeat tool is not permitted by compatible scoped grants.', 403)
    : new DomainError('REPEAT_SERVICES_UNAVAILABLE', 'Repeat services are not composed in this application.', 503)
  if (error.status === 403) await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: request.data.id, result: toolFailure(error) }
}
