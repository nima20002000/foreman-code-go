import {
  ApiErrorResponseSchema,
  CreateMessageRequestSchema,
  CreateMessageResponseSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  GetAgentRequestSchema,
  GetAgentResponseSchema,
  GetHarnessDefaultsResponseSchema,
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
  type SaveWorkflowRequest,
  type SaveWorkflowResponse,
  type SaveHarnessDefaultsRequest,
  type SaveHarnessDefaultsResponse,
  type WorkspaceDetailsRequest,
  type WorkspaceDetailsResponse,
} from '@graphql/contracts'
import { z } from 'zod'

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
    const requestHeaders = new Headers(headers)
    requestHeaders.set('Accept', 'application/json')
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json')

    let response: Response
    try {
      response = await (this.fetchImpl ?? globalThis.fetch)(resolveRequestUrl(this.baseUrl, path), {
        ...init,
        method,
        headers: requestHeaders,
        signal,
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
export const listConversations = apiClient.listConversations.bind(apiClient)
export const getConversation = apiClient.getConversation.bind(apiClient)
export const listMessages = apiClient.listMessages.bind(apiClient)
export const createMessage = apiClient.createMessage.bind(apiClient)
export const sendUserMessage = apiClient.sendUserMessage.bind(apiClient)
export const createUserMessage = apiClient.createUserMessage.bind(apiClient)
export const listVisibleResources = apiClient.listVisibleResources.bind(apiClient)
