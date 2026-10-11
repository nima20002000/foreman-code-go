import type { FastifyInstance } from 'fastify'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { RunPlacementGetInputSchema, RunPlacementGetResultSchema, NodePlacementChoicesInputSchema, NodePlacementChoicesResultSchema } from '@foreman-code/contracts/placement-readback'
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
    description: 'Read accepted host, configuration, root, source and requested Agent branch prefix for one Run node. Persisted native placements report each prepared branch and materialized working directory separately. Inherited Main nodes without a per-node binding return legacy_missing evidence. Requires live scoped runs:read and workspace_locations:read for canonical paths. Current Board settings are never substituted and this read does not launch work.',
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
    description: 'List computers, approved sources and roots, and matching harness profiles for one saved node/configuration. Unusable roots remain visible as unavailable choices with a reason, including released sources. Existing host bindings remain selectable after workspace location changes while their saved policy and source remain authorized. Requires scoped workflows:read, workspace_locations:read, source_roots:read and sources:read, plus global harnesses:read. Clear node placement through workflow_save_v3 to inherit the workflow default, or Main when no default is saved. Discovery does not grant execution; Save and Start revalidate revisions and authority.',
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

/** Discovery and accepted Run readback have separate grants and do not authorize execution. */
export function placementCapabilityLimit(composed: boolean) {
  return { feature: 'accepted_node_placement', state: composed ? 'limited' as const : 'unsupported' as const,
    detail: composed
      ? 'run_node_placement_get requires runs:read and workspace_locations:read. '
        + 'Inherited Main nodes without a per-node binding return legacy_missing evidence. '
        + 'workflow_node_placement_choices requires scoped workflows:read, workspace_locations:read, '
        + 'source_roots:read and sources:read, plus global harnesses:read. '
        + 'Existing host bindings retain their saved revisions across workspace location changes while authorized. '
        + 'Unusable roots remain visible as unavailable choices with a reason, including released sources. '
        + 'Clear a saved node placement through workflow_save_v3 to inherit the workflow default, '
        + 'or Main when no default is saved. Requested branches and persisted native branch/CWD facts are separate. '
        + 'Accepted Run binding remains unchanged; remote execution requires the approved device dispatch bridge.'
      : 'Placement readback and authorized choices are not composed in this application.' }
}
