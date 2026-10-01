import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { McpServer } from '@modelcontextprotocol/server'
import { HostHarnessOverrideListInputSchema, HostHarnessOverrideListSchema, HostHarnessOverrideSaveSchema, HostHarnessOverrideSaveResultSchema, HostHarnessInstanceCheckInputSchema, HostHarnessInstanceCheckResultSchema } from '@graphql/contracts/harness-registry'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { hasAction } from '../../access/policy.js'
import { toolFailure, toolResult } from '../../../mcp/shared/results.js'
import type { HostHarnessOverrideService } from './service.js'

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
  if (hasAction(principal, 'harnesses:read')) server.registerTool('harness_instances_list', {
    description: 'Read persisted host-instance overrides separately from global defaults. Qualification matches the exact target installation and profile; no discovery spawn or fallback.',
    inputSchema: HostHarnessOverrideListInputSchema, outputSchema: HostHarnessOverrideListSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invoke(() => service.list(principal, input, 'mcp')))
  if (service.qualificationSupported && hasAction(principal, 'harnesses:read') && hasAction(principal, 'harnesses:update')) server.registerTool('harness_instance_check', {
    description: 'Explicitly qualify one exact saved host profile through its admitted native factory/worker. This may start owned diagnostic native processes; listing settings never does. Requires read and update grants; retains idempotent check receipts and exact-target evidence.',
    inputSchema: HostHarnessInstanceCheckInputSchema, outputSchema: HostHarnessInstanceCheckResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invoke(() => service.check(principal, 'mcp', input)))
  if (hasAction(principal, 'harnesses:update')) server.registerTool('harness_instance_save', {
    description: 'Create or revision-check a host-specific harness override. Writes preserve immutable history; installed/authenticated/qualified are separate and saved configuration is unavailable until exact-target qualification.',
    inputSchema: HostHarnessOverrideSaveSchema, outputSchema: HostHarnessOverrideSaveResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invoke(() => service.save(principal, 'mcp', input)))
}
