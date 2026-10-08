import { DeviceSetupApproveInputSchema, DeviceSetupApproveResultSchema, DeviceSetupOptionsSchema } from '@foreman-code/contracts/device-setup'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { DeviceListResultSchema, DevicePairingGrantInputSchema, DevicePairingGrantResultSchema,
  DeviceRegistrationSchema, DeviceRevokeInputSchema, MainDeviceIdentityPublicSchema } from '@foreman-code/contracts/device-identity'
import { DomainError } from '../../../modules/errors.js'
import { toolFailure } from '../../shared/results.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorRequestContext } from '../types.js'

export const DEVICE_OPERATOR_TOOLS = ['computer_activity_list', 'computer_accounts_list', 'computer_github_login_start', 'computer_github_login_status', 'computer_github_logout', 'computer_github_setup_git', 'computer_sync_status', 'computer_sync_update', 'build_computer_get', 'build_computer_update', 'build_computers_update', 'device_main_identity_get', 'devices_list', 'device_pairing_grant_create', 'device_revoke', 'device_setup_code_create', 'device_setup_options_get',
  'device_connection_host_discover', 'device_connection_read', 'device_connection_inspect', 'device_connection_check', 'device_connection_configure'] as const
export function registerDeviceOperatorTools(server: McpServer, context: OperatorRequestContext): void {
  const service = context.services.devices
  if (!service) return
  const reads = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  if (operatorToolAvailable(context, 'device_main_identity_get')) server.registerTool('device_main_identity_get', {
    description: 'Read this main application UUID and public Ed25519 fingerprint for explicit selected-main pairing approval. Requires global settings:read. No private keys or credentials.',
    inputSchema: z.object({}).strict(), outputSchema: MainDeviceIdentityPublicSchema, annotations: reads,
  }, () => invokeOperatorTool(context, 'device_main_identity_get', () => service.readMainIdentity(context.principal)))
  if (operatorToolAvailable(context, 'devices_list')) server.registerTool('devices_list', {
    description: 'Read persisted device registration, least-privilege scopes and authorization revisions. Requires global settings:read. Connection state and remote task admission are separate.',
    inputSchema: z.object({}).strict(), outputSchema: DeviceListResultSchema, annotations: reads,
  }, () => invokeOperatorTool(context, 'devices_list', async () => ({ devices: await service.list(context.principal) })))
  if (operatorToolAvailable(context, 'device_pairing_grant_create')) server.registerTool('device_pairing_grant_create', {
    description: 'Approve the exact worker fingerprint/scopes and issue a five-minute, single-use key-bound device pairing grant. Requires global settings:update and explicit selected identity approval. Treat the returned grant as secret. No dispatch/transfer scopes or provider credentials.',
    inputSchema: DevicePairingGrantInputSchema, outputSchema: DevicePairingGrantResultSchema,
    annotations: { ...reads, readOnlyHint: false },
  }, input => invokeOperatorTool(context, 'device_pairing_grant_create', () => service.createPairingGrant(context.principal, input, 'mcp')))
  if (operatorToolAvailable(context, 'device_setup_options_get')) server.registerTool('device_setup_options_get', {
    description: 'Read the explicitly configured public companion WSS endpoint and actual listener start state. Requires global settings:read; no guessed host, private TLS paths or connectivity claim.',
    inputSchema: z.object({}).strict(), outputSchema: DeviceSetupOptionsSchema, annotations: reads,
  }, () => invokeOperatorTool(context, 'device_setup_options_get', () => service.readSetupOptions(context.principal)))
  if (operatorToolAvailable(context, 'device_setup_code_create')) server.registerTool('device_setup_code_create', {
    description: 'Approve an exact companion public identity-request code and approved LAN WSS endpoint. Requires global settings:update; returns a private key-bound enrollment code with its original expiry. Retries retain original approval facts; this does not prove connectivity.',
    inputSchema: DeviceSetupApproveInputSchema, outputSchema: DeviceSetupApproveResultSchema, annotations: { ...reads, readOnlyHint: false },
  }, input => invokeOperatorTool(context, 'device_setup_code_create', () => service.createSetupCode(context.principal, input, 'mcp')))
  if (operatorToolAvailable(context, 'device_revoke')) server.registerTool('device_revoke', {
    description: 'Revision-check and durably revoke device authorization before fencing connections. Requires global settings:update. Retries use commandId. An unreachable process cannot be physically stopped; task leases are separate.',
    inputSchema: DeviceRevokeInputSchema, outputSchema: DeviceRegistrationSchema,
    annotations: { ...reads, readOnlyHint: false, destructiveHint: true },
  }, input => invokeOperatorTool(context, 'device_revoke', () => service.revoke(context.principal, input.deviceId, input.expectedRevision, input.commandId, 'mcp')))
}

const ToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.enum(DEVICE_OPERATOR_TOOLS) }).passthrough() }).passthrough()
/** Called by the existing authenticated /mcp dispatcher before SDK handling, including hidden tool calls. */
export async function unavailableDeviceOperatorToolCall(context: OperatorRequestContext, body: unknown) {
  const call = ToolCall.safeParse(body)
  if (!call.success || operatorToolAvailable(context, call.data.params.name)) return undefined
  const name = call.data.params.name
  const availableService = name === 'computer_activity_list' ? context.services.computerActivity
    : name === 'computer_accounts_list' ? context.services.computerAccounts
    : name.startsWith('computer_github_') ? context.services.computerGitHub
    : name.startsWith('build_computer') ? context.services.buildComputers
    : name.startsWith('device_connection_') ? context.services.trustedConnections : context.services.devices
  const error = availableService
    ? new DomainError('ACCESS_DENIED', 'Device management requires a compatible global settings grant.', 403)
    : new DomainError(name.startsWith('device_connection_') ? 'DEVICE_CONNECTION_UNAVAILABLE' : 'DEVICE_MANAGEMENT_UNAVAILABLE', 'The requested device service is not composed in this application.', 503)
  if (error.status === 403) await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(error) }
}
