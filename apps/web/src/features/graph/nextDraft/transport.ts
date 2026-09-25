import {
  GraphValidationResultSchema, GraphDraftOpenInputSchema, GraphDraftGetInputSchema,
} from '@graphql/contracts/management'
import {
  GraphEditReadResultV3Schema, GraphEditReadInputV3Schema, GraphEditStageInputV3Schema, GraphEditAdvanceInputV3Schema, GraphEditDiscardInputV3Schema,
  type GraphEditReadInputV3, type GraphEditStageInputV3, type GraphEditAdvanceInputV3, type GraphEditDiscardInputV3, type GraphEditReadResultV3,
  GraphDraftV3Schema, GraphDraftApplyV3InputSchema, GraphDraftCommandV3ResultSchema,
  GraphSaveV3InputSchema, GraphSaveCommandV3ResultSchema, WorkflowDefinitionV3Schema,
  GraphDraftOperationV3Schema, CurrentRunPageSchema, sameWorkflowExceptGeometry,
} from '@graphql/contracts/wave25'
import { apiClient, ApiError, type ApiClient, type RequestOptions } from '../../../shared/api/client'
import type { z } from 'zod'
import type { DraftRequest } from './state'
import type { NextDraftContext } from './model'

export type CurrentDraft = z.infer<typeof GraphDraftV3Schema>
export type AuthoringContext = { draft: CurrentDraft; agents: NextDraftContext['agents'] }
const DraftResponseSchema = GraphDraftV3Schema
const path = (workspaceId: string, workflowId: string, draftId?: string) =>
  `/api/management/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/drafts${draftId === undefined ? '' : `/${encodeURIComponent(draftId)}`}`

function assertScope(draft: CurrentDraft, workspaceId: string, workflowId: string, draftId?: string) {
  if (draft.workspaceId !== workspaceId || draft.workflowId !== workflowId || draft.graph.workspaceId !== workspaceId
    || draft.graph.id !== workflowId || (draftId !== undefined && draft.id !== draftId)) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The draft response has a different workspace, workflow or draft identity.' })
}

function assertIntentScope(value: GraphEditReadResultV3, input: { workspaceId: string; workflowId: string; intentId?: string }) {
  const intent = value.intent
  if (intent && (intent.workspaceId !== input.workspaceId || intent.workflowId !== input.workflowId
    || (input.intentId !== undefined && intent.id !== input.intentId)
    || intent.stagedDraft.workspaceId !== input.workspaceId || intent.stagedDraft.workflowId !== input.workflowId)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The private edit intent returned a different scope or identity.' })
  }
  if (intent?.result && !sameWorkflowExceptGeometry(intent.result.version.definition, intent.result.draft.graph)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The saved acknowledgement does not match its immutable executable version.' })
  }
  if (new Set(value.current.map((item) => item.pin.runId)).size !== value.current.length
    || value.current.some((item) => item.pin.workspaceId !== input.workspaceId)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The affected Run set returned a different workspace.' })
  }
  return value
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
    async editRead(raw: GraphEditReadInputV3, options?: RequestOptions) {
      const input = GraphEditReadInputV3Schema.parse(raw)
      const url = `${path(input.workspaceId, input.workflowId, input.draftId)}/edit-intents${input.intentId ? `/${encodeURIComponent(input.intentId)}` : ''}`
      return assertIntentScope(await client.request(url, GraphEditReadResultV3Schema, options), input)
    },
    async editStage(raw: GraphEditStageInputV3) {
      const input = GraphEditStageInputV3Schema.parse(raw)
      const result = assertIntentScope(await client.request(`${path(input.workspaceId, input.workflowId, input.draftId)}/edit-intents`,
        GraphEditReadResultV3Schema, { method: 'POST', body: input }), input)
      if (!result.intent || result.intent.stageCommandId !== input.commandId || result.intent.draftId !== input.draftId
        || result.intent.expectedRevision !== input.expectedRevision || result.intent.expectedWorkflowVersionId !== input.expectedWorkflowVersionId) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Staging did not acknowledge the exact retained command and revision.' })
      }
      return result
    },
    async editAdvance(raw: GraphEditAdvanceInputV3) {
      const input = GraphEditAdvanceInputV3Schema.parse(raw)
      const result = assertIntentScope(await client.request(`${path(input.workspaceId, input.workflowId, input.draftId)}/edit-intents/${encodeURIComponent(input.intentId)}/advance`,
        GraphEditReadResultV3Schema, { method: 'POST', body: input }), input)
      if (!result.intent || result.intent.advanceCommandId !== input.commandId || result.intent.draftId !== input.draftId) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The Stop-and-save acknowledgement did not match the exact command.' })
      }
      return result
    },
    async editDiscard(raw: GraphEditDiscardInputV3) {
      const input = GraphEditDiscardInputV3Schema.parse(raw)
      const result = assertIntentScope(await client.request(`${path(input.workspaceId, input.workflowId, input.draftId)}/edit-intents/${encodeURIComponent(input.intentId)}/discard`,
        GraphEditReadResultV3Schema, { method: 'POST', body: input }), input)
      if (!result.intent || result.intent.discardCommandId !== input.commandId || result.intent.state !== 'discarded') {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Discard was not acknowledged. The retained edit was not cleared.' })
      }
      return result
    },
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
        ? await client.request(`${url}/operations`, GraphDraftCommandV3ResultSchema,
          { method: 'POST', body: GraphDraftApplyV3InputSchema.parse(payload) })
        : await client.request(`${url}/save`, GraphSaveCommandV3ResultSchema,
          { method: 'POST', body: GraphSaveV3InputSchema.parse(payload) })
      const draft = result.value.draft
      assertScope(draft, request.workspaceId, request.workflowId, request.draftId)
      if (draft.revision !== request.expectedRevision + 1) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The command acknowledgement does not match its revision pin. Retry the same command to reconcile it.' })
      if ('version' in result.value && (draft.baseWorkflowVersionId !== result.value.version.id
        || draft.publishedRevision !== draft.revision || result.value.version.workspaceId !== request.workspaceId
        || result.value.version.workflowId !== request.workflowId || !sameWorkflowExceptGeometry(result.value.version.definition, draft.graph))) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The publication acknowledgement is missing its immutable version pin.' })
      return { draft, agents: 'agents' in result.value ? result.value.agents : undefined }
    },
    validate: async (workspaceId: string, workflowId: string, draftId: string) =>
      client.request(`${path(workspaceId, workflowId, draftId)}/validate`, GraphValidationResultSchema, { method: 'POST' }),
    runs: async (workspaceId: string, workflowId: string, cursor: string | null = null, options?: RequestOptions) => {
      const query = new URLSearchParams({ workflowId, limit: '20' })
      if (cursor) query.set('cursor', cursor)
      const result = await client.request(
        `/api/management/workspaces/${encodeURIComponent(workspaceId)}/runs?${query}`,
        CurrentRunPageSchema, options)
      if (result.items.some((run) => run.workspaceId !== workspaceId || run.workflowId !== workflowId)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The Run list contains a different workflow scope.' })
      }
      return result
    },
  }
}
export const nextDraftApi = createNextDraftApi()
export type NextDraftApi = ReturnType<typeof createNextDraftApi>

/** Structural form errors are local. Executability, authorization and all native policy remain server-authoritative. */
export function assertDraftSubmission(graph: NextDraftContext['draft']['graph'], operations: unknown[]) {
  WorkflowDefinitionV3Schema.parse(graph)
  for (const operation of operations) GraphDraftOperationV3Schema.parse(operation)
}
