import { http, HttpResponse, type RequestHandler } from 'msw'
import {
  ApiErrorResponseSchema,
  CreateRunRequestSchema,
  CreateMessageRequestSchema,
  SaveHarnessDefaultsRequestSchema,
  SaveWorkflowRequestSchema,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@graphql/contracts'
import {
  WorkspaceLocationSetInputSchema,
  WorkspaceLocationValidateInputSchema,
} from '@graphql/contracts/management'

import {
  MOCK_SCENARIOS,
  getMockFixture,
  getMockHarnessDefaults,
  getMockMessages,
  getMockScenarioState,
  isMockScenario,
  resetMockFixtures,
  serializeAgent,
  setMockFailureMode,
  setMockScenario,
  serializeConversation,
  shouldFailMutation,
  updateMockWorkflow,
  updateMockAgents,
  updateMockHarnessDefaults,
  appendMockMessage,
  type MockFailureMode,
} from './scenarios'

const errorSchema = ApiErrorResponseSchema

function apiError(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
) {
  const body = { error: { code, message, ...(details ? { details } : {}) } }
  // Keep fixture failures contract-shaped too; this catches accidental drift
  // while the handlers are authored.
  errorSchema.parse(body)
  return HttpResponse.json(body, { status })
}

function readFailure() {
  if (getMockScenarioState().scenarioId !== 'error') return undefined
  return apiError('MOCK_READ_FAILED', 'The selected mock scenario fails read requests.', 503)
}

function fixtureNotFound(kind: string, id: string) {
  return apiError(
    kind === 'workspace' ? 'WORKSPACE_NOT_FOUND' : 'NOT_FOUND',
    `${kind} '${id}' was not found.`,
    404,
  )
}

function isFailureMode(value: string | null): value is MockFailureMode {
  return value === 'none' || value === 'graph-save' || value === 'user-message' || value === 'all'
}

function explicitFailureMode(request: Request): string | null {
  const value = request.headers.get('x-mock-fail-mode') ?? new URL(request.url).searchParams.get('fail')
  return isFailureMode(value) ? value : null
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

function scenarioResponse() {
  return HttpResponse.json({
    scenarioId: getMockScenarioState().scenarioId,
    failureMode: getMockScenarioState().failureMode,
    scenarios: MOCK_SCENARIOS,
  })
}

const mockStartedRun: WorkflowRun = {
  id: 'run-mock-started',
  workspaceId: 'workspace-1',
  workflowId: 'workflow-editor-test',
  workflowVersionId: 'workflow-editor-test-v1',
  agentConfigurationVersionIds: {},
  executionCondition: { kind: 'manual' },
  executionState: 'completed',
  outcome: 'succeeded',
  input: {},
  result: { outcome: 'succeeded', output: { text: 'Mock test result' } },
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z',
}

const mockLocations = new Map<string, { rootPath: string; revision: number }>()

function managedWorkspace(workspaceId: string) {
  const fixture = getMockFixture(workspaceId)
  if (!fixture) return undefined
  const location = mockLocations.get(workspaceId)
  return {
    workspace: fixture.workspace,
    revision: 1,
    archivedAt: null,
    executionLocation: location ? { runnerId: 'runner-local', rootPath: location.rootPath } : null,
    locationRevision: location?.revision ?? 0,
    locationValidation: location
      ? { status: 'ready' as const, checkedAt: new Date().toISOString() }
      : { status: 'unconfigured' as const },
  }
}

export const handlers: RequestHandler[] = [
  http.get('/api/management/interactions', () => HttpResponse.json({
    items: [], nextCursor: null, pendingCount: 0, pendingByWorkflow: {},
  })),
  http.get('/api/management/workspaces/:workspaceId/harnesses/:harness/mcp-detection', ({ params }) => {
    const harness = String(params.harness)
    if (harness !== 'codex' && harness !== 'opencode') return fixtureNotFound('harness', harness)
    return HttpResponse.json({
      runnerId: 'runner-local',
      workingDirectory: '/workspace',
      providerVersion: 'mock',
      nativeFilters: {},
      detection: {
        harness,
        serverName: 'graphql-app',
        state: 'not_detected',
        endpointMatches: null,
        credentialEnvironmentVariable: null,
        checkedAt: '2026-09-16T00:00:00.000Z',
      },
    })
  }),
  http.get('/api/management/workspaces/:workspaceId', ({ params }) => {
    const result = managedWorkspace(String(params.workspaceId))
    return result ? HttpResponse.json(result) : fixtureNotFound('workspace', String(params.workspaceId))
  }),
  http.post('/api/management/workspaces/:workspaceId/location/validate', async ({ request, params }) => {
    const parsed = WorkspaceLocationValidateInputSchema.safeParse({
      workspaceId: String(params.workspaceId), ...await readJson(request) as object,
    })
    if (!parsed.success || !parsed.data.rootPath.startsWith('/')) {
      return apiError('WORKSPACE_LOCATION_NOT_ABSOLUTE', 'The workspace location must be an absolute runner path.', 400)
    }
    return HttpResponse.json({
      workspaceId: parsed.data.workspaceId,
      location: { runnerId: parsed.data.runnerId, rootPath: parsed.data.rootPath },
      accessMode: parsed.data.accessMode,
      checkedAt: new Date().toISOString(),
    })
  }),
  http.put('/api/management/workspaces/:workspaceId/location', async ({ request, params }) => {
    const parsed = WorkspaceLocationSetInputSchema.safeParse({
      workspaceId: String(params.workspaceId), ...await readJson(request) as object,
    })
    if (!parsed.success) return apiError('INVALID_REQUEST', 'The location request is invalid.', 400)
    const current = mockLocations.get(parsed.data.workspaceId)
    if ((current?.revision ?? 0) !== parsed.data.expectedLocationRevision) {
      return apiError('LOCATION_REVISION_CONFLICT', 'The workspace location changed since it was read.', 409, {
        currentLocationRevision: current?.revision ?? 0,
      })
    }
    const next = { rootPath: parsed.data.rootPath, revision: (current?.revision ?? 0) + 1 }
    mockLocations.set(parsed.data.workspaceId, next)
    const validation = {
      workspaceId: parsed.data.workspaceId,
      location: { runnerId: parsed.data.runnerId, rootPath: parsed.data.rootPath },
      accessMode: 'read-only' as const,
      checkedAt: new Date().toISOString(),
    }
    return HttpResponse.json({
      value: {
        workspaceId: parsed.data.workspaceId,
        executionLocation: validation.location,
        locationRevision: next.revision,
        validation,
      },
      replayed: false,
    })
  }),
  http.get('/api/settings/harnesses', () => HttpResponse.json({
    defaults: getMockHarnessDefaults(),
  })),
  http.put('/api/settings/harnesses', async ({ request }) => {
    const parsed = SaveHarnessDefaultsRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) return apiError('INVALID_HARNESS_DEFAULTS', 'Review the harness defaults.', 400)
    return HttpResponse.json({ defaults: updateMockHarnessDefaults(parsed.data.defaults) })
  }),

  // Mock controls are intentionally separate from product resource endpoints.
  http.get('/api/mock/scenario', () => scenarioResponse()),
  http.post('/api/mock/scenario', async ({ request }) => {
    const body = await readJson(request)
    if (!body || typeof body !== 'object') return apiError('INVALID_SCENARIO', 'A scenario selection is required.', 400)
    const value = body as { scenarioId?: unknown; failureMode?: unknown }
    if (typeof value.scenarioId !== 'string' || !isMockScenario(value.scenarioId)) {
      return apiError('INVALID_SCENARIO', 'The requested mock scenario is not available.', 400)
    }
    if (value.failureMode !== undefined && (typeof value.failureMode !== 'string' || !isFailureMode(value.failureMode))) {
      return apiError('INVALID_FAILURE_MODE', 'The requested mock failure mode is not available.', 400)
    }
    setMockScenario(value.scenarioId, (value.failureMode as MockFailureMode | undefined) ?? 'none')
    return scenarioResponse()
  }),
  http.put('/api/mock/scenario', async ({ request }) => {
    const body = await readJson(request)
    if (!body || typeof body !== 'object') return apiError('INVALID_SCENARIO', 'A scenario selection is required.', 400)
    const value = body as { scenarioId?: unknown; failureMode?: unknown }
    if (typeof value.scenarioId !== 'string' || !isMockScenario(value.scenarioId)) {
      return apiError('INVALID_SCENARIO', 'The requested mock scenario is not available.', 400)
    }
    if (value.failureMode !== undefined && (typeof value.failureMode !== 'string' || !isFailureMode(value.failureMode))) {
      return apiError('INVALID_FAILURE_MODE', 'The requested mock failure mode is not available.', 400)
    }
    setMockScenario(value.scenarioId, (value.failureMode as MockFailureMode | undefined) ?? 'none')
    return scenarioResponse()
  }),
  http.post('/api/mock/reset', () => {
    resetMockFixtures()
    mockLocations.clear()
    return scenarioResponse()
  }),
  http.post('/api/mock/failures', async ({ request }) => {
    const body = await readJson(request)
    const value = body && typeof body === 'object' ? (body as { failureMode?: unknown }).failureMode : undefined
    if (typeof value !== 'string' || !isFailureMode(value)) {
      return apiError('INVALID_FAILURE_MODE', 'A valid mock failure mode is required.', 400)
    }
    setMockFailureMode(value)
    return scenarioResponse()
  }),

  http.post('/api/workspaces/:workspaceId/workflows/:workflowId/runs', async ({ request, params }) => {
    const body = await readJson(request)
    const parsed = CreateRunRequestSchema.safeParse(body)
    if (!parsed.success) return apiError('INVALID_RUN', 'The run request is invalid.', 400)
    return HttpResponse.json({
      run: {
        ...mockStartedRun,
        workspaceId: String(params.workspaceId),
        workflowId: String(params.workflowId),
        executionState: 'queued',
        outcome: 'pending',
        result: undefined,
        startedAt: undefined,
        finishedAt: undefined,
      },
    }, { status: 202 })
  }),
  http.get('/api/workspaces/:workspaceId/runs/:runId', ({ params }) => HttpResponse.json({
    run: {
      ...mockStartedRun,
      id: String(params.runId),
      workspaceId: String(params.workspaceId),
    },
    executions: [],
    activity: [],
  })),

  http.get('/api/workspaces/:workspaceId', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    if (!fixture) return fixtureNotFound('workspace', workspaceId)
    return HttpResponse.json({
      workspace: fixture.workspace,
      agents: fixture.agents.map(serializeAgent),
      workflows: fixture.workflows,
      runs: fixture.runs,
      resources: fixture.resources,
      browserProfiles: fixture.browserProfiles,
      runners: fixture.runners,
    })
  }),
  http.get('/api/workspaces/:workspaceId/agents', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    if (!fixture) return fixtureNotFound('workspace', workspaceId)
    return HttpResponse.json({ agents: fixture.agents.map(serializeAgent) })
  }),
  http.get('/api/workspaces/:workspaceId/agents/:agentId', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    if (!fixture) return fixtureNotFound('workspace', workspaceId)
    const agent = fixture.agents.find((item) => item.id === String(params.agentId))
    return agent
      ? HttpResponse.json({ agent: serializeAgent(agent) })
      : fixtureNotFound('agent', String(params.agentId))
  }),
  http.get('/api/workspaces/:workspaceId/workflows/:workflowId', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    if (!fixture) return fixtureNotFound('workspace', workspaceId)
    const workflow = fixture.workflows.find((item) => item.id === String(params.workflowId))
    return workflow ? HttpResponse.json({ workflow }) : fixtureNotFound('workflow', String(params.workflowId))
  }),
  http.put('/api/workspaces/:workspaceId/workflows/:workflowId', async ({ request, params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workspaceId = String(params.workspaceId)
    if (!getMockFixture(workspaceId)) return fixtureNotFound('workspace', workspaceId)
    const body = await readJson(request)
    const parsed = SaveWorkflowRequestSchema.safeParse(body)
    if (!parsed.success || parsed.data.workspaceId !== workspaceId || parsed.data.workflow.id !== String(params.workflowId)) {
      return apiError('INVALID_WORKFLOW', 'The workflow payload does not match the requested resource.', 400)
    }
    if (shouldFailMutation('graph-save', explicitFailureMode(request))) {
      return apiError('MOCK_GRAPH_SAVE_FAILED', 'The selected mock mode rejects graph saves.', 503)
    }
    const workflow = updateMockWorkflow(parsed.data.workspaceId, parsed.data.workflow)
    const agents = parsed.data.agents
      ? updateMockAgents(parsed.data.workspaceId, parsed.data.agents)
      : getMockFixture(workspaceId)!.agents
    return HttpResponse.json({ workflow, agents })
  }),
  http.put('/api/workspaces/:workspaceId/graph', async ({ request, params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workspaceId = String(params.workspaceId)
    if (!getMockFixture(workspaceId)) return fixtureNotFound('workspace', workspaceId)
    const body = await readJson(request)
    const parsed = SaveWorkflowRequestSchema.safeParse(body)
    if (!parsed.success || parsed.data.workspaceId !== workspaceId) {
      return apiError('INVALID_WORKFLOW', 'The graph payload does not match the requested workspace.', 400)
    }
    if (shouldFailMutation('graph-save', explicitFailureMode(request))) {
      return apiError('MOCK_GRAPH_SAVE_FAILED', 'The selected mock mode rejects graph saves.', 503)
    }
    const workflow = updateMockWorkflow(parsed.data.workspaceId, parsed.data.workflow)
    const agents = parsed.data.agents
      ? updateMockAgents(parsed.data.workspaceId, parsed.data.agents)
      : getMockFixture(workspaceId)!.agents
    return HttpResponse.json({ workflow, agents })
  }),
  http.get('/api/workspaces/:workspaceId/conversations', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    if (!fixture) return fixtureNotFound('workspace', workspaceId)
    return HttpResponse.json({
      conversations: fixture.conversations.map(serializeConversation),
    })
  }),
  http.get('/api/workspaces/:workspaceId/conversations/:conversationId', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    if (!fixture) return fixtureNotFound('workspace', workspaceId)
    const conversationId = String(params.conversationId)
    const conversation = fixture.conversations.find((item) => item.id === conversationId)
    return conversation
      ? HttpResponse.json({ conversation: serializeConversation(conversation), messages: getMockMessages(conversationId) })
      : fixtureNotFound('conversation', conversationId)
  }),
  http.get('/api/workspaces/:workspaceId/conversations/:conversationId/messages', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    if (!fixture) return fixtureNotFound('workspace', workspaceId)
    const conversationId = String(params.conversationId)
    if (!fixture.conversations.some((item) => item.id === conversationId)) return fixtureNotFound('conversation', conversationId)
    return HttpResponse.json({ messages: getMockMessages(conversationId) })
  }),
  http.post('/api/workspaces/:workspaceId/conversations/:conversationId/messages', async ({ request, params }) => {
    const failure = readFailure()
    if (failure) return failure
    const body = await readJson(request)
    const parsed = CreateMessageRequestSchema.safeParse(body)
    const workspaceId = String(params.workspaceId)
    const conversationId = String(params.conversationId)
    const fixture = getMockFixture(workspaceId)
    if (!fixture) return fixtureNotFound('workspace', workspaceId)
    if (!parsed.success || parsed.data.workspaceId !== workspaceId || parsed.data.conversationId !== conversationId || parsed.data.role !== 'user') {
      return apiError('INVALID_MESSAGE', 'Only a user message for the requested conversation can be sent.', 400)
    }
    if (!fixture.conversations.some((item) => item.id === conversationId)) return fixtureNotFound('conversation', conversationId)
    if (shouldFailMutation('user-message', explicitFailureMode(request))) {
      return apiError('MOCK_USER_MESSAGE_FAILED', 'The selected mock mode rejects user messages.', 503)
    }
    const message = appendMockMessage(workspaceId, {
      conversationId,
      role: 'user',
      content: parsed.data.content,
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    })
    return HttpResponse.json({ message }, { status: 201 })
  }),
  http.get('/api/workspaces/:workspaceId/resources', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    if (!fixture) return fixtureNotFound('workspace', workspaceId)
    return HttpResponse.json({
      resources: fixture.resources,
      browserProfiles: fixture.browserProfiles,
      runners: fixture.runners,
    })
  }),
]

export type { WorkflowDefinition }
