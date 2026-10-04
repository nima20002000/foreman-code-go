import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { HostHarnessOverrideListInputSchema, HostHarnessOverrideListSchema, HostHarnessOverrideSaveSchema, HostHarnessOverrideSaveResultSchema, HostHarnessInstanceCheckInputSchema, HostHarnessInstanceCheckResultSchema } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { hasAction } from '../../access/policy.js'
import { toolFailure, toolResult } from '../../../mcp/shared/results.js'
import type { OperatorRequestContext } from '../../../mcp/operator/types.js'
import { DomainError } from '../../errors.js'
import type { HostHarnessOverrideService } from './service.js'

const HOST_HARNESS_TOOLS = ['harness_instances_list', 'harness_instance_check', 'harness_instance_save'] as const
type HostHarnessToolName = typeof HOST_HARNESS_TOOLS[number]

function hostHarnessToolAvailable(service: HostHarnessOverrideService | undefined, principal: ManagementPrincipal, name: HostHarnessToolName): boolean {
  if (!service) return false
  if (name === 'harness_instances_list') return hasAction(principal, 'harnesses:read')
  if (name === 'harness_instance_save') return hasAction(principal, 'harnesses:update')
  return service.qualificationSupported && hasAction(principal, 'harnesses:read') && hasAction(principal, 'harnesses:update')
}

/** Hidden host tools still receive an authenticated denial; discovery stays grant-filtered. */
export async function unavailableHostHarnessToolCall(context: OperatorRequestContext, body: unknown) {
  const call = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
    method: z.literal('tools/call'), params: z.object({ name: z.enum(HOST_HARNESS_TOOLS), arguments: z.unknown().optional() }).passthrough(),
  }).passthrough().safeParse(body)
  if (!call.success) return undefined
  const name = call.data.params.name, service = context.services.harnessInstances
  if (hostHarnessToolAvailable(service, context.principal, name)) return undefined
  const error = !service
    ? new DomainError('HARNESS_INSTANCES_UNAVAILABLE', 'Host harness settings are not composed.', 503)
    : name === 'harness_instance_check' && hasAction(context.principal, 'harnesses:read') && hasAction(context.principal, 'harnesses:update')
      ? new DomainError('HARNESS_PROFILE_CHECK_UNAVAILABLE', 'Exact-host profile qualification is not composed.', 503)
      : new DomainError('ACCESS_DENIED', 'The caller is not authorized for this host harness operation.', 403)
  if (error.status === 403) {
    const instance = z.object({ instanceId: z.uuid() }).passthrough().safeParse(call.data.params.arguments)
    const targetKey = name === 'harness_instances_list' ? 'harness-instances'
      : instance.success ? `harness-instance:${instance.data.instanceId}` : `mcp:${name}`
    await context.services.commands.recordDenied(context.principal.id, 'mcp', name, targetKey)
  }
  return { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(error, 'Host harness settings failed.') }
}

export function registerHostHarnessOverrideRoutes(app: FastifyInstance, service: HostHarnessOverrideService,
  authenticate: (request: FastifyRequest) => Promise<ManagementPrincipal>): void {
  // POST read accepts the canonical nested host reference without ad-hoc query encodings.
  app.post('/api/management/harness-instances/read', async request => HostHarnessOverrideListSchema.parse(
    await service.list(await authenticate(request), HostHarnessOverrideListInputSchema.parse(request.body))))
  app.post('/api/management/harness-instances/check', async request => HostHarnessInstanceCheckResultSchema.parse(
    await service.check(await authenticate(request), 'http', HostHarnessInstanceCheckInputSchema.parse(request.body))))
  app.post('/api/management/harness-instances/save', async request => HostHarnessOverrideSaveResultSchema.parse(
    await service.save(await authenticate(request), 'http', HostHarnessOverrideSaveSchema.parse(request.body))))
}
export function registerHostHarnessOverrideTools(server: McpServer, service: HostHarnessOverrideService, principal: ManagementPrincipal): void {
  const invoke = async (operation: () => Promise<unknown>) => {
    try { return toolResult(await operation()) } catch (error) { return toolFailure(error, 'Host harness settings failed.') }
  }
  if (hostHarnessToolAvailable(service, principal, 'harness_instances_list')) server.registerTool('harness_instances_list', {
    description: 'Read persisted host-instance overrides separately from global defaults. Qualification matches the exact target installation and profile; no discovery spawn or fallback.',
    inputSchema: HostHarnessOverrideListInputSchema, outputSchema: HostHarnessOverrideListSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invoke(() => service.list(principal, input, 'mcp')))
  if (hostHarnessToolAvailable(service, principal, 'harness_instance_check')) server.registerTool('harness_instance_check', {
    description: 'Explicitly qualify one exact saved host profile through its admitted native factory/worker. Claude runs a finite subscription conversation and tool-policy scenarios on disposable files; it consumes subscription capacity. This may start owned diagnostic native processes; listing settings never does. Requires read and update grants; retains idempotent check receipts and exact-target evidence.',
    inputSchema: HostHarnessInstanceCheckInputSchema, outputSchema: HostHarnessInstanceCheckResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invoke(() => service.check(principal, 'mcp', input)))
  if (hostHarnessToolAvailable(service, principal, 'harness_instance_save')) server.registerTool('harness_instance_save', {
    description: 'Create or revision-check a host-specific harness override. Writes preserve immutable history; installed/authenticated/qualified are separate and saved configuration is unavailable until exact-target qualification.',
    inputSchema: HostHarnessOverrideSaveSchema, outputSchema: HostHarnessOverrideSaveResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invoke(() => service.save(principal, 'mcp', input)))
}
