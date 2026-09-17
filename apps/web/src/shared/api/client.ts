import {
  ApiErrorResponseSchema,
  CreateMessageRequestSchema,
  CreateMessageResponseSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  GetAgentRequestSchema,
  GetAgentResponseSchema,
  GetHarnessDefaultsResponseSchema,
  GetInteractionResponseSchema,
  ListInteractionsRequestSchema,
  ListInteractionsResponseSchema,
  RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
  ScopedMcpDetectionSchema,
  GetConversationRequestSchema,
  GetConversationResponseSchema,
  GetRunRequestSchema,
  GetRunResponseSchema,
  GetWorkflowRequestSchema,
  GetWorkflowResponseSchema,
  ListAgentsRequestSchema,
  ListAgentsResponseSchema,
  ListConversationsRequestSchema,
  ListConversationsResponseSchema,
  ListMessagesRequestSchema,
  ListMessagesResponseSchema,
  ListVisibleResourcesRequestSchema,
  ListVisibleResourcesResponseSchema,
  CreateOperatorConversationRequestSchema,
  CreateOperatorConversationResponseSchema,
  ListOperatorConversationsResponseSchema,
  GetOperatorConversationResponseSchema,
  SendOperatorMessageRequestSchema,
  SendOperatorMessageResponseSchema,
  CancelOperatorTurnResponseSchema,
  CancelOperatorTurnRequestSchema,
  RespondOperatorInteractionRequestSchema,
  SaveWorkflowRequestSchema,
  SaveWorkflowResponseSchema,
  SaveHarnessDefaultsRequestSchema,
  SaveHarnessDefaultsResponseSchema,
  WorkspaceDetailsRequestSchema,
  WorkspaceDetailsResponseSchema,
  type CreateMessageRequest,
  type CreateMessageResponse,
  type CreateRunRequest,
  type CreateRunResponse,
  type GetAgentRequest,
  type GetAgentResponse,
  type GetHarnessDefaultsResponse,
  type GetConversationRequest,
  type GetConversationResponse,
  type GetRunRequest,
  type GetRunResponse,
  type GetWorkflowRequest,
  type GetWorkflowResponse,
  type ListAgentsRequest,
  type ListAgentsResponse,
  type ListConversationsRequest,
  type ListConversationsResponse,
  type ListMessagesRequest,
  type ListMessagesResponse,
  type ListVisibleResourcesRequest,
  type ListVisibleResourcesResponse,
  type OperatorConversationState,
  type SaveWorkflowRequest,
  type SaveWorkflowResponse,
  type SaveHarnessDefaultsRequest,
  type SaveHarnessDefaultsResponse,
  type WorkspaceDetailsRequest,
  type WorkspaceDetailsResponse,
} from '@graphql/contracts'
import { z } from 'zod'
import { collectManagementPages, managementPageUrl } from './managementPaging'
import {
  assertSession, sessionGeneration, sessionSignal, sessionIsSwitching, SessionChangedError,
} from './sessionBoundary'
import {
  ManagedWorkspaceCommandResultSchema,
  ManagedWorkspaceSchema,
  ManagedWorkspacePageSchema,
  ManagedWorkflowCommandResultSchema,
  ManagedWorkflowPageSchema,
  ManagedAgentPageSchema,
  GraphDraftSchema,
  GraphDraftCommandResultSchema,
  GraphSaveCommandResultSchema,
  GraphDraftApplyInputSchema,
  GraphSaveInputSchema,
  GraphDraftDiscardInputSchema,
  RunStartInputSchema,
  RunStartResultSchema,
  RunStopInputSchema,
  RunStopResultSchema,
  HarnessCatalogSchema,
  HarnessDefaultsUpdateInputSchema,
  HarnessDefaultsUpdateResultSchema,
  ManagedAgentDefaultsSchema,
  ManagedWorkflowDefaultsSchema,
  AgentDefaultsUpdateInputSchema,
  AgentDefaultsUpdateResultSchema,
  WorkflowDefaultsUpdateInputSchema,
  WorkflowDefaultsUpdateResultSchema,
  OperatorEnrollmentRequestSchema,
  OperatorEnrollmentResponseSchema,
  WorkspaceArchiveInputSchema,
  WorkspaceCreateInputSchema,
  WorkspaceUpdateInputSchema,
  WorkspaceGetInputSchema,
  WorkspaceLocationSetInputSchema,
  WorkspaceLocationSetResultSchema,
  WorkspaceLocationValidateInputSchema,
  WorkspaceLocationValidationSchema,
  WorkflowArchiveInputSchema,
  WorkflowCreateInputSchema,
  WorkflowUpdateInputSchema,
  type WorkspaceArchiveInput,
  type WorkspaceCreateInput,
  type WorkspaceUpdateInput,
  type WorkspaceLocationSetInput,
  type WorkspaceLocationValidateInput,
  type WorkflowArchiveInput,
  type WorkflowCreateInput,
  type WorkflowUpdateInput,
  type GraphDraftOperation,
} from '@graphql/contracts/management'

export type RequestOptions = Omit<RequestInit, 'body' | 'method'> & {
  /** The client uses this signal for query cancellation and component unmounts. */
  signal?: AbortSignal
}

export type ApiErrorPayload = {
  code: string
  message: string
  details?: Record<string, unknown>
  requestId?: string
}

/** A normalized error for both HTTP failures and invalid API responses. */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: Record<string, unknown>
  readonly requestId?: string

  constructor(payload: ApiErrorPayload, status = 0) {
    super(payload.message)
    this.name = 'ApiError'
    this.code = payload.code
    this.status = status
    this.details = payload.details
    this.requestId = payload.requestId
  }

  static is(error: unknown): error is ApiError {
    return error instanceof ApiError
  }
}

type FetchLike = typeof fetch

export interface ApiClientOptions {
  baseUrl?: string
  fetch?: FetchLike
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

function describeIssues(error: z.ZodError): Record<string, unknown> {
  return { issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) }
}

function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new ApiError({
      code: 'INVALID_REQUEST',
      message: 'The API request does not match its contract.',
      details: describeIssues(parsed.error),
    })
  }
  return parsed.data
}

function toPath(value: string): string {
  return encodeURIComponent(value)
}

function resolveRequestUrl(baseUrl: string, path: string): string {
  if (baseUrl) return `${baseUrl}${path}`
  // Browsers resolve `/api/...` relative to the current origin. Node's fetch
  // requires an absolute URL, so retain the same semantics in Vitest/SSR.
  const origin = typeof globalThis.location?.origin === 'string' ? globalThis.location.origin : 'http://localhost'
  return new URL(path, origin).toString()
}

/**
 * The only HTTP boundary used by the web app. Every successful response is
 * parsed with its contract schema before it reaches a feature/query hook.
 */
export class ApiClient {
  private readonly baseUrl: string
  private readonly fetchImpl?: FetchLike

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? ''
    // Do not bind the global fetch at module construction time: in tests MSW
    // installs its interceptor during the setup hook after modules load.
    this.fetchImpl = options.fetch
  }

  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions & { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const { body, method = 'GET', headers, signal, ...init } = options
    const generation = sessionGeneration()
    const authRequest = path === '/api/auth/enroll' || path === '/api/auth/logout'
    if (sessionIsSwitching() && !authRequest) throw new SessionChangedError()
    const requestSignal = signal ? AbortSignal.any([signal, sessionSignal()]) : sessionSignal()
    const requestHeaders = new Headers(headers)
    requestHeaders.set('Accept', 'application/json')
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json')

    let response: Response
    try {
      response = await (this.fetchImpl ?? globalThis.fetch)(resolveRequestUrl(this.baseUrl, path), {
        ...init,
        method,
        headers: requestHeaders,
        signal: requestSignal,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      // AbortError is meaningful to TanStack Query and should not be turned
      // into a retryable API failure.
      if (isAbortError(error)) throw error
      throw new ApiError({
        code: 'NETWORK_ERROR',
        message: 'The API request could not be completed.',
        details: { cause: error instanceof Error ? error.message : String(error) },
      })
    }

    let payload: unknown = undefined
    if (response.status !== 204) {
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
    }

    // Includes late responses from fetch implementations which ignore AbortSignal.
    assertSession(generation)
    requestSignal.throwIfAborted()
    if (!response.ok) {
      const parsedError = ApiErrorResponseSchema.safeParse(payload)
      if (parsedError.success) throw new ApiError(parsedError.data.error, response.status)
      throw new ApiError(
        {
          code: 'HTTP_ERROR',
          message: `The API request failed with status ${response.status}.`,
        },
        response.status,
      )
    }

    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      throw new ApiError(
        {
          code: 'INVALID_RESPONSE',
          message: 'The API returned a response that does not match its contract.',
          details: describeIssues(parsed.error),
        },
        response.status,
      )
    }
    return parsed.data
  }

  private userApprovalOptions(token: string, options: RequestOptions = {}): RequestOptions {
    const accepted = token.trim()
    if (!accepted || /\s/.test(accepted)) throw new ApiError({ code: 'USER_CREDENTIAL_REQUIRED', message: 'Enter a valid User bearer credential, not an Operator session.' }, 401)
    const headers = new Headers(options.headers)
    headers.set('Authorization', `Bearer ${accepted}`)
    // A User request must never fall back to the Operator browser cookie.
    return { ...options, headers, credentials: 'omit' }
  }

  getUserInteraction(interactionId: string, token: string, options?: RequestOptions) {
    return this.request(`/api/user/interactions/${toPath(interactionId)}`, GetInteractionResponseSchema,
      this.userApprovalOptions(token, options))
  }

  respondToUserInteraction(token: string, input: z.infer<typeof RespondToInteractionRequestSchema>, options?: RequestOptions) {
    const request = parseRequest(RespondToInteractionRequestSchema, input)
    return this.request(`/api/user/interactions/${toPath(request.interactionId)}/respond`, RespondToInteractionResponseSchema,
      { ...this.userApprovalOptions(token, options), method: 'POST', body: request })
  }

  enrollOperator(token: string, options?: RequestOptions) {
    const input = parseRequest(OperatorEnrollmentRequestSchema, { token })
    return this.request('/api/auth/enroll', OperatorEnrollmentResponseSchema, { ...options, method: 'POST', body: input })
  }

  listManagedWorkspaces(options?: RequestOptions) {
    return collectManagementPages((cursor) => this.request(
      managementPageUrl('/api/management/workspaces', cursor), ManagedWorkspacePageSchema, options,
    ), options?.signal)
  }

  getManagedWorkspace(workspaceId: string, options?: RequestOptions) {
    const request = parseRequest(WorkspaceGetInputSchema, { workspaceId })
    return this.request(`/api/management/workspaces/${toPath(request.workspaceId)}`, ManagedWorkspaceSchema, options)
  }

  validateWorkspaceLocation(input: WorkspaceLocationValidateInput, options?: RequestOptions) {
    const request = parseRequest(WorkspaceLocationValidateInputSchema, input)
    return this.request(
      `/api/management/workspaces/${toPath(request.workspaceId)}/location/validate`,
      WorkspaceLocationValidationSchema,
      { ...options, method: 'POST', body: request },
    )
  }

  setWorkspaceLocation(input: WorkspaceLocationSetInput, options?: RequestOptions) {
    const request = parseRequest(WorkspaceLocationSetInputSchema, input)
    return this.request(
      `/api/management/workspaces/${toPath(request.workspaceId)}/location`,
      WorkspaceLocationSetResultSchema,
      { ...options, method: 'PUT', body: request },
    )
  }

  createManagedWorkspace(input: WorkspaceCreateInput, options?: RequestOptions) {
    const request = parseRequest(WorkspaceCreateInputSchema, input)
    return this.request('/api/management/workspaces', ManagedWorkspaceCommandResultSchema, { ...options, method: 'POST', body: request })
  }

  updateManagedWorkspace(input: WorkspaceUpdateInput, options?: RequestOptions) {
    const request = parseRequest(WorkspaceUpdateInputSchema, input)
    return this.request(`/api/management/workspaces/${toPath(request.workspaceId)}`, ManagedWorkspaceCommandResultSchema, { ...options, method: 'PATCH', body: request })
  }

  archiveManagedWorkspace(input: WorkspaceArchiveInput, options?: RequestOptions) {
    const request = parseRequest(WorkspaceArchiveInputSchema, input)
    return this.request(`/api/management/workspaces/${toPath(request.workspaceId)}`, ManagedWorkspaceCommandResultSchema, { ...options, method: 'DELETE', body: request })
  }

  listManagedWorkflows(workspaceId: string, options?: RequestOptions) {
    return collectManagementPages((cursor) => this.request(
      managementPageUrl(`/api/management/workspaces/${toPath(workspaceId)}/workflows`, cursor),
      ManagedWorkflowPageSchema, options,
    ), options?.signal)
  }

  createManagedWorkflow(input: WorkflowCreateInput, options?: RequestOptions) {
    const request = parseRequest(WorkflowCreateInputSchema, input)
    return this.request(`/api/management/workspaces/${toPath(request.workspaceId)}/workflows`, ManagedWorkflowCommandResultSchema, { ...options, method: 'POST', body: request })
  }

  updateManagedWorkflow(input: WorkflowUpdateInput, options?: RequestOptions) {
    const request = parseRequest(WorkflowUpdateInputSchema, input)
    return this.request(`/api/management/workspaces/${toPath(request.workspaceId)}/workflows/${toPath(request.workflowId)}`, ManagedWorkflowCommandResultSchema, { ...options, method: 'PATCH', body: request })
  }

  archiveManagedWorkflow(input: WorkflowArchiveInput, options?: RequestOptions) {
    const request = parseRequest(WorkflowArchiveInputSchema, input)
    return this.request(`/api/management/workspaces/${toPath(request.workspaceId)}/workflows/${toPath(request.workflowId)}`, ManagedWorkflowCommandResultSchema, { ...options, method: 'DELETE', body: request })
  }

  listManagedAgents(workspaceId: string, options?: RequestOptions) {
    return collectManagementPages((cursor) => this.request(
      managementPageUrl(`/api/management/workspaces/${toPath(workspaceId)}/agents`, cursor), ManagedAgentPageSchema, options,
    ), options?.signal)
  }

  async getManagedGraphContext(workspaceId: string, workflowId: string, options?: RequestOptions) {
    // Read agents between matching draft revisions. MCP publication clears
    // stagedAgents; never pair that newer draft with an older agent catalog.
    for (let attempt = 0; attempt < 3; ++attempt) {
      const before = await this.openManagedGraphDraft(workspaceId, workflowId, options)
      const agents = await this.listManagedAgents(workspaceId, options)
      const draft = await this.openManagedGraphDraft(workspaceId, workflowId, options)
      if (before.id === draft.id && before.revision === draft.revision) return { draft, agents }
    }
    throw new ApiError({ code: 'GRAPH_CHANGING', message: 'The shared graph is changing. Retry when the current edit finishes.' }, 409)
  }

  openManagedGraphDraft(workspaceId: string, workflowId: string, options?: RequestOptions) {
    return this.request(
      `/api/management/workspaces/${toPath(workspaceId)}/workflows/${toPath(workflowId)}/drafts`,
      GraphDraftSchema,
      { ...options, method: 'POST' },
    )
  }

  applyManagedGraphDraft(input: {
    workspaceId: string; workflowId: string; draftId: string; commandId: string;
    expectedRevision: number; operations: GraphDraftOperation[]
  }, options?: RequestOptions) {
    const request = parseRequest(GraphDraftApplyInputSchema, input)
    return this.request(
      `/api/management/workspaces/${toPath(request.workspaceId)}/workflows/${toPath(request.workflowId)}/drafts/${toPath(request.draftId)}/operations`,
      GraphDraftCommandResultSchema,
      { ...options, method: 'POST', body: request },
    )
  }

  saveManagedGraphDraft(input: { workspaceId: string; workflowId: string; draftId: string; commandId: string; expectedRevision: number }, options?: RequestOptions) {
    const request = parseRequest(GraphSaveInputSchema, input)
    return this.request(
      `/api/management/workspaces/${toPath(request.workspaceId)}/workflows/${toPath(request.workflowId)}/drafts/${toPath(request.draftId)}/save`,
      GraphSaveCommandResultSchema,
      { ...options, method: 'POST', body: request },
    )
  }

  discardManagedGraphDraft(input: { workspaceId: string; workflowId: string; draftId: string; commandId: string; expectedRevision: number }, options?: RequestOptions) {
    const request = parseRequest(GraphDraftDiscardInputSchema, input)
    return this.request(
      `/api/management/workspaces/${toPath(request.workspaceId)}/workflows/${toPath(request.workflowId)}/drafts/${toPath(request.draftId)}`,
      z.object({ value: z.object({ discarded: z.literal(true), draftId: z.string(), revision: z.number() }).strict(), replayed: z.boolean() }).strict(),
      { ...options, method: 'DELETE', body: request },
    )
  }

  startManagedRun(input: z.input<typeof RunStartInputSchema>, options?: RequestOptions) {
    const request = parseRequest(RunStartInputSchema, input)
    return this.request(
      `/api/management/workspaces/${toPath(request.workspaceId)}/workflows/${toPath(request.workflowId)}/runs`,
      RunStartResultSchema,
      { ...options, method: 'POST', body: request },
    )
  }

  stopManagedRun(input: z.input<typeof RunStopInputSchema>, options?: RequestOptions) {
    const request = parseRequest(RunStopInputSchema, input)
    return this.request(
      `/api/management/workspaces/${toPath(request.workspaceId)}/runs/${toPath(request.runId)}/stop`,
      RunStopResultSchema,
      { ...options, method: 'POST', body: request },
    )
  }

  getManagedHarnessCatalog(options?: RequestOptions) {
    return this.request('/api/management/harnesses', HarnessCatalogSchema, options)
  }

  updateManagedHarnessDefaults(input: z.input<typeof HarnessDefaultsUpdateInputSchema>, options?: RequestOptions) {
    const request = parseRequest(HarnessDefaultsUpdateInputSchema, input)
    return this.request('/api/management/harnesses/defaults', HarnessDefaultsUpdateResultSchema, { ...options, method: 'PUT', body: request })
  }

  getManagedAgentDefaults(options?: RequestOptions) {
    return this.request('/api/management/settings/agents', ManagedAgentDefaultsSchema, options)
  }

  updateManagedAgentDefaults(input: z.input<typeof AgentDefaultsUpdateInputSchema>, options?: RequestOptions) {
    const request = parseRequest(AgentDefaultsUpdateInputSchema, input)
    return this.request('/api/management/settings/agents', AgentDefaultsUpdateResultSchema, { ...options, method: 'PUT', body: request })
  }

  getManagedWorkflowDefaults(options?: RequestOptions) {
    return this.request('/api/management/settings/workflows', ManagedWorkflowDefaultsSchema, options)
  }

  getScopedMcpDetection(workspaceId: string, harness: 'codex' | 'opencode', options?: RequestOptions) {
    return this.request(
      `/api/management/workspaces/${toPath(workspaceId)}/harnesses/${harness}/mcp-detection`,
      ScopedMcpDetectionSchema,
      options,
    )
  }

  updateManagedWorkflowDefaults(input: z.input<typeof WorkflowDefaultsUpdateInputSchema>, options?: RequestOptions) {
    const request = parseRequest(WorkflowDefaultsUpdateInputSchema, input)
    return this.request('/api/management/settings/workflows', WorkflowDefaultsUpdateResultSchema, { ...options, method: 'PUT', body: request })
  }

  listInteractions(input: z.input<typeof ListInteractionsRequestSchema>, options?: RequestOptions) {
    const request = parseRequest(ListInteractionsRequestSchema, input)
    const query = new URLSearchParams()
    if (request.cursor) query.set('cursor', request.cursor)
    query.set('limit', String(request.limit))
    if (request.workspaceId) query.set('workspaceId', request.workspaceId)
    if (request.workflowId) query.set('workflowId', request.workflowId)
    if (request.status) query.set('status', request.status)
    return this.request(`/api/management/interactions?${query.toString()}`, ListInteractionsResponseSchema, options)
  }

  getInteraction(interactionId: string, options?: RequestOptions) {
    return this.request(`/api/management/interactions/${toPath(interactionId)}`, GetInteractionResponseSchema, options)
  }

  respondToInteraction(input: z.input<typeof RespondToInteractionRequestSchema>, options?: RequestOptions) {
    const request = parseRequest(RespondToInteractionRequestSchema, input)
    return this.request(`/api/interactions/${toPath(request.interactionId)}/respond`, RespondToInteractionResponseSchema, {
      ...options, method: 'POST', body: request,
    })
  }

  getWorkspaceDetails(input: WorkspaceDetailsRequest, options?: RequestOptions) {
    const request = parseRequest(WorkspaceDetailsRequestSchema, input)
    return this.request<WorkspaceDetailsResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}`,
      WorkspaceDetailsResponseSchema,
      options,
    )
  }

  getWorkspace(input: WorkspaceDetailsRequest, options?: RequestOptions) {
    return this.getWorkspaceDetails(input, options)
  }

  getHarnessDefaults(options?: RequestOptions) {
    return this.request<GetHarnessDefaultsResponse>(
      '/api/settings/harnesses',
      GetHarnessDefaultsResponseSchema,
      options,
    )
  }

  saveHarnessDefaults(input: SaveHarnessDefaultsRequest, options?: RequestOptions) {
    const request = parseRequest(SaveHarnessDefaultsRequestSchema, input)
    return this.request<SaveHarnessDefaultsResponse>(
      '/api/settings/harnesses',
      SaveHarnessDefaultsResponseSchema,
      { ...options, method: 'PUT', body: request },
    )
  }

  listAgents(input: ListAgentsRequest, options?: RequestOptions) {
    const request = parseRequest(ListAgentsRequestSchema, input)
    return this.request<ListAgentsResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/agents`,
      ListAgentsResponseSchema,
      options,
    )
  }

  getAgent(input: GetAgentRequest, options?: RequestOptions) {
    const request = parseRequest(GetAgentRequestSchema, input)
    return this.request<GetAgentResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/agents/${toPath(request.agentId)}`,
      GetAgentResponseSchema,
      options,
    )
  }

  getWorkflow(input: GetWorkflowRequest, options?: RequestOptions) {
    const request = parseRequest(GetWorkflowRequestSchema, input)
    return this.request<GetWorkflowResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/workflows/${toPath(request.workflowId)}`,
      GetWorkflowResponseSchema,
      options,
    )
  }

  saveWorkflow(input: SaveWorkflowRequest, options?: RequestOptions) {
    const request = parseRequest(SaveWorkflowRequestSchema, input)
    return this.request<SaveWorkflowResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/workflows/${toPath(request.workflow.id)}`,
      SaveWorkflowResponseSchema,
      { ...options, method: 'PUT', body: request },
    )
  }

  /** Alias used by the graph editor; graph persistence remains an ordinary HTTP mutation. */
  saveGraph(input: SaveWorkflowRequest, options?: RequestOptions) {
    const request = parseRequest(SaveWorkflowRequestSchema, input)
    return this.request<SaveWorkflowResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/graph`,
      SaveWorkflowResponseSchema,
      { ...options, method: 'PUT', body: request },
    )
  }

  startWorkflowRun(input: CreateRunRequest, options?: RequestOptions) {
    const request = parseRequest(CreateRunRequestSchema, input)
    return this.request<CreateRunResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/workflows/${toPath(request.workflowId)}/runs`,
      CreateRunResponseSchema,
      { ...options, method: 'POST', body: request },
    )
  }

  getRun(input: GetRunRequest, options?: RequestOptions) {
    const request = parseRequest(GetRunRequestSchema, input)
    return this.request<GetRunResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/runs/${toPath(request.runId)}`,
      GetRunResponseSchema,
      options,
    )
  }

  listOperatorConversations(options?: RequestOptions) {
    return this.request('/api/operator/conversations', ListOperatorConversationsResponseSchema, options)
  }

  createOperatorConversation(input: { title?: string } = {}, options?: RequestOptions) {
    const request = parseRequest(CreateOperatorConversationRequestSchema, input)
    return this.request('/api/operator/conversations', CreateOperatorConversationResponseSchema, { ...options, method: 'POST', body: request })
  }

  getOperatorConversation(conversationId: string, options?: RequestOptions): Promise<OperatorConversationState> {
    return this.request(`/api/operator/conversations/${toPath(conversationId)}`, GetOperatorConversationResponseSchema, options)
  }

  sendOperatorMessage(conversationId: string, input: unknown, options?: RequestOptions) {
    const request = parseRequest(SendOperatorMessageRequestSchema, input)
    return this.request(`/api/operator/conversations/${toPath(conversationId)}/messages`, SendOperatorMessageResponseSchema, { ...options, method: 'POST', body: request })
  }

  cancelOperatorTurn(conversationId: string, requestId: string, options?: RequestOptions) {
    const request = parseRequest(CancelOperatorTurnRequestSchema, { requestId })
    return this.request(`/api/operator/conversations/${toPath(conversationId)}/cancel`, CancelOperatorTurnResponseSchema, { ...options, method: 'POST', body: request })
  }

  respondOperatorInteraction(conversationId: string, input: z.infer<typeof RespondOperatorInteractionRequestSchema>, options?: RequestOptions) {
    const request = parseRequest(RespondOperatorInteractionRequestSchema, input)
    return this.request(`/api/operator/conversations/${toPath(conversationId)}/responses`, CancelOperatorTurnResponseSchema, { ...options, method: 'POST', body: request })
  }

  listConversations(input: ListConversationsRequest, options?: RequestOptions) {
    const request = parseRequest(ListConversationsRequestSchema, input)
    return this.request<ListConversationsResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/conversations`,
      ListConversationsResponseSchema,
      options,
    )
  }

  getConversation(input: GetConversationRequest, options?: RequestOptions) {
    const request = parseRequest(GetConversationRequestSchema, input)
    return this.request<GetConversationResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/conversations/${toPath(request.conversationId)}`,
      GetConversationResponseSchema,
      options,
    )
  }

  listMessages(input: ListMessagesRequest, options?: RequestOptions) {
    const request = parseRequest(ListMessagesRequestSchema, input)
    return this.request<ListMessagesResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/conversations/${toPath(request.conversationId)}/messages`,
      ListMessagesResponseSchema,
      options,
    )
  }

  createMessage(input: CreateMessageRequest, options?: RequestOptions) {
    const request = parseRequest(CreateMessageRequestSchema, input)
    return this.request<CreateMessageResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/conversations/${toPath(request.conversationId)}/messages`,
      CreateMessageResponseSchema,
      { ...options, method: 'POST', body: request },
    )
  }

  /** User-message convenience method; it never fabricates an assistant reply. */
  sendUserMessage(
    input: Omit<CreateMessageRequest, 'role'>,
    options?: RequestOptions,
  ) {
    return this.createMessage({ ...input, role: 'user' }, options)
  }

  createUserMessage(
    input: Omit<CreateMessageRequest, 'role'>,
    options?: RequestOptions,
  ) {
    return this.sendUserMessage(input, options)
  }

  listVisibleResources(input: ListVisibleResourcesRequest, options?: RequestOptions) {
    const request = parseRequest(ListVisibleResourcesRequestSchema, input)
    return this.request<ListVisibleResourcesResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/resources`,
      ListVisibleResourcesResponseSchema,
      options,
    )
  }
}

export const apiClient = new ApiClient()

export const getWorkspaceDetails = apiClient.getWorkspaceDetails.bind(apiClient)
export const getWorkspace = apiClient.getWorkspace.bind(apiClient)
export const getHarnessDefaults = apiClient.getHarnessDefaults.bind(apiClient)
export const saveHarnessDefaults = apiClient.saveHarnessDefaults.bind(apiClient)
export const listAgents = apiClient.listAgents.bind(apiClient)
export const getAgent = apiClient.getAgent.bind(apiClient)
export const getWorkflow = apiClient.getWorkflow.bind(apiClient)
export const saveWorkflow = apiClient.saveWorkflow.bind(apiClient)
export const saveGraph = apiClient.saveGraph.bind(apiClient)
export const startWorkflowRun = apiClient.startWorkflowRun.bind(apiClient)
export const getRun = apiClient.getRun.bind(apiClient)
export const listOperatorConversations = apiClient.listOperatorConversations.bind(apiClient)
export const createOperatorConversation = apiClient.createOperatorConversation.bind(apiClient)
export const getOperatorConversation = apiClient.getOperatorConversation.bind(apiClient)
export const sendOperatorMessage = apiClient.sendOperatorMessage.bind(apiClient)
export const cancelOperatorTurn = apiClient.cancelOperatorTurn.bind(apiClient)
export const respondOperatorInteraction = apiClient.respondOperatorInteraction.bind(apiClient)
export const listConversations = apiClient.listConversations.bind(apiClient)
export const getConversation = apiClient.getConversation.bind(apiClient)
export const listMessages = apiClient.listMessages.bind(apiClient)
export const createMessage = apiClient.createMessage.bind(apiClient)
export const sendUserMessage = apiClient.sendUserMessage.bind(apiClient)
export const createUserMessage = apiClient.createUserMessage.bind(apiClient)
export const listVisibleResources = apiClient.listVisibleResources.bind(apiClient)
export const enrollOperator = apiClient.enrollOperator.bind(apiClient)
export const listManagedWorkspaces = apiClient.listManagedWorkspaces.bind(apiClient)
export const getManagedWorkspace = apiClient.getManagedWorkspace.bind(apiClient)
export const validateWorkspaceLocation = apiClient.validateWorkspaceLocation.bind(apiClient)
export const setWorkspaceLocation = apiClient.setWorkspaceLocation.bind(apiClient)
export const createManagedWorkspace = apiClient.createManagedWorkspace.bind(apiClient)
export const updateManagedWorkspace = apiClient.updateManagedWorkspace.bind(apiClient)
export const archiveManagedWorkspace = apiClient.archiveManagedWorkspace.bind(apiClient)
export const listManagedWorkflows = apiClient.listManagedWorkflows.bind(apiClient)
export const createManagedWorkflow = apiClient.createManagedWorkflow.bind(apiClient)
export const updateManagedWorkflow = apiClient.updateManagedWorkflow.bind(apiClient)
export const archiveManagedWorkflow = apiClient.archiveManagedWorkflow.bind(apiClient)
export const listManagedAgents = apiClient.listManagedAgents.bind(apiClient)
export const getManagedGraphContext = apiClient.getManagedGraphContext.bind(apiClient)
export const openManagedGraphDraft = apiClient.openManagedGraphDraft.bind(apiClient)
export const applyManagedGraphDraft = apiClient.applyManagedGraphDraft.bind(apiClient)
export const saveManagedGraphDraft = apiClient.saveManagedGraphDraft.bind(apiClient)
export const discardManagedGraphDraft = apiClient.discardManagedGraphDraft.bind(apiClient)
export const startManagedRun = apiClient.startManagedRun.bind(apiClient)
export const stopManagedRun = apiClient.stopManagedRun.bind(apiClient)
export const getManagedHarnessCatalog = apiClient.getManagedHarnessCatalog.bind(apiClient)
export const updateManagedHarnessDefaults = apiClient.updateManagedHarnessDefaults.bind(apiClient)
export const getManagedAgentDefaults = apiClient.getManagedAgentDefaults.bind(apiClient)
export const updateManagedAgentDefaults = apiClient.updateManagedAgentDefaults.bind(apiClient)
export const getManagedWorkflowDefaults = apiClient.getManagedWorkflowDefaults.bind(apiClient)
export const updateManagedWorkflowDefaults = apiClient.updateManagedWorkflowDefaults.bind(apiClient)
export const getScopedMcpDetection = apiClient.getScopedMcpDetection.bind(apiClient)
export const listInteractions = apiClient.listInteractions.bind(apiClient)
export const getInteraction = apiClient.getInteraction.bind(apiClient)
export const respondToInteraction = apiClient.respondToInteraction.bind(apiClient)
