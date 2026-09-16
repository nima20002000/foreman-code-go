import {
  AgentSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  GetAgentResponseSchema,
  GetRunResponseSchema,
  GetWorkflowResponseSchema,
  GetHarnessDefaultsResponseSchema,
  GetAgentDefaultsResponseSchema,
  UpdateAgentDefaultsResponseSchema,
  GetWorkflowDefaultsResponseSchema,
  UpdateWorkflowDefaultsResponseSchema,
  UpdateAgentDefaultsRequestSchema,
  UpdateWorkflowDefaultsRequestSchema,
  GetInteractionResponseSchema,
  ListInteractionsRequestSchema,
  ListInteractionsResponseSchema,
  RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
  ListAgentsResponseSchema,
  SaveWorkflowRequestSchema,
  SaveWorkflowResponseSchema,
  SaveHarnessDefaultsRequestSchema,
  SaveHarnessDefaultsResponseSchema,
  WorkspaceDetailsResponseSchema,
} from '@graphql/contracts'
import type { FastifyInstance } from 'fastify'

import { DomainError } from '../modules/errors.js'
import type { LangGraphWorkflowEngine } from '../modules/runs/engine.js'
import type { PostgresRunRepository } from '../modules/runs/postgres.js'
import type { PostgresSettingsRepository } from '../modules/settings/postgres.js'
import type { PostgresFoundationSettingsRepository } from '../modules/settings/foundation.js'
import type { PostgresInteractionRepository } from '../modules/interactions/postgres.js'
import type { DurableInteraction } from '@graphql/contracts'
import type { PostgresWorkflowRepository } from '../modules/workflows/postgres.js'
import type { PostgresWorkspaceRepository } from '../modules/workspaces/postgres.js'

export interface ProductServices {
  workspaces: PostgresWorkspaceRepository
  workflows: PostgresWorkflowRepository
  runs: PostgresRunRepository
  settings: PostgresSettingsRepository
  foundationSettings?: PostgresFoundationSettingsRepository
  interactions?: PostgresInteractionRepository
  interactionResponder?: {
    respond(input: { interactionId: string; optionId: string; expectedRevision: number }): Promise<{ interaction: DurableInteraction; replayed: boolean }>
  }
  engine: LangGraphWorkflowEngine
}

interface WorkspaceParams { workspaceId: string }
interface AgentParams extends WorkspaceParams { agentId: string }
interface WorkflowParams extends WorkspaceParams { workflowId: string }
interface RunParams extends WorkspaceParams { runId: string }

function notFound(kind: string, id: string): never {
  throw new DomainError(`${kind.toUpperCase()}_NOT_FOUND`, `${kind} '${id}' was not found.`, 404)
}

export function registerProductRoutes(app: FastifyInstance, services: ProductServices, managementOnlyMutations = false): void {
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

  if (services.interactions) {
    app.get<{ Querystring: Record<string, string | undefined> }>('/api/interactions', async (request) => {
      const input = ListInteractionsRequestSchema.parse({
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
        ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
        ...(request.query.workspaceId ? { workspaceId: request.query.workspaceId } : {}),
        ...(request.query.workflowId ? { workflowId: request.query.workflowId } : {}),
        ...(request.query.status ? { status: request.query.status } : {}),
      })
      const items = await services.interactions!.list({
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.cursor ? { afterId: input.cursor } : {}),
        limit: input.limit + 1,
      })
      return ListInteractionsResponseSchema.parse({
        items: items.slice(0, input.limit),
        nextCursor: items.length > input.limit ? items[input.limit - 1]?.id ?? null : null,
      })
    })
    app.get<{ Params: { interactionId: string } }>('/api/interactions/:interactionId', async (request) => {
      const interaction = await services.interactions!.get(request.params.interactionId)
      return interaction ? GetInteractionResponseSchema.parse({ interaction }) : notFound('interaction', request.params.interactionId)
    })
    app.post<{ Params: { interactionId: string }; Body: unknown }>('/api/interactions/:interactionId/respond', async (request) => {
      if (!services.interactionResponder) throw new DomainError('INTERACTION_RESPONSE_UNAVAILABLE', 'Approval delivery is not available.', 503)
      const input = RespondToInteractionRequestSchema.parse({ ...(request.body as object), interactionId: request.params.interactionId })
      return RespondToInteractionResponseSchema.parse(await services.interactionResponder.respond(input))
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
    const details = await services.workspaces.getDetails(request.params.workspaceId)
    return details ? WorkspaceDetailsResponseSchema.parse(details) : notFound('workspace', request.params.workspaceId)
  })

  app.get<{ Params: WorkspaceParams }>('/api/workspaces/:workspaceId/agents', async (request) =>
    ListAgentsResponseSchema.parse({ agents: await services.workspaces.listAgents(request.params.workspaceId) }))

  app.get<{ Params: AgentParams }>('/api/workspaces/:workspaceId/agents/:agentId', async (request) => {
    const agent = await services.workspaces.getAgent(request.params.workspaceId, request.params.agentId)
    return agent ? GetAgentResponseSchema.parse({ agent }) : notFound('agent', request.params.agentId)
  })

  app.put<{ Params: AgentParams; Body: unknown }>('/api/workspaces/:workspaceId/agents/:agentId', async (request) => {
    if (managementOnlyMutations) throw new DomainError('MANAGEMENT_ROUTE_REQUIRED', 'Use the shared graph draft commands to edit Agents.', 409)
    const agent = await services.workspaces.saveAgent(request.params.workspaceId, request.params.agentId, AgentSchema.parse(request.body))
    return GetAgentResponseSchema.parse({ agent })
  })

  app.get<{ Params: WorkflowParams }>('/api/workspaces/:workspaceId/workflows/:workflowId', async (request) => {
    const workflow = await services.workflows.get(request.params.workspaceId, request.params.workflowId)
    return workflow ? GetWorkflowResponseSchema.parse({ workflow }) : notFound('workflow', request.params.workflowId)
  })

  const saveWorkflow = async (request: {
    params: WorkspaceParams
    body: unknown
  }) => {
    if (managementOnlyMutations) throw new DomainError('MANAGEMENT_ROUTE_REQUIRED', 'Use the shared graph draft Save command.', 409)
    const input = SaveWorkflowRequestSchema.parse(request.body)
    if (input.workspaceId !== request.params.workspaceId) {
      throw new DomainError('INVALID_WORKFLOW', 'The workflow payload does not match the requested workspace.', 400)
    }
    const workflow = await services.workflows.save(input.workspaceId, input.workflow, input.agents)
    return SaveWorkflowResponseSchema.parse({
      workflow,
      agents: await services.workspaces.listAgents(input.workspaceId),
    })
  }

  app.put<{ Params: WorkflowParams; Body: unknown }>(
    '/api/workspaces/:workspaceId/workflows/:workflowId',
    async (request) => {
      const input = SaveWorkflowRequestSchema.parse(request.body)
      if (input.workflow.id !== request.params.workflowId) {
        throw new DomainError('INVALID_WORKFLOW', 'The workflow payload does not match the requested workflow.', 400)
      }
      return saveWorkflow(request)
    },
  )
  app.put<{ Params: WorkspaceParams; Body: unknown }>('/api/workspaces/:workspaceId/graph', saveWorkflow)

  app.post<{ Params: WorkflowParams; Body: unknown }>(
    '/api/workspaces/:workspaceId/workflows/:workflowId/runs',
    async (request, reply) => {
      if (managementOnlyMutations) throw new DomainError('MANAGEMENT_ROUTE_REQUIRED', 'Use the exact-version management Start command.', 409)
      const input = CreateRunRequestSchema.parse(request.body)
      if (input.workspaceId !== request.params.workspaceId || input.workflowId !== request.params.workflowId) {
        throw new DomainError('INVALID_RUN', 'The run payload does not match the requested workflow.', 400)
      }
      const run = await services.runs.createForWorkflow(
        input.workspaceId, input.workflowId, input.input, input.expectedLocationRevision,
      )
      setImmediate(() => {
        void services.engine.start(run.id).catch((error: unknown) => request.log.error({ err: error, runId: run.id }, 'run failed before terminal state'))
      })
      reply.code(202)
      return CreateRunResponseSchema.parse({ run })
    },
  )

  app.get<{ Params: RunParams }>('/api/workspaces/:workspaceId/runs/:runId', async (request) => {
    const details = await services.runs.getDetails(request.params.workspaceId, request.params.runId)
    return details ? GetRunResponseSchema.parse(details) : notFound('run', request.params.runId)
  })

  app.post<{ Params: RunParams }>('/api/workspaces/:workspaceId/runs/:runId/cancel', async (request) => {
    if (managementOnlyMutations) throw new DomainError('MANAGEMENT_ROUTE_REQUIRED', 'Use the idempotent management Stop command.', 409)
    const run = await services.runs.getForWorkspace(request.params.workspaceId, request.params.runId)
    if (!run) return notFound('run', request.params.runId)
    if (!await services.engine.cancel(run.id)) {
      throw new DomainError('RUN_NOT_CANCELABLE', `Run '${run.id}' is terminal or owned by another live engine.`, 409)
    }
    return { accepted: true, runId: run.id }
  })
}
