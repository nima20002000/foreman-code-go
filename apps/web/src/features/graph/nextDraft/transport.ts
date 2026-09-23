import {
  GraphDraftSchema, GraphValidationResultSchema, GraphDraftOpenInputSchema, GraphDraftGetInputSchema,
} from '@graphql/contracts/management'
import {
  GraphDraftV2Schema, GraphDraftApplyV2InputSchema, GraphDraftCommandV2ResultSchema,
  GraphSaveV2InputSchema, GraphSaveCommandV2ResultSchema, WorkflowDefinitionV2Schema,
  GraphDraftOperationV2Schema, RunStartV2InputSchema, RunStartV2ResultSchema, CompatibleRunPageSchema,
} from '@graphql/contracts/wave25'
import { apiClient, ApiError, type ApiClient, type RequestOptions } from '../../../shared/api/client'
import type { z } from 'zod'
import type { DraftRequest } from './state'
import { sameValue, type NextDraftContext } from './model'

export type CompatibleDraft = z.infer<typeof GraphDraftSchema> | z.infer<typeof GraphDraftV2Schema>
export type AuthoringContext = { draft: CompatibleDraft; agents: NextDraftContext['agents'] }
const DraftResponseSchema = GraphDraftV2Schema.or(GraphDraftSchema)
const path = (workspaceId: string, workflowId: string, draftId?: string) =>
  `/api/management/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/drafts${draftId === undefined ? '' : `/${encodeURIComponent(draftId)}`}`

function assertScope(draft: CompatibleDraft, workspaceId: string, workflowId: string, draftId?: string) {
  if (draft.workspaceId !== workspaceId || draft.workflowId !== workflowId || draft.graph.workspaceId !== workspaceId
    || draft.graph.id !== workflowId || (draftId !== undefined && draft.id !== draftId)) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The draft response has a different workspace, workflow or draft identity.' })
}

/** Uses the existing session-generation-fenced, same-origin HTTP boundary. No bearer fallback. */
export function createNextDraftApi(client: ApiClient = apiClient) {
  const open = async (workspaceId: string, workflowId: string, options?: RequestOptions) => {
    GraphDraftOpenInputSchema.parse({ workspaceId, workflowId })
    const draft = await client.request(path(workspaceId, workflowId), DraftResponseSchema, { ...options, method: 'POST' })
    assertScope(draft, workspaceId, workflowId)
    return draft
  }
  const get = async (workspaceId: string, workflowId: string, draftId: string, options?: RequestOptions) => {
    GraphDraftGetInputSchema.parse({ workspaceId, workflowId, draftId })
    const draft = await client.request(path(workspaceId, workflowId, draftId), DraftResponseSchema, options)
    assertScope(draft, workspaceId, workflowId, draftId)
    return draft
  }
  return {
    open, get,
    async context(workspaceId: string, workflowId: string, options?: RequestOptions): Promise<AuthoringContext> {
      for (let attempt = 0; attempt < 3; ++attempt) {
        const before = await open(workspaceId, workflowId, options)
        const agents = await client.listManagedAgents(workspaceId, options)
        const draft = await get(workspaceId, workflowId, before.id, options)
        if (before.revision === draft.revision) return { draft, agents: agents.items }
      }
      throw new ApiError({ code: 'GRAPH_CHANGING', message: 'The shared draft changed while loading. Retry after the current edit.' }, 409)
    },
    async write(request: DraftRequest) {
      const { kind, ...payload } = request
      const url = path(request.workspaceId, request.workflowId, request.draftId)
      const result = kind === 'apply'
        ? await client.request(`${url}/operations`, GraphDraftCommandV2ResultSchema,
          { method: 'POST', body: GraphDraftApplyV2InputSchema.parse(payload) })
        : await client.request(`${url}/save`, GraphSaveCommandV2ResultSchema,
          { method: 'POST', body: GraphSaveV2InputSchema.parse(payload) })
      const draft = result.value.draft
      assertScope(draft, request.workspaceId, request.workflowId, request.draftId)
      if (draft.revision !== request.expectedRevision + 1) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The command acknowledgement does not match its revision pin. Retry the same command to reconcile it.' })
      if ('version' in result.value && (draft.baseWorkflowVersionId !== result.value.version.id
        || draft.publishedRevision !== draft.revision || result.value.version.workspaceId !== request.workspaceId
        || result.value.version.workflowId !== request.workflowId || !sameValue(result.value.version.definition, draft.graph))) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The publication acknowledgement is missing its immutable version pin.' })
      return { draft, agents: 'agents' in result.value ? result.value.agents : undefined }
    },
    validate: async (workspaceId: string, workflowId: string, draftId: string) =>
      client.request(`${path(workspaceId, workflowId, draftId)}/validate`, GraphValidationResultSchema, { method: 'POST' }),
    start: async (input: z.input<typeof RunStartV2InputSchema>) => {
      const request = RunStartV2InputSchema.parse(input)
      const result = await client.request(
        `/api/management/workspaces/${encodeURIComponent(request.workspaceId)}/workflows/${encodeURIComponent(request.workflowId)}/runs`,
        RunStartV2ResultSchema, { method: 'POST', body: request })
      if (result.run.workspaceId !== request.workspaceId || result.run.workflowId !== request.workflowId
        || result.run.workflowVersionId !== request.workflowVersionId) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The admitted Run did not match the saved version pin.' })
      }
      return result
    },
    runs: async (workspaceId: string, workflowId: string, cursor: string | null = null, options?: RequestOptions) => {
      const query = new URLSearchParams({ workflowId, limit: '20' })
      if (cursor) query.set('cursor', cursor)
      const result = await client.request(
        `/api/management/workspaces/${encodeURIComponent(workspaceId)}/runs?${query}`,
        CompatibleRunPageSchema, options)
      if (result.items.some((run) => run.workspaceId !== workspaceId || run.workflowId !== workflowId)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The Run list contains a different workflow scope.' })
      }
      return result
    },
  }
}
export const nextDraftApi = createNextDraftApi()
export type NextDraftApi = ReturnType<typeof createNextDraftApi>

/** Structural form errors are local. Executability, authorization and all native policy stay on S2. */
export function assertDraftSubmission(graph: NextDraftContext['draft']['graph'], operations: unknown[]) {
  WorkflowDefinitionV2Schema.parse(graph)
  for (const operation of operations) GraphDraftOperationV2Schema.parse(operation)
}
