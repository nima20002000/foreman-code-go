import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { McpServer } from '@modelcontextprotocol/server'
import { HarnessHostReferenceSchema, HarnessRegistryReadbackSchema } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ProductionHarnessRegistry } from './productionRegistry.js'
import { hasAction } from '../access/policy.js'
import { toolFailure, toolResult } from '../../mcp/shared/results.js'

export type HarnessRegistryManagementService = Pick<ProductionHarnessRegistry, 'get'>

/** Read the existing authorized host inventory; this endpoint never discovers or qualifies a runtime. */
export function registerHarnessRegistryRoutes(app: FastifyInstance, service: HarnessRegistryManagementService,
  authenticate: (request: FastifyRequest) => Promise<ManagementPrincipal>): void {
  app.get('/api/management/harnesses/registry', async (request, reply) => {
    const principal = await authenticate(request)
    const host = HarnessHostReferenceSchema.parse(request.query)
    reply.header('cache-control', 'private, no-store').header('vary', 'Authorization, Cookie')
    return HarnessRegistryReadbackSchema.parse(await service.get(principal, host))
  })
}

export function registerHarnessRegistryTools(server: McpServer, service: HarnessRegistryManagementService,
  principal: ManagementPrincipal): void {
  if (!hasAction(principal, 'harnesses:read')) return
  server.registerTool('harness_registry_get', {
    description: 'Read the authorized selected computer inventory and every saved global preset, including Claude. '
      + 'Match its driver to an installed harness, use harness_instance_save to configure a host override, '
      + 'then harness_instance_check to qualify the saved profile. Saving and checking require update grants. '
      + 'Installation, authentication, qualification and connection facts remain separate; '
      + 'the sidebar installation indicator uses installed, without implying authentication or execution readiness. '
      + 'previously qualified Main and Worker profiles are checked automatically after installed payload changes. '
      + 'harness_instances_list reports pending checks and persisted failure reasons. '
      + 'no discovery, native probe or fallback is performed.',
    inputSchema: HarnessHostReferenceSchema, outputSchema: HarnessRegistryReadbackSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try { return toolResult(HarnessRegistryReadbackSchema.parse(await service.get(principal, input))) }
    catch (error) { return toolFailure(error, 'The selected computer inventory could not be read.') }
  })
}
