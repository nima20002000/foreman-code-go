import { http, HttpResponse, type RequestHandler } from 'msw'
import { settingsExperienceHandlers, resetSettingsExperienceFixtures } from './settingsExperienceHandlers'
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
  AgentDefaultsUpdateInputSchema,
  HarnessConfigurationCheckInputSchema,
  HarnessDefaultsUpdateInputSchema,
  WorkflowDefaultsUpdateInputSchema,
  WorkspaceLocationSetInputSchema,
  WorkspaceLocationValidateInputSchema,
  type ManagedWorkspace,
} from '@graphql/contracts/management'

import {
  getMockFixture,
  getMockAgentDefaults,
  getMockHarnessCatalog,
  getMockHarnessDefaults,
  getMockMessages,
  getMockScenarioRevision,
  getMockScenarioState,
  getMockWorkflowDefaults,
  resetMockFixtures as resetExistingMockFixtures,
  serializeAgent,
  serializeConversation,
  shouldFailMutation,
  updateMockWorkflow,
  updateMockAgents,
  updateMockAgentDefaults,
  updateMockHarnessDefaults,
  updateMockManagedHarnessDefaults,
  updateMockWorkflowDefaults,
  appendMockMessage,
  type MockFailureMode,
} from './scenarios'

const managedWorkspaceNames = new Map<string, string>()
const managedWorkspaceDescriptions = new Map<string, string | undefined>()
const managedWorkspaceArchives = new Set<string>()
const managedWorkspaces = new Map<string, ManagedWorkspace>()
const managedWorkflowArchives = new Set<string>()
let managedScenarioRevision = getMockScenarioRevision()

function syncManagedFixtures() {
  const revision = getMockScenarioRevision()
  if (revision === managedScenarioRevision) return
  managedScenarioRevision = revision
  managedWorkspaceNames.clear()
  managedWorkspaceDescriptions.clear()
  managedWorkspaceArchives.clear()
  managedWorkspaces.clear()
  managedWorkflowArchives.clear()
}

export function resetTestFixtures() {
  resetExistingMockFixtures()
  resetSettingsExperienceFixtures()
  managedWorkspaceNames.clear()
  managedWorkspaceDescriptions.clear()
  managedWorkspaceArchives.clear()
  managedWorkspaces.clear()
  managedWorkflowArchives.clear()
  mockLocations.clear()
  managedScenarioRevision = getMockScenarioRevision()
}

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

const operatorConversations: Array<Record<string, unknown>> = []
const operatorMessages = new Map<string, Array<Record<string, unknown>>>()

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

function visibleManagedWorkspace(workspaceId: string) {
  syncManagedFixtures()
  const stored = managedWorkspaces.get(workspaceId)
  const base = stored ?? managedWorkspace(workspaceId)
  if (!base) return undefined
  return {
    ...base,
    workspace: {
      ...base.workspace,
      name: managedWorkspaceNames.get(workspaceId) ?? base.workspace.name,
      description: managedWorkspaceDescriptions.has(workspaceId)
        ? managedWorkspaceDescriptions.get(workspaceId)
        : base.workspace.description,
    },
    archivedAt: managedWorkspaceArchives.has(workspaceId) ? new Date().toISOString() : null,
  }
}

function managedWorkflow(workflow: WorkflowDefinition) {
  syncManagedFixtures()
  return {
    workflow,
    revision: 1,
    currentVersionId: `${workflow.id}-v1`,
    archivedAt: managedWorkflowArchives.has(workflow.id) ? new Date().toISOString() : null,
  }
}

export const handlers: RequestHandler[] = [
  ...settingsExperienceHandlers,
  http.get('/api/operator/setup', () => HttpResponse.json({ harness: getMockAgentDefaults().value.operator.harness.harness,
    status: 'configured', configurationVersionId: 'operator-config',
    endpoint: 'http://127.0.0.1:3000/mcp/operator', checkedAt: new Date().toISOString() })),
  http.get('/api/operator/conversations/summaries', () => HttpResponse.json({
    conversations: operatorConversations.map((item) => ({
      conversationId: item.id, title: item.title, turnState: 'idle', revision: 0,
      activeRequestId: null, needsAttention: false,
    })),
  })),
  http.get('/api/operator/conversations', () => HttpResponse.json({ conversations: operatorConversations })),
  http.post('/api/operator/conversations', () => {
    const now = new Date().toISOString()
    const conversation = { id: crypto.randomUUID(), agentId: 'application-operator', scope: 'application', operatorConfigurationVersionId: 'operator-config-v1', title: 'New conversation', status: 'open', createdAt: now, updatedAt: now }
    operatorConversations.unshift(conversation); operatorMessages.set(String(conversation.id), [])
    return HttpResponse.json({ conversation }, { status: 201 })
  }),
  http.get('/api/operator/conversations/:conversationId', ({ params }) => {
    const id = String(params.conversationId); let conversation = operatorConversations.find((item) => item.id === id)
    if (!conversation) {
      const now = new Date().toISOString()
      conversation = { id, agentId: 'application-operator', scope: 'application', operatorConfigurationVersionId: 'operator-config-v1', title: 'New conversation', status: 'open', createdAt: now, updatedAt: now }
      operatorConversations.unshift(conversation); operatorMessages.set(id, [])
    }
    return HttpResponse.json({ conversation, messages: operatorMessages.get(id) ?? [], turnState: 'idle' })
  }),
  http.get('/api/operator/conversations/:conversationId/events', ({ params }) => {
    const body = `event: snapshot\ndata: ${JSON.stringify({ conversationId: String(params.conversationId) })}\n\n`
    return new HttpResponse(body, { headers: { 'content-type': 'text/event-stream' } })
  }),
  http.post('/api/operator/conversations/:conversationId/messages', async ({ params, request }) => {
    const id = String(params.conversationId); const conversation = operatorConversations.find((item) => item.id === id)
    if (!conversation) return fixtureNotFound('conversation', id)
    const body = await readJson(request) as { requestId?: string; content?: string }
    const now = new Date().toISOString(); const messages = operatorMessages.get(id) ?? []
    messages.push({ id: crypto.randomUUID(), conversationId: id, role: 'user', content: body.content ?? '', createdAt: now, updatedAt: now })
    messages.push({ id: crypto.randomUUID(), conversationId: id, role: 'assistant', content: 'Deterministic Operator response.', createdAt: now, updatedAt: now })
    operatorMessages.set(id, messages)
    return HttpResponse.json({ state: { conversation, messages, turnState: 'idle' }, replayed: false }, { status: 202 })
  }),
  http.get('/api/management/interactions', () => HttpResponse.json({
    items: [], nextCursor: null, pendingCount: 0, pendingByWorkflow: {},
  })),
  http.get('/api/management/harnesses/:harness/execution-readiness', ({ params }) => HttpResponse.json({
    harness: params.harness, scope: 'saved-harness-defaults', status: 'unverified', rolloutEnabled: false,
    defaultsRevision: null, checkedAt: new Date().toISOString(),
    reason: { code: 'HARNESS_DISCOVERY_UNAVAILABLE', message: 'Execution qualification has not been checked.' },
    limitation: 'Deterministic fixture; no native execution.',
  })),
  http.get('/api/management/harnesses', () => HttpResponse.json(getMockHarnessCatalog())),
  http.get('/api/management/harnesses/:harness/options', ({ params }) => {
    const harness = String(params.harness)
    if (harness !== 'codex' && harness !== 'opencode') return fixtureNotFound('harness', harness)
    return HttpResponse.json({
      harness, providerVersion: 'mock', authenticated: true,
      models: harness === 'codex' ? [
        { id: 'gpt-5.6-luna', name: 'gpt-5.6-luna', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], variants: [], serviceTiers: ['standard', 'priority'] },
        { id: 'gpt-5.6-terra', name: 'gpt-5.6-terra', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], variants: [], serviceTiers: ['standard', 'priority'] },
        { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], variants: [], serviceTiers: ['standard', 'priority'] },
        { id: 'gpt-6-astra', name: 'gpt-6-astra', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], variants: [], serviceTiers: ['standard', 'priority'] },
      ] : [{ id: 'opencode-go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoningEfforts: [], variants: ['', 'low', 'high', 'max', 'provider-custom-effort', 'budget-4096'], serviceTiers: [] }],
      nativeAgents: harness === 'opencode' ? ['', 'custom-worker'] : [], settings: [], restrictions: [], checkedAt: new Date().toISOString(),
    })
  }),
  http.post('/api/management/harnesses/:harness/refresh', ({ params }) => HttpResponse.json({
    harness: params.harness, providerVersion: 'mock', authenticated: true, models: [], nativeAgents: [], settings: [], restrictions: [], checkedAt: new Date().toISOString(),
  })),
  http.get('/api/management/harnesses/:harness/mcp', ({ params }) => HttpResponse.json({
    harness: params.harness, revision: `sha256:${'0'.repeat(64)}`, servers: [], checkedAt: new Date().toISOString(), scope: 'native-user',
  })),
  http.get('/api/management/harnesses/:harness/mcp/plans', () => HttpResponse.json({ items: [] })),
  http.post('/api/management/harnesses/validate', async ({ request }) => {
    const parsed = HarnessConfigurationCheckInputSchema.safeParse(await readJson(request))
    if (!parsed.success) return apiError('INVALID_HARNESS_CONFIGURATION', 'Review the Harness configuration.', 400)
    return HttpResponse.json({
      configuration: parsed.data.configuration,
      qualification: {
        harness: parsed.data.configuration.harness,
        version: 'mock',
        authenticated: true,
        ready: true,
        structuredEvents: true,
        supportsResume: true,
        supportsCancellation: true,
        supportsWorkingDirectory: true,
        supportsStartupPrompt: true,
        supportedNativeTools: [],
        supportedSettings: [],
        unsupportedCapabilities: [],
      },
      checkedAt: new Date().toISOString(),
    })
  }),
  http.put('/api/management/harnesses/defaults', async ({ request }) => {
    const parsed = HarnessDefaultsUpdateInputSchema.safeParse(await readJson(request))
    if (!parsed.success) return apiError('INVALID_HARNESS_DEFAULTS', 'Review the Harness defaults.', 400)
    const value = updateMockManagedHarnessDefaults(parsed.data.defaults, parsed.data.expectedRevision)
    return value
      ? HttpResponse.json({ value, replayed: false })
      : apiError('REVISION_CONFLICT', 'Harness defaults changed since they were read.', 409, { currentRevision: getMockHarnessCatalog()[0]?.defaultsRevision ?? 0 })
  }),
  http.get('/api/management/settings/agents', () => HttpResponse.json(getMockAgentDefaults())),
  http.put('/api/management/settings/agents', async ({ request }) => {
    const parsed = AgentDefaultsUpdateInputSchema.safeParse(await readJson(request))
    if (!parsed.success) return apiError('INVALID_AGENT_DEFAULTS', 'Review the Agent defaults.', 400)
    const value = updateMockAgentDefaults(parsed.data.value, parsed.data.expectedRevision)
    return value
      ? HttpResponse.json({ value, replayed: false })
      : apiError('REVISION_CONFLICT', 'Agent defaults changed since they were read.', 409, { currentRevision: getMockAgentDefaults().revision })
  }),
  http.get('/api/management/settings/workflows', () => HttpResponse.json(getMockWorkflowDefaults())),
  http.put('/api/management/settings/workflows', async ({ request }) => {
    const parsed = WorkflowDefaultsUpdateInputSchema.safeParse(await readJson(request))
    if (!parsed.success) return apiError('INVALID_WORKFLOW_DEFAULTS', 'Review the Workflow defaults.', 400)
    const value = updateMockWorkflowDefaults(parsed.data.value, parsed.data.expectedRevision)
    return value
      ? HttpResponse.json({ value, replayed: false })
      : apiError('REVISION_CONFLICT', 'Workflow defaults changed since they were read.', 409, { currentRevision: getMockWorkflowDefaults().revision })
  }),
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
  http.get('/api/management/workspaces', () => {
    const failure = readFailure()
    if (failure) return failure
    const base = visibleManagedWorkspace('workspace-1')
    const items = [base, ...managedWorkspaces.values()]
      .filter((item): item is NonNullable<typeof item> => Boolean(item && !item.archivedAt))
    return HttpResponse.json({ items, pageInfo: { nextCursor: null } })
  }),
  http.post('/api/management/workspaces', async ({ request }) => {
    const body = await readJson(request) as { name?: string; description?: string; parentPath?: string }
    if (!body?.name?.trim()) return apiError('INVALID_REQUEST', 'A workspace name is required.', 400)
    const id = `workspace-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    const value = {
      workspace: {
        id, name: body.name.trim(), ...(body.description ? { description: body.description } : {}),
        agentIds: [], workflowIds: [], createdAt: now, updatedAt: now,
      },
      revision: 1,
      archivedAt: null,
      executionLocation: body.parentPath ? { runnerId: 'runner-local', rootPath: body.parentPath.replace(/\/$/, '') + '/' + body.name.trim() } : null,
      locationRevision: body.parentPath ? 1 : 0,
      locationValidation: body.parentPath ? { status: 'ready' as const, checkedAt: now } : { status: 'unconfigured' as const },
    }
    managedWorkspaces.set(id, value)
    return HttpResponse.json({ value, replayed: false }, { status: 201 })
  }),
  http.patch('/api/management/workspaces/:workspaceId', async ({ params, request }) => {
    const workspaceId = String(params.workspaceId)
    const current = visibleManagedWorkspace(workspaceId)
    if (!current) return fixtureNotFound('workspace', workspaceId)
    const body = await readJson(request) as { name?: string; description?: string }
    if (body.name !== undefined) managedWorkspaceNames.set(workspaceId, body.name)
    if (body.description !== undefined) managedWorkspaceDescriptions.set(workspaceId, body.description)
    const value = { ...visibleManagedWorkspace(workspaceId)!, revision: current.revision + 1 }
    if (managedWorkspaces.has(workspaceId)) managedWorkspaces.set(workspaceId, value)
    return HttpResponse.json({ value, replayed: false })
  }),
  http.delete('/api/management/workspaces/:workspaceId', ({ params }) => {
    const workspaceId = String(params.workspaceId)
    const current = visibleManagedWorkspace(workspaceId)
    if (!current) return fixtureNotFound('workspace', workspaceId)
    managedWorkspaceArchives.add(workspaceId)
    const value = { ...visibleManagedWorkspace(workspaceId)!, revision: current.revision + 1 }
    if (managedWorkspaces.has(workspaceId)) managedWorkspaces.set(workspaceId, value)
    return HttpResponse.json({ value, replayed: false })
  }),
  http.get('/api/management/workspaces/:workspaceId/workflows', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const fixture = getMockFixture(String(params.workspaceId))
    if (!fixture) return HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })
    const items = fixture.workflows
      .filter((workflow) => !managedWorkflowArchives.has(workflow.id))
      .map(managedWorkflow)
    return HttpResponse.json({ items, pageInfo: { nextCursor: null } })
  }),
  http.get('/api/management/workspaces/:workspaceId/workflows/:workflowId', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workflow = getMockFixture(String(params.workspaceId))?.workflows.find((item) => item.id === params.workflowId)
    if (!workflow || managedWorkflowArchives.has(workflow.id)) return fixtureNotFound('workflow', String(params.workflowId))
    return HttpResponse.json(managedWorkflow(workflow))
  }),
  http.post('/api/management/workspaces/:workspaceId/workflows', async ({ params, request }) => {
    const workspaceId = String(params.workspaceId)
    if (!getMockFixture(workspaceId)) return fixtureNotFound('workspace', workspaceId)
    const body = await readJson(request) as { name?: string; description?: string }
    if (!body?.name?.trim()) return apiError('INVALID_REQUEST', 'A workflow name is required.', 400)
    const now = new Date().toISOString()
    const workflow = updateMockWorkflow(workspaceId, {
      id: `workflow-${crypto.randomUUID()}`,
      workspaceId,
      name: body.name.trim(),
      ...(body.description ? { description: body.description } : {}),
      executionCondition: { kind: 'manual' },
      nodes: [],
      edges: [],
      createdAt: now,
      updatedAt: now,
    })
    return HttpResponse.json({ value: managedWorkflow(workflow), replayed: false }, { status: 201 })
  }),
  http.patch('/api/management/workspaces/:workspaceId/workflows/:workflowId', async ({ params, request }) => {
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    const current = fixture?.workflows.find((workflow) => workflow.id === String(params.workflowId))
    if (!current) return fixtureNotFound('workflow', String(params.workflowId))
    const body = await readJson(request) as { name?: string; description?: string }
    const workflow = updateMockWorkflow(workspaceId, {
      ...current,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      updatedAt: new Date().toISOString(),
    })
    return HttpResponse.json({ value: { ...managedWorkflow(workflow), revision: 2 }, replayed: false })
  }),
  http.delete('/api/management/workspaces/:workspaceId/workflows/:workflowId', ({ params }) => {
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    const current = fixture?.workflows.find((workflow) => workflow.id === String(params.workflowId))
    if (!current) return fixtureNotFound('workflow', String(params.workflowId))
    managedWorkflowArchives.add(current.id)
    return HttpResponse.json({ value: { ...managedWorkflow(current), revision: 2 }, replayed: false })
  }),
  http.get('/api/management/workspaces/:workspaceId/agents', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const fixture = getMockFixture(String(params.workspaceId))
    const items = fixture?.agents.map((agent) => ({ agent: serializeAgent(agent), metadataRevision: 1 })) ?? []
    return HttpResponse.json({ items, pageInfo: { nextCursor: null } })
  }),
  http.post('/api/management/workspaces/:workspaceId/workflows/:workflowId/drafts', ({ params }) => {
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    const workflow = fixture?.workflows.find((item) => item.id === String(params.workflowId))
    if (!workflow) return fixtureNotFound('workflow', String(params.workflowId))
    return HttpResponse.json({
      id: `draft-${workflow.id}`,
      workspaceId,
      workflowId: workflow.id,
      revision: 0,
      baseWorkflowVersionId: `${workflow.id}-v1`,
      publishedRevision: 1,
      graph: workflow,
      stagedAgents: [],
      updatedByPrincipalId: 'principal-test',
      updatedAt: new Date().toISOString(),
    })
  }),
  http.get('/api/management/workspaces/:workspaceId/workflows/:workflowId/drafts/:draftId', ({ params }) => {
    const workspaceId = String(params.workspaceId)
    const workflow = getMockFixture(workspaceId)?.workflows.find((item) => item.id === String(params.workflowId))
    if (!workflow || String(params.draftId) !== `draft-${workflow.id}`) return fixtureNotFound('draft', String(params.draftId))
    return HttpResponse.json({
      id: `draft-${workflow.id}`,
      workspaceId,
      workflowId: workflow.id,
      revision: 0,
      baseWorkflowVersionId: `${workflow.id}-v1`,
      publishedRevision: 1,
      graph: workflow,
      stagedAgents: [],
      updatedByPrincipalId: 'principal-test',
      updatedAt: new Date().toISOString(),
    })
  }),
  http.get('/api/management/workspaces/:workspaceId/runs', () =>
    HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })),
  http.get('/api/management/workspaces/:workspaceId', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const result = visibleManagedWorkspace(String(params.workspaceId))
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
