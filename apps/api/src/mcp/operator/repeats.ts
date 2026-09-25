import type { McpServer } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import {
  RepeatCapabilityRequestSchema,
  RepeatCapabilityV1Schema,
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

export type RepeatOperatorToolName = 'repeat_capabilities_get' | 'repeat_get' | 'repeat_update' | 'repeat_run_get'

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
    description: 'Discover bounded business-repeat contract/version and supported authoring limits. This never enables unsupported nesting or arbitrary cycles.',
    inputSchema: RepeatCapabilityRequestSchema,
    outputSchema: RepeatCapabilityV1Schema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invoke(context, 'repeat_capabilities_get', () => context.authoring.capabilities(context.principal, input)))

  if (context.available('repeat_get')) server.registerTool('repeat_get', {
    description: 'Read the current persisted bounded-repeat workflow version and exact repeat plan.',
    inputSchema: RepeatWorkflowReadInputSchema,
    outputSchema: RepeatWorkflowReadbackSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invoke(context, 'repeat_get', () => context.readback.workflow(context.principal, input)))

  if (context.available('repeat_update')) server.registerTool('repeat_update', {
    description: 'Revision- and version-pinned bounded-repeat publication. Requires explicit finite cap, early exit, limit exit, and settled affected Runs. Reusing commandId with different input conflicts.',
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
