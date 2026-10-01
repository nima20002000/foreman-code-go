import type { FastifyInstance } from 'fastify'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { RunPlacementGetInputSchema, RunPlacementGetResultSchema, NodePlacementChoicesInputSchema, NodePlacementChoicesResultSchema } from '@graphql/contracts/placement-readback'
import { requirePrincipal } from '../access/http.js'
import { DomainError } from '../errors.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { toolFailure } from '../../mcp/shared/results.js'
import type { RunPlacementReadService } from './readService.js'

/** Mount under the existing management auth hook. No caller placement/proof JSON
 * is accepted by this read-only adapter or by the existing shared Start route. */
export function registerRunPlacementRoutes(app: FastifyInstance, reads: RunPlacementReadService): void {
  app.get<{ Params: Record<string, string> }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/nodes/:nodeId/placement', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization, Cookie')
    return reads.get(requirePrincipal(request), request.params)
  })
}

export function registerRunPlacementTool(server: McpServer, reads: RunPlacementReadService, principal: ManagementPrincipal, commands: Pick<PostgresCommandCoordinator, 'recordDenied'>): void {
  server.registerTool('run_node_placement_get', {
    description: 'Read exact admission-time host/configuration/root/source binding for one Run node. Requires live scoped runs:read and workspace_locations:read because the exact binding includes canonical destination paths. Never reads current Board placement or launches work. Acceptance is distinct from native execution evidence.',
    inputSchema: RunPlacementGetInputSchema, outputSchema: RunPlacementGetResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try {
      const result = await reads.get(principal, input)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result }
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) await commands.recordDenied(principal.id, 'mcp', 'run_node_placement_get', 'mcp:run_node_placement_get')
      return toolFailure(error)
    }
  })
}

export function registerNodePlacementChoicesRoutes(app: FastifyInstance, reads: import('./choicesService.js').NodePlacementChoicesService): void {
  app.get<{ Params: Record<string, string>; Querystring: Record<string, unknown> }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/nodes/:nodeId/placement-choices', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization, Cookie')
    if (Object.keys(request.params).some(key => Object.hasOwn(request.query, key))) throw new DomainError('RESOURCE_ID_MISMATCH', 'Placement choice scope must be supplied in the URL.', 400)
    return reads.get(requirePrincipal(request), { ...request.query, ...request.params })
  })
}
export function registerNodePlacementChoicesTool(server: McpServer, reads: import('./choicesService.js').NodePlacementChoicesService,
  principal: ManagementPrincipal, commands: Pick<PostgresCommandCoordinator, 'recordDenied'>): void {
  server.registerTool('workflow_node_placement_choices', {
    description: 'List main-authorized destinations for one saved node/configuration. Requires live workflows:read and workspace_locations:read. Readiness is not permission to launch; save and Start retain revision/auth/root validation.',
    inputSchema: NodePlacementChoicesInputSchema, outputSchema: NodePlacementChoicesResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try { const result = await reads.get(principal, input); return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result } }
    catch (error) {
      if (error instanceof DomainError && error.status === 403) await commands.recordDenied(principal.id, 'mcp', 'workflow_node_placement_choices', 'mcp:workflow_node_placement_choices')
      return toolFailure(error)
    }
  })
}

/** Existing frozen capabilities enums cannot silently invent names. tools/list
 * publishes both strict schemas; root can append this explicit capability limit. */
export function placementCapabilityLimit(composed: boolean) {
  return { feature: 'accepted_node_placement', state: composed ? 'limited' as const : 'unsupported' as const,
    detail: composed
      ? 'run_node_placement_get requires runs:read and workspace_locations:read. workflow_node_placement_choices requires workflows:read and workspace_locations:read. Discover exact schemas through tools/list. Accepted binding is distinct from observed native work; remote execution requires the approved device dispatch bridge.'
      : 'Placement readback and authorized choices are not composed in this application.' }
}
