import type { FastifyInstance } from 'fastify'
import {
  RepeatCapabilityRequestSchema,
  RepeatRunReadInputSchema,
  RepeatSaveInputSchema,
  RepeatWorkflowReadInputSchema,
} from '@graphql/contracts/wave25'

import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { RepeatAuthoringService } from '../modules/repeats/authoring.js'
import type { RepeatReadbackService } from '../modules/repeats/readback.js'

type Params = Record<string, string>
type Query = Record<string, string | undefined>
const RunQuerySchema = RepeatRunReadInputSchema.pick({ cursor: true, limit: true, includeResultData: true }).strict()

export interface RepeatRouteServices {
  authoring: RepeatAuthoringService
  readback: RepeatReadbackService
}

function resultDataFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new DomainError('INVALID_INPUT', 'includeResultData must be true or false.', 400)
}

function routeInput(params: Params, body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new DomainError('INVALID_INPUT', 'The request body must be an object.', 400)
  }
  const value = body as Record<string, unknown>
  for (const [key, item] of Object.entries(params)) {
    if (Object.hasOwn(value, key) && value[key] !== item) {
      throw new DomainError('RESOURCE_ID_MISMATCH', `Body field '${key}' must match the URL.`, 400)
    }
  }
  return { ...value, ...params }
}

export function registerRepeatRoutes(app: FastifyInstance, services: RepeatRouteServices): void {
  app.get<{ Querystring: Query }>('/api/management/repeats/capabilities', async (request) =>
    services.authoring.capabilities(requirePrincipal(request), RepeatCapabilityRequestSchema.parse(request.query)))

  app.get<{ Params: Params }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/repeat', async (request) =>
    services.readback.workflow(requirePrincipal(request), RepeatWorkflowReadInputSchema.parse(request.params)))

  app.put<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/repeat', async (request) =>
    services.authoring.save(requirePrincipal(request), 'http', RepeatSaveInputSchema.parse(routeInput(request.params, request.body))))

  app.get<{ Params: Params; Querystring: Query }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/repeats', async (request) => {
    const principal = requirePrincipal(request)
    const query = RunQuerySchema.parse({
      ...request.query,
      ...(request.query.limit !== undefined ? { limit: Number(request.query.limit) } : {}),
      ...(request.query.includeResultData !== undefined
        ? { includeResultData: resultDataFlag(request.query.includeResultData) } : {}),
    })
    return services.readback.run(principal, RepeatRunReadInputSchema.parse({ ...query, ...request.params }))
  })
}
