import {
  AgentSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  GetAgentResponseSchema,
  GetRunResponseSchema,
  GetWorkflowResponseSchema,
  GetHarnessDefaultsResponseSchema,
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
import type { PostgresWorkflowRepository } from '../modules/workflows/postgres.js'
import type { PostgresWorkspaceRepository } from '../modules/workspaces/postgres.js'

export interface ProductServices {
  workspaces: PostgresWorkspaceRepository
  workflows: PostgresWorkflowRepository
  runs: PostgresRunRepository
  settings: PostgresSettingsRepository
  engine: LangGraphWorkflowEngine
}

interface WorkspaceParams { workspaceId: string }
interface AgentParams extends WorkspaceParams { agentId: string }
interface WorkflowParams extends WorkspaceParams { workflowId: string }
interface RunParams extends WorkspaceParams { runId: string }

function notFound(kind: string, id: string): never {
  throw new DomainError(`${kind.toUpperCase()}_NOT_FOUND`, `${kind} '${id}' was not found.`, 404)
}

export function registerProductRoutes(app: FastifyInstance, services: ProductServices): void {
  app.get('/api/settings/harnesses', async () => GetHarnessDefaultsResponseSchema.parse({
    defaults: await services.settings.getHarnessDefaults(),
  }))

  app.put<{ Body: unknown }>('/api/settings/harnesses', async (request) => {
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
      const input = CreateRunRequestSchema.parse(request.body)
      if (input.workspaceId !== request.params.workspaceId || input.workflowId !== request.params.workflowId) {
        throw new DomainError('INVALID_RUN', 'The run payload does not match the requested workflow.', 400)
      }
      const run = await services.runs.createForWorkflow(input.workspaceId, input.workflowId, input.input)
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
    const run = await services.runs.getForWorkspace(request.params.workspaceId, request.params.runId)
    if (!run) return notFound('run', request.params.runId)
    if (!await services.engine.cancel(run.id)) {
      throw new DomainError('RUN_NOT_CANCELABLE', `Run '${run.id}' is terminal or owned by another live engine.`, 409)
    }
    return { accepted: true, runId: run.id }
  })
}
