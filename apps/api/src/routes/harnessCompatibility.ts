import type { FastifyInstance } from 'fastify'
import {
  HarnessCompatibilityListSchema, HarnessCompatibilitySchema,
  HarnessCompatibilityRetryBodySchema, HarnessCompatibilityRetryParamsSchema,
} from '@foreman-code/contracts'
import { requirePrincipal } from '../modules/access/http.js'
import type { HarnessCompatibilityService } from '../modules/harnesses/compatibility/service.js'

/** Register after the local-human and credential scope checks. */
export function registerHarnessCompatibilityRoutes(app: FastifyInstance, service: HarnessCompatibilityService): void {
  app.get('/api/management/harnesses/compatibility', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return HarnessCompatibilityListSchema.parse(service.read(requirePrincipal(request)))
  })
  app.post('/api/management/harnesses/:harness/compatibility/retry', async (request, reply) => {
    const { harness } = HarnessCompatibilityRetryParamsSchema.parse(request.params)
    HarnessCompatibilityRetryBodySchema.parse(request.body ?? {})
    const result = await service.requestRetry(requirePrincipal(request), 'http', harness)
    reply.code(202).header('cache-control', 'no-store')
    return HarnessCompatibilitySchema.parse(result)
  })
}
