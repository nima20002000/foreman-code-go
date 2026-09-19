import type { FastifyInstance } from 'fastify'
import {
  HarnessCompatibilityListSchema, HarnessCompatibilitySchema,
  HarnessCompatibilityRetryBodySchema, HarnessCompatibilityRetryParamsSchema,
} from '@graphql/contracts'
import { requirePrincipal } from '../modules/access/http.js'
import { isAuthorized, requireAuthorization } from '../modules/access/policy.js'
import type { HarnessCompatibilityService } from '../modules/harnesses/compatibility/service.js'

/** Register only after Operator authentication/CSRF hooks. No caller-selected commands or paths. */
export function registerHarnessCompatibilityRoutes(app: FastifyInstance, service: HarnessCompatibilityService): void {
  app.get('/api/management/harnesses/compatibility', async (request, reply) => {
    requireAuthorization(requirePrincipal(request), 'harnesses:read')
    reply.header('cache-control', 'no-store')
    return HarnessCompatibilityListSchema.parse({ harnesses: service.list(), canRetry: isAuthorized(requirePrincipal(request), 'harnesses:update') })
  })
  app.post('/api/management/harnesses/:harness/compatibility/retry', async (request, reply) => {
    requireAuthorization(requirePrincipal(request), 'harnesses:update')
    const { harness } = HarnessCompatibilityRetryParamsSchema.parse(request.params)
    HarnessCompatibilityRetryBodySchema.parse(request.body ?? {})
    const result = service.retry(harness)
    reply.code(202).header('cache-control', 'no-store')
    return HarnessCompatibilitySchema.parse(result)
  })
}
