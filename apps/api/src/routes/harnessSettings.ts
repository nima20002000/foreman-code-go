import type { FastifyInstance } from 'fastify'
import {
  HarnessOptionsInputSchema, HarnessOptionsResultSchema, HarnessMcpListInputSchema, HarnessMcpListResultSchema,
  HarnessMcpManagedInputSchema, HarnessMcpPlanInputSchema, HarnessMcpPlanResultSchema, HarnessMcpPlansResultSchema, HarnessMcpPlanSchema,
  HarnessMcpPlanGetInputSchema, HarnessMcpDecisionInputSchema, HarnessMcpReconcileInputSchema,
  HarnessDirectoryBrowseInputSchema, HarnessDirectoryBrowseResultSchema,
  WorkspaceFolderUndoInputSchema, WorkspaceFolderUndoResultSchema,
  WorkspaceFolderCreateInputSchema, WorkspaceFolderCreateResultSchema, WorkspaceFolderRenameInputSchema, WorkspaceFolderRenameResultSchema,
} from '@graphql/contracts/management'
import { requireBrowserSession, requirePrincipal } from '../modules/access/http.js'
import { requireAuthorization } from '../modules/access/policy.js'
import { DomainError } from '../modules/errors.js'
import type { OperatorServices } from '../mcp/operator/types.js'
import { WorkspaceFolderDeleteInputSchema, WorkspaceFolderDeleteResultSchema } from '@graphql/contracts/management'

export function registerHarnessSettingsRoutes(app: FastifyInstance, services: OperatorServices): void {
  app.get('/api/management/harnesses/:harness/options', async (request) => {
    requireAuthorization(requirePrincipal(request), 'harnesses:read')
    const { harness } = HarnessOptionsInputSchema.parse(request.params)
    if (!services.extensions?.native) throw new DomainError('NATIVE_OPTIONS_UNAVAILABLE', 'Native model discovery is unavailable.', 503)
    return HarnessOptionsResultSchema.parse(await services.extensions.native.options(harness))
  })
  app.post('/api/management/harnesses/:harness/refresh', async (request) => {
    requireAuthorization(requirePrincipal(request), 'harnesses:read')
    const { harness } = HarnessOptionsInputSchema.parse(request.params)
    services.harnesses.invalidateChecks()
    services.extensions?.native.invalidateOptions()
    if (!services.extensions?.native) throw new DomainError('NATIVE_OPTIONS_UNAVAILABLE', 'Native discovery is unavailable.', 503)
    return HarnessOptionsResultSchema.parse(await services.extensions.native.options(harness))
  })
  const settings = () => {
    if (!services.harnessSettings) throw new DomainError('HARNESS_SETTINGS_UNAVAILABLE', 'Native connection management is unavailable.', 503)
    return services.harnessSettings
  }
  app.get('/api/management/harnesses/:harness/mcp', async (request) => {
    const { harness } = HarnessMcpListInputSchema.parse(request.params)
    return HarnessMcpListResultSchema.parse(await settings().mcp.list(requirePrincipal(request), harness))
  })
  app.get('/api/management/harnesses/:harness/mcp/plans', async (request) => {
    const { harness } = HarnessMcpListInputSchema.parse(request.params)
    return HarnessMcpPlansResultSchema.parse(await settings().mcp.plans(requirePrincipal(request), harness))
  })
  app.post('/api/management/harnesses/mcp/plans', async (request) => HarnessMcpPlanResultSchema.parse(
    await settings().mcp.plan(requirePrincipal(request), 'http', HarnessMcpPlanInputSchema.parse(request.body))))
  app.post('/api/management/harnesses/mcp/managed', async (request) => {
    requireBrowserSession(request)
    return HarnessMcpPlanSchema.parse(await settings().mcp.applyManaged(requirePrincipal(request), HarnessMcpManagedInputSchema.parse(request.body)))
  })
  app.get('/api/management/harnesses/mcp/plans/:planId', async (request) => HarnessMcpPlanSchema.parse(
    await settings().mcp.get(requirePrincipal(request), HarnessMcpPlanGetInputSchema.parse(request.params).planId)))
  app.post('/api/management/harnesses/mcp/reconcile', async (request) => {
    requireBrowserSession(request)
    return HarnessMcpPlanResultSchema.parse(await settings().mcp.reconcile(
      requirePrincipal(request), HarnessMcpReconcileInputSchema.parse(request.body)))
  })
  app.post('/api/management/harnesses/mcp/decision', async (request) => {
    requireBrowserSession(request)
    const input = HarnessMcpDecisionInputSchema.parse(request.body)
    return HarnessMcpPlanSchema.parse(await settings().mcp.decide(requirePrincipal(request), input.planId, input.approve))
  })
  app.post('/api/management/harnesses/directories/delete', async (request) => {
    requireBrowserSession(request)
    return WorkspaceFolderDeleteResultSchema.parse(await settings().directories.deleteFolders(
      requirePrincipal(request), 'http', WorkspaceFolderDeleteInputSchema.parse(request.body)))
  })
  app.post('/api/management/harnesses/directories/undo', async (request) => {
    requireBrowserSession(request)
    return WorkspaceFolderUndoResultSchema.parse(await settings().directories.undoCreated(
      requirePrincipal(request), 'http', WorkspaceFolderUndoInputSchema.parse(request.body)))
  })
  app.post('/api/management/harnesses/directories/rename', async (request) => {
    requireBrowserSession(request)
    return WorkspaceFolderRenameResultSchema.parse(await settings().directories.renameCreated(
      requirePrincipal(request), 'http', WorkspaceFolderRenameInputSchema.parse(request.body)))
  })
  app.post('/api/management/harnesses/directories', async (request) => {
    requireBrowserSession(request)
    return WorkspaceFolderCreateResultSchema.parse(await settings().directories.create(
      requirePrincipal(request), 'http', WorkspaceFolderCreateInputSchema.parse(request.body)))
  })
  app.get('/api/management/harnesses/directories', async (request) => {
    requireBrowserSession(request)
    return HarnessDirectoryBrowseResultSchema.parse(await settings().directories.browse(requirePrincipal(request), HarnessDirectoryBrowseInputSchema.parse(request.query)))
  })
}
