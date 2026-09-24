import type { FastifyInstance } from 'fastify'
import { GraphEditStageInputSchema, GraphEditReadInputSchema, GraphEditAdvanceInputSchema, GraphEditDiscardInputSchema } from '@graphql/contracts/wave25'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { OperatorServices } from '../mcp/operator/types.js'

type Params = Record<string, string>
function scoped(params: Params, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DomainError('INVALID_INPUT', 'An object body is required.', 400)
  const input = body as Record<string, unknown>
  for (const [key, value] of Object.entries(params)) if (Object.hasOwn(input, key) && input[key] !== value) {
    throw new DomainError('RESOURCE_ID_MISMATCH', `Body field '${key}' must match the URL.`, 400)
  }
  return { ...input, ...params }
}
export function registerGraphEditIntentRoutes(app: FastifyInstance, services: OperatorServices): void {
  const root = '/api/management/workspaces/:workspaceId/workflows/:workflowId/drafts/:draftId/edit-intents'
  app.get<{ Params: Params }>(root, async (request) => services.drafts.editIntents.read(requirePrincipal(request),
    GraphEditReadInputSchema.parse({ ...request.params, action: 'read_edits' })))
  app.get<{ Params: Params }>(`${root}/:intentId`, async (request) => services.drafts.editIntents.read(requirePrincipal(request),
    GraphEditReadInputSchema.parse({ ...request.params, action: 'read_edits' })))
  app.post<{ Params: Params; Body: unknown }>(root, async (request) => services.drafts.editIntents.stage(requirePrincipal(request), 'http',
    GraphEditStageInputSchema.parse(scoped(request.params, request.body))))
  app.post<{ Params: Params; Body: unknown }>(`${root}/:intentId/advance`, async (request) => services.drafts.editIntents.advance(requirePrincipal(request), 'http',
    GraphEditAdvanceInputSchema.parse(scoped(request.params, request.body)), services.runs.stop.bind(services.runs)))
  app.post<{ Params: Params; Body: unknown }>(`${root}/:intentId/discard`, async (request) => services.drafts.editIntents.discard(requirePrincipal(request), 'http',
    GraphEditDiscardInputSchema.parse(scoped(request.params, request.body))))
}
