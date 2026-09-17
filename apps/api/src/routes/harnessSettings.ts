import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  HarnessOptionsInputSchema, HarnessOptionsResultSchema, HarnessMcpListInputSchema, HarnessMcpListResultSchema,
  HarnessMcpPlanInputSchema, HarnessMcpPlanResultSchema, HarnessMcpPlansResultSchema, HarnessMcpPlanSchema,
  HarnessMcpPlanGetInputSchema, HarnessMcpDecisionInputSchema,
  HarnessDirectoryBrowseInputSchema, HarnessDirectoryBrowseResultSchema,
} from '@graphql/contracts/management'
import { requirePrincipal } from '../modules/access/http.js'
import { requireAuthorization } from '../modules/access/policy.js'
import { DomainError } from '../modules/errors.js'
import type { OperatorServices } from '../mcp/operator/types.js'

function requireBrowserReview(request: FastifyRequest, mutation = true): void {
  if (request.headers.authorization || !/(?:^|;)\s*graphql_operator=/.test(request.headers.cookie ?? '') || (mutation && !request.headers.origin)) {
    throw new DomainError('MCP_BROWSER_REVIEW_REQUIRED', 'Review this change in the signed-in browser.', 403)
  }
}

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
  app.get('/api/management/harnesses/mcp/plans/:planId', async (request) => HarnessMcpPlanSchema.parse(
    await settings().mcp.get(requirePrincipal(request), HarnessMcpPlanGetInputSchema.parse(request.params).planId)))
  app.post('/api/management/harnesses/mcp/decision', async (request) => {
    requireBrowserReview(request)
    const input = HarnessMcpDecisionInputSchema.parse(request.body)
    return HarnessMcpPlanSchema.parse(await settings().mcp.decide(requirePrincipal(request), input.planId, input.approve))
  })
  app.get('/api/management/harnesses/directories', async (request) => {
    requireBrowserReview(request, false)
    return HarnessDirectoryBrowseResultSchema.parse(await settings().directories.browse(requirePrincipal(request), HarnessDirectoryBrowseInputSchema.parse(request.query)))
  })
}
