import type { McpServer } from '@modelcontextprotocol/server'
import { REPEAT_OPERATOR_TOOL_NAMES, RepeatCapabilitiesResultSchema, type ManagementPrincipal, type RepeatOperatorToolName } from '@graphql/contracts/management'
import { z } from 'zod'
import {
  RepeatCapabilityRequestSchema,
  RepeatRunReadInputSchema,
  RepeatRunReadbackSchema,
  RepeatSaveInputSchema,
  RepeatSaveResultSchema,
  RepeatWorkflowReadInputSchema,
  RepeatWorkflowReadbackSchema,
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
    description: 'Discover saved bounded-repeat authoring/readback limits and explicit unavailable native Start and repeat edit-intent gates. supported=false is not permission to start; no nesting or arbitrary cycles.',
    inputSchema: RepeatCapabilityRequestSchema,
    outputSchema: RepeatCapabilitiesResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invoke(context, 'repeat_capabilities_get', () => context.authoring.capabilities(context.principal, input)))

  if (context.available('repeat_get')) server.registerTool('repeat_get', {
    description: 'Read the current persisted bounded-repeat workflow version and exact repeat plan.',
    inputSchema: RepeatWorkflowReadInputSchema,
    outputSchema: RepeatWorkflowReadbackSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invoke(context, 'repeat_get', () => context.readback.workflow(context.principal, input)))

  if (context.available('repeat_update')) server.registerTool('repeat_update', {
    description: 'Revision- and version-pinned bounded-repeat publication through the same HTTP service. Requires workflows read/update, graph read/edit/save and Agent read grants; skills and privileged harness pins require extra authority. Every affected Run must be terminal with exact cleanup settlement. This does not Stop, Stage, or Start. Native repeat Start and repeat edit intents remain unavailable. Reusing commandId with different input conflicts.',
    inputSchema: RepeatSaveInputSchema,
    outputSchema: RepeatSaveResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invoke(context, 'repeat_update', () => context.authoring.save(context.principal, 'mcp', input)))

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
