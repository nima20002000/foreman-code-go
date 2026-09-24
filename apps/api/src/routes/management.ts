import type { FastifyInstance } from 'fastify'
import { registerGraphEditIntentRoutes } from './graphEditIntent.js'
import { RUN_CURRENT_ROUTE, RunCurrentRequestSchema } from '@graphql/contracts/run-current'
import { RUN_HISTORY_ROUTE, RunHistoryRequestSchema } from '@graphql/contracts/run-history'
import { registerWorkspaceDefaultsRoutes } from './workspaceDefaults.js'
import { registerHarnessSettingsRoutes } from './harnessSettings.js'

import {
  AgentGetInputSchema,
  AgentDefaultsUpdateInputSchema,
  AgentListInputSchema,
  GraphDraftApplyInputSchema,
  GraphDraftLayoutInputSchema,
  GraphDraftRevertAppliedInputSchema,
  GraphDraftDiscardInputSchema,
  GraphDraftGetInputSchema,
  GraphDraftOpenInputSchema,
  GraphSaveInputSchema,
  GraphValidateInputSchema,
  HarnessDefaultsUpdateInputSchema,
  HarnessGetInputSchema,
  HarnessConfigurationCheckInputSchema,
  HarnessConfigurationCheckResultSchema,
  RunEventsListInputSchema,
  RunGetInputSchema,
  RunListInputSchema,
  RunStartInputSchema,
  RunStopInputSchema,
  WorkflowArchiveInputSchema,
  WorkflowCreateInputSchema,
  WorkflowGetInputSchema,
  WorkflowListInputSchema,
  WorkflowUpdateInputSchema,
  WorkspaceArchiveInputSchema,
  WorkspaceCreateInputSchema,
  WorkspaceGetInputSchema,
  WorkspaceListInputSchema,
  WorkspaceUpdateInputSchema,
  WorkspaceLocationSetInputSchema,
  WorkspaceLocationValidateInputSchema,
  WorkflowDefaultsUpdateInputSchema,
} from '@graphql/contracts/management'
import { GraphDraftApplyV2InputSchema, GraphSaveV2InputSchema, RunStartV2InputSchema } from '@graphql/contracts/wave25'
import { requireBrowserSession, requirePrincipal } from '../modules/access/http.js'
import type { OperatorServices } from '../mcp/operator/types.js'
import { DomainError } from '../modules/errors.js'

type Params = Record<string, string>
type Query = Record<string, string | undefined>

function routeInput(params: Params, body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new DomainError('INVALID_INPUT', 'The request body must be an object.', 400)
  }
  const input = body as Record<string, unknown>
  for (const [key, value] of Object.entries(params)) {
    if (Object.hasOwn(input, key) && input[key] !== value) {
      throw new DomainError('RESOURCE_ID_MISMATCH', `Body field '${key}' must match the URL.`, 400)
    }
  }
  return { ...input, ...params }
}

function page(query: Query) {
  return {
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.limit ? { limit: Number(query.limit) } : {}),
    ...(query.includeArchived ? { includeArchived: query.includeArchived === 'true' } : {}),
  }
}

export function registerManagementRoutes(app: FastifyInstance, services: OperatorServices): void {
  registerGraphEditIntentRoutes(app, services)
  registerWorkspaceDefaultsRoutes(app, services)
  registerHarnessSettingsRoutes(app, services)
  app.get<{ Querystring: Query }>('/api/management/workspaces', async (request) =>
    services.workspaces.list(requirePrincipal(request), WorkspaceListInputSchema.parse(page(request.query))))
  app.post<{ Body: unknown }>('/api/management/workspaces', async (request, reply) => {
    const input = WorkspaceCreateInputSchema.parse(request.body)
    if (input.parentPath) requireBrowserSession(request)
    const result = await services.workspaces.create(requirePrincipal(request), 'http', input)
    reply.code(result.replayed ? 200 : 201)
    return result
  })
  app.get<{ Params: Params }>('/api/management/workspaces/:workspaceId', async (request) => {
    const input = WorkspaceGetInputSchema.parse(request.params)
    return services.workspaces.get(requirePrincipal(request), input.workspaceId)
  })
  app.patch<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId', async (request) =>
    services.workspaces.update(requirePrincipal(request), 'http', WorkspaceUpdateInputSchema.parse(routeInput(request.params, request.body))))
  app.delete<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId', async (request) =>
    services.workspaces.archive(requirePrincipal(request), 'http', WorkspaceArchiveInputSchema.parse(routeInput(request.params, request.body))))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/location/validate', async (request) =>
    services.locations.validate(requirePrincipal(request), 'http', WorkspaceLocationValidateInputSchema.parse(routeInput(request.params, request.body))))
  app.put<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/location', async (request) =>
    services.locations.set(requirePrincipal(request), 'http', WorkspaceLocationSetInputSchema.parse(routeInput(request.params, request.body))))

  app.get<{ Params: Params; Querystring: Query }>('/api/management/workspaces/:workspaceId/workflows', async (request) =>
    services.workflows.list(requirePrincipal(request), WorkflowListInputSchema.parse({ ...request.params, ...page(request.query) })))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows', async (request, reply) => {
    const result = await services.workflows.create(requirePrincipal(request), 'http', WorkflowCreateInputSchema.parse(routeInput(request.params, request.body)))
    reply.code(result.replayed ? 200 : 201)
    return result
  })
  app.get<{ Params: Params }>('/api/management/workspaces/:workspaceId/workflows/:workflowId', async (request) => {
    const input = WorkflowGetInputSchema.parse(request.params)
    return services.workflows.get(requirePrincipal(request), input.workspaceId, input.workflowId)
  })
  app.patch<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/:workflowId', async (request) =>
    services.workflows.update(requirePrincipal(request), 'http', WorkflowUpdateInputSchema.parse(routeInput(request.params, request.body))))
  app.delete<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/:workflowId', async (request) =>
    services.workflows.archive(requirePrincipal(request), 'http', WorkflowArchiveInputSchema.parse(routeInput(request.params, request.body))))

  app.get<{ Params: Params; Querystring: Query }>('/api/management/workspaces/:workspaceId/agents', async (request) =>
    services.agents.list(requirePrincipal(request), AgentListInputSchema.parse({ ...page(request.query), ...(request.query.workflowId !== undefined ? { workflowId: request.query.workflowId } : {}), ...request.params })))
  app.get<{ Params: Params }>('/api/management/workspaces/:workspaceId/agents/:agentId', async (request) => {
    const input = AgentGetInputSchema.parse(request.params)
    return services.agents.get(requirePrincipal(request), input.workspaceId, input.agentId)
  })

  app.post<{ Params: Params }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/drafts', async (request) => {
    const input = GraphDraftOpenInputSchema.parse(request.params)
    return services.drafts.open(requirePrincipal(request), input.workspaceId, input.workflowId)
  })
  app.get<{ Params: Params }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/drafts/:draftId', async (request) => {
    const input = GraphDraftGetInputSchema.parse(request.params)
    return services.drafts.get(requirePrincipal(request), input.workspaceId, input.workflowId, input.draftId)
  })
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/drafts/:draftId/operations', async (request) =>
    services.drafts.apply(requirePrincipal(request), 'http', GraphDraftApplyInputSchema.or(GraphDraftApplyV2InputSchema).parse(routeInput(request.params, request.body))))
  app.put<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/drafts/:draftId/layout', async (request) =>
    services.drafts.setLayout(requirePrincipal(request), 'http', GraphDraftLayoutInputSchema.parse(routeInput(request.params, request.body))))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/drafts/:draftId/revert-applied', async (request) =>
    services.drafts.revertApplied(requirePrincipal(request), 'http', GraphDraftRevertAppliedInputSchema.parse(routeInput(request.params, request.body))))
  app.post<{ Params: Params }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/drafts/:draftId/validate', async (request) => {
    const input = GraphValidateInputSchema.parse(request.params)
    return services.drafts.validate(requirePrincipal(request), input.workspaceId, input.workflowId, input.draftId)
  })
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/drafts/:draftId/save', async (request) =>
    services.drafts.save(requirePrincipal(request), 'http', GraphSaveInputSchema.or(GraphSaveV2InputSchema).parse(routeInput(request.params, request.body))))
  app.delete<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/drafts/:draftId', async (request) =>
    services.drafts.discard(requirePrincipal(request), 'http', GraphDraftDiscardInputSchema.parse(routeInput(request.params, request.body))))

  app.post<{ Body: unknown }>('/api/management/harnesses/validate', async (request) => {
    const input = HarnessConfigurationCheckInputSchema.parse(request.body)
    return HarnessConfigurationCheckResultSchema.parse(await services.harnesses.checkConfiguration(requirePrincipal(request), input.configuration))
  })

  app.get('/api/management/harnesses', async (request) => services.harnesses.list(requirePrincipal(request)))
  app.get<{ Params: Params }>('/api/management/harnesses/:harness', async (request) => {
    const input = HarnessGetInputSchema.parse(request.params)
    return services.harnesses.get(requirePrincipal(request), input.harness)
  })
  app.put<{ Body: unknown }>('/api/management/harnesses/defaults', async (request) =>
    services.harnesses.updateDefaults(requirePrincipal(request), 'http', HarnessDefaultsUpdateInputSchema.parse(request.body)))

  if (services.settings) {
    app.get('/api/management/settings/agents', async (request) =>
      services.settings!.getAgentDefaults(requirePrincipal(request)))
    app.put<{ Body: unknown }>('/api/management/settings/agents', async (request) =>
      services.settings!.updateAgentDefaults(requirePrincipal(request), 'http', AgentDefaultsUpdateInputSchema.parse(request.body)))
    app.get('/api/management/settings/workflows', async (request) =>
      services.settings!.getWorkflowDefaults(requirePrincipal(request)))
    app.put<{ Body: unknown }>('/api/management/settings/workflows', async (request) =>
      services.settings!.updateWorkflowDefaults(requirePrincipal(request), 'http', WorkflowDefaultsUpdateInputSchema.parse(request.body)))
  }

  app.get<{ Params: Params; Querystring: Query }>('/api/management/workspaces/:workspaceId/runs', async (request) =>
    services.runs.list(requirePrincipal(request), RunListInputSchema.parse({ ...page(request.query), ...(request.query.workflowId !== undefined ? { workflowId: request.query.workflowId } : {}), ...request.params })))
  app.get<{ Params: Params; Querystring: Query }>(RUN_CURRENT_ROUTE, async (request) =>
    services.runs.current(requirePrincipal(request), RunCurrentRequestSchema.parse({
      ...request.query, ...request.params,
      executionSemanticsVersion: request.query.executionSemanticsVersion === '1' ? 1 : undefined,
    })))
  app.get<{ Params: Params; Querystring: Query }>(RUN_HISTORY_ROUTE, async (request) =>
    services.runs.history(requirePrincipal(request), RunHistoryRequestSchema.parse({
      ...request.query, ...request.params,
      executionSemanticsVersion: request.query.executionSemanticsVersion === '1' ? 1 : undefined,
    })))
  app.get<{ Params: Params }>('/api/management/workspaces/:workspaceId/runs/:runId', async (request) => {
    const input = RunGetInputSchema.parse(request.params)
    return services.runs.get(requirePrincipal(request), input.workspaceId, input.runId)
  })
  app.get<{ Params: Params; Querystring: Query }>('/api/management/workspaces/:workspaceId/runs/:runId/events', async (request) =>
    services.runs.events(requirePrincipal(request), RunEventsListInputSchema.parse({
      ...request.params,
      ...(request.query.cursor ? { afterSequence: Number(request.query.cursor) } : {}),
      ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
    })))
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/workflows/:workflowId/runs', async (request, reply) => {
    const result = await services.runs.start(requirePrincipal(request), 'http', RunStartInputSchema.or(RunStartV2InputSchema).parse(routeInput(request.params, request.body)))
    reply.code(202)
    return result
  })
  app.post<{ Params: Params; Body: unknown }>('/api/management/workspaces/:workspaceId/runs/:runId/stop', async (request) =>
    services.runs.stop(requirePrincipal(request), 'http', RunStopInputSchema.parse(routeInput(request.params, request.body))))
}
