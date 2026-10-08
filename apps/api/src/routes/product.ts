import {
  GetHarnessDefaultsResponseSchema,
  GetAgentDefaultsResponseSchema,
  UpdateAgentDefaultsResponseSchema,
  GetWorkflowDefaultsResponseSchema,
  UpdateWorkflowDefaultsResponseSchema,
  UpdateAgentDefaultsRequestSchema,
  UpdateWorkflowDefaultsRequestSchema,
  ListAgentsResponseSchema,
  ListInteractionsResponseSchema,
  GetInteractionResponseSchema,
  RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
  SaveHarnessDefaultsRequestSchema,
  SaveHarnessDefaultsResponseSchema,
} from '@foreman-code/contracts'
import { SavedWorkspaceDetailsSchema, SavedWorkflowResponseSchema, SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import type { OperatorServices } from '../mcp/operator/types.js'
import { InteractionListInputSchema } from '@foreman-code/contracts/management'
import type { FastifyInstance } from 'fastify'

import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { LangGraphWorkflowEngine } from '../modules/runs/engine.js'
import type { PostgresRunRepository } from '../modules/runs/postgres.js'
import type { PostgresSettingsRepository } from '../modules/settings/postgres.js'
import type { PostgresFoundationSettingsRepository } from '../modules/settings/foundation.js'
import type { PostgresWorkflowRepository } from '../modules/workflows/postgres.js'
import type { PostgresWorkspaceRepository } from '../modules/workspaces/postgres.js'
import type { OperatorChatService } from '../modules/conversations/operatorChat.js'
import { registerOperatorChatRoutes } from './operatorChat.js'
import type { InteractionService } from '../modules/interactions/service.js'

export interface ProductServices {
  workspaces: PostgresWorkspaceRepository
  workflows: PostgresWorkflowRepository
  runs: PostgresRunRepository
  settings: PostgresSettingsRepository
  foundationSettings?: PostgresFoundationSettingsRepository
  engine: LangGraphWorkflowEngine
  chat?: OperatorChatService
  interactions?: InteractionService
}

interface WorkspaceParams { workspaceId: string }
interface WorkflowParams extends WorkspaceParams { workflowId: string }
interface RunParams extends WorkspaceParams { runId: string }

function notFound(kind: string, id: string): never {
  throw new DomainError(`${kind.toUpperCase()}_NOT_FOUND`, `${kind} '${id}' was not found.`, 404)
}

export function registerProductRoutes(app: FastifyInstance, services: ProductServices, managementOnlyMutations = false, management?: Pick<OperatorServices, 'workflows' | 'runs'>): void {
  if (services.chat) registerOperatorChatRoutes(app, services.chat)
  if (services.foundationSettings) {
    app.get('/api/settings/agents', async () => GetAgentDefaultsResponseSchema.parse(
      await services.foundationSettings!.getAgentDefaults(),
    ))
    app.put<{ Body: unknown }>('/api/settings/agents', async (request) => {
      if (managementOnlyMutations) throw new DomainError('MANAGEMENT_ROUTE_REQUIRED', 'Use the revision-checked management settings command.', 409)
      const input = UpdateAgentDefaultsRequestSchema.parse(request.body)
      return UpdateAgentDefaultsResponseSchema.parse(await services.foundationSettings!.updateAgentDefaults(input.value, input.expectedRevision))
    })
    app.get('/api/settings/workflows', async () => GetWorkflowDefaultsResponseSchema.parse(
      await services.foundationSettings!.getWorkflowDefaults(),
    ))
    app.put<{ Body: unknown }>('/api/settings/workflows', async (request) => {
      if (managementOnlyMutations) throw new DomainError('MANAGEMENT_ROUTE_REQUIRED', 'Use the revision-checked management settings command.', 409)
      const input = UpdateWorkflowDefaultsRequestSchema.parse(request.body)
      return UpdateWorkflowDefaultsResponseSchema.parse(await services.foundationSettings!.updateWorkflowDefaults(input.value, input.expectedRevision))
    })
  }
  app.get('/api/settings/harnesses', async () => GetHarnessDefaultsResponseSchema.parse({
    defaults: await services.settings.getHarnessDefaults(),
  }))

  app.put<{ Body: unknown }>('/api/settings/harnesses', async (request) => {
    if (managementOnlyMutations) throw new DomainError('MANAGEMENT_ROUTE_REQUIRED', 'Use the revision-checked management defaults command.', 409)
    const input = SaveHarnessDefaultsRequestSchema.parse(request.body)
    return SaveHarnessDefaultsResponseSchema.parse({
      defaults: await services.settings.saveHarnessDefaults(input.defaults),
    })
  })

  app.get<{ Params: WorkspaceParams }>('/api/workspaces/:workspaceId', async (request) => {
    const details = await services.workspaces.getDetails(request.params.workspaceId, requirePrincipal(request))
    return details ? SavedWorkspaceDetailsSchema.parse(details) : notFound('workspace', request.params.workspaceId)
  })

  app.get<{ Params: WorkspaceParams }>('/api/workspaces/:workspaceId/agents', async (request) =>
    ListAgentsResponseSchema.parse({ agents: await services.workspaces.listAgents(request.params.workspaceId) }))

  app.get<{ Params: WorkflowParams }>('/api/workspaces/:workspaceId/workflows/:workflowId', async (request) => {
    const principal = requirePrincipal(request)
    if (!management) throw new DomainError('WORKFLOW_SERVICES_UNAVAILABLE', 'Current workflow services are not composed.', 503)
    const managed = await management.workflows.get(principal, request.params.workspaceId, request.params.workflowId)
    return SavedWorkflowResponseSchema.parse({ workflow: managed.workflow })
  })

  // Raw workflow Save/Start and cancel adapters are retired. All mutations use
  // the authenticated revision/receipt-checked current management family.
  app.get<{ Params: RunParams }>('/api/workspaces/:workspaceId/runs/:runId', async (request) => {
    const principal = requirePrincipal(request)
    if (!management) throw new DomainError('RUN_SERVICES_UNAVAILABLE', 'Current Run services are not composed.', 503)
    const details = await management.runs.get(principal, request.params.workspaceId, request.params.runId)
    return details ? SavedRunDetailsSchema.parse(details) : notFound('run', request.params.runId)
  })

  const interactions = services.interactions
  if (interactions) {
    if (managementOnlyMutations) {
      app.get<{ Querystring: unknown }>('/api/management/interactions', async (request) => {
        const query = request.query as Record<string, unknown>
        const input = InteractionListInputSchema.parse({
          ...query, ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
        })
        return ListInteractionsResponseSchema.parse(await interactions.listVisible(requirePrincipal(request), input))
      })
      app.get<{ Params: { interactionId: string } }>('/api/management/interactions/:interactionId', async (request) => {
        const detail = await interactions.reviewStatusVisible(requirePrincipal(request), request.params.interactionId)
        return GetInteractionResponseSchema.parse({ ...detail, canRespond: detail.activity.response.available })
      })
      app.post<{ Params: { interactionId: string }; Body: unknown }>(
        '/api/management/interactions/:interactionId/respond', async (request) => {
          const input = RespondToInteractionRequestSchema.parse(request.body)
          if (input.interactionId !== request.params.interactionId) {
            throw new DomainError('INVALID_INTERACTION', 'The response does not match the requested interaction.', 400)
          }
          return RespondToInteractionResponseSchema.parse(await interactions.respond(
            { kind: 'operator', principal: requirePrincipal(request) }, input))
        })
    }
  }

}
