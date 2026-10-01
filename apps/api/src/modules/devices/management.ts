import type { McpServer } from '@modelcontextprotocol/server'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { DevicePairingGrantInputSchema, DeviceRegistrationSchema, DeviceRevokeInputSchema } from '@graphql/contracts/device-identity'
import { toolFailure, toolResult } from '../../mcp/shared/results.js'
import { hasAction } from '../access/policy.js'
import type { PostgresDeviceAccessService } from './access.js'

export function registerDeviceManagementTools(server: McpServer, service: PostgresDeviceAccessService, principal: ManagementPrincipal): void {
  const invoke = async (operation: () => Promise<unknown>) => {
    try { return toolResult(await operation()) } catch (error) { return toolFailure(error, 'The device operation failed.') }
  }
  if (hasAction(principal, 'settings:read')) server.registerTool('devices_list', {
    description: 'Read main-owned registration and authorization revisions. Connectivity is separate; no dispatch is supported.',
    inputSchema: z.object({}).strict(), outputSchema: z.object({ devices: z.array(DeviceRegistrationSchema) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => invoke(async () => ({ devices: await service.list(principal) })))
  if (hasAction(principal, 'settings:update')) {
    server.registerTool('device_pairing_grant_create', {
      description: 'Approve a verified worker public-key fingerprint and issue a five-minute, single-use device-only pairing grant. Requires unscoped settings:update. Treat returned grant as secret; no remote execution scopes.',
      inputSchema: DevicePairingGrantInputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, input => invoke(() => service.createPairingGrant(principal, input, 'mcp')))
    server.registerTool('device_revoke', {
      description: 'Persist revocation and fence device access. Requires unscoped settings:update. An unreachable process cannot be physically stopped; execution leases are separate.',
      inputSchema: DeviceRevokeInputSchema, outputSchema: DeviceRegistrationSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, input => invoke(() => service.revoke(principal, input.deviceId, input.expectedRevision, input.commandId, 'mcp')))
  }
}
/** Mount on the existing loopback management API with its existing bearer/cookie authenticator. */
export function registerDeviceManagementRoutes(app: FastifyInstance, service: PostgresDeviceAccessService,
  authenticate: (request: import('fastify').FastifyRequest) => Promise<ManagementPrincipal>): void {
  app.get('/api/devices', async request => ({ devices: await service.list(await authenticate(request)) }))
  app.post('/api/devices/pairing-grants', async request => service.createPairingGrant(await authenticate(request), DevicePairingGrantInputSchema.parse(request.body)))
  app.post('/api/devices/revoke', async request => {
    const input = DeviceRevokeInputSchema.parse(request.body)
    return service.revoke(await authenticate(request), input.deviceId, input.expectedRevision, input.commandId)
  })
}
