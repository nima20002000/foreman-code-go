import {
  GraphDraftSchema, GraphValidationResultSchema, GraphDraftOpenInputSchema, GraphDraftGetInputSchema,
} from '@graphql/contracts/management'
import {
  GraphEditReadResultSchema, GraphEditReadInputSchema, GraphEditStageInputSchema, GraphEditAdvanceInputSchema, GraphEditDiscardInputSchema,
  type GraphEditReadInput, type GraphEditStageInput, type GraphEditAdvanceInput, type GraphEditDiscardInput, type GraphEditReadResult,
  GraphDraftV2Schema, GraphDraftApplyV2InputSchema, GraphDraftCommandV2ResultSchema,
  GraphSaveV2InputSchema, GraphSaveCommandV2ResultSchema, WorkflowDefinitionV2Schema,
  GraphDraftOperationV2Schema, RunStartV2InputSchema, RunStartV2ResultSchema, CompatibleRunPageSchema, sameWorkflowExceptGeometry,
} from '@graphql/contracts/wave25'
import { apiClient, ApiError, type ApiClient, type RequestOptions } from '../../../shared/api/client'
import type { z } from 'zod'
import type { DraftRequest } from './state'
import type { NextDraftContext } from './model'

export type CompatibleDraft = z.infer<typeof GraphDraftSchema> | z.infer<typeof GraphDraftV2Schema>
export type AuthoringContext = { draft: CompatibleDraft; agents: NextDraftContext['agents'] }
const DraftResponseSchema = GraphDraftV2Schema.or(GraphDraftSchema)
const path = (workspaceId: string, workflowId: string, draftId?: string) =>
  `/api/management/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/drafts${draftId === undefined ? '' : `/${encodeURIComponent(draftId)}`}`

function assertScope(draft: CompatibleDraft, workspaceId: string, workflowId: string, draftId?: string) {
  if (draft.workspaceId !== workspaceId || draft.workflowId !== workflowId || draft.graph.workspaceId !== workspaceId
    || draft.graph.id !== workflowId || (draftId !== undefined && draft.id !== draftId)) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The draft response has a different workspace, workflow or draft identity.' })
}

function assertIntentScope(value: GraphEditReadResult, input: { workspaceId: string; workflowId: string; intentId?: string }) {
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
    async editRead(raw: GraphEditReadInput, options?: RequestOptions) {
      const input = GraphEditReadInputSchema.parse(raw)
      const url = `${path(input.workspaceId, input.workflowId, input.draftId)}/edit-intents${input.intentId ? `/${encodeURIComponent(input.intentId)}` : ''}`
      return assertIntentScope(await client.request(url, GraphEditReadResultSchema, options), input)
    },
    async editStage(raw: GraphEditStageInput) {
      const input = GraphEditStageInputSchema.parse(raw)
      const result = assertIntentScope(await client.request(`${path(input.workspaceId, input.workflowId, input.draftId)}/edit-intents`,
        GraphEditReadResultSchema, { method: 'POST', body: input }), input)
      if (!result.intent || result.intent.stageCommandId !== input.commandId || result.intent.draftId !== input.draftId
        || result.intent.expectedRevision !== input.expectedRevision || result.intent.expectedWorkflowVersionId !== input.expectedWorkflowVersionId) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Staging did not acknowledge the exact retained command and revision.' })
      }
      return result
    },
    async editAdvance(raw: GraphEditAdvanceInput) {
      const input = GraphEditAdvanceInputSchema.parse(raw)
      const result = assertIntentScope(await client.request(`${path(input.workspaceId, input.workflowId, input.draftId)}/edit-intents/${encodeURIComponent(input.intentId)}/advance`,
        GraphEditReadResultSchema, { method: 'POST', body: input }), input)
      if (!result.intent || result.intent.advanceCommandId !== input.commandId || result.intent.draftId !== input.draftId) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The Stop-and-save acknowledgement did not match the exact command.' })
      }
      return result
    },
    async editDiscard(raw: GraphEditDiscardInput) {
      const input = GraphEditDiscardInputSchema.parse(raw)
      const result = assertIntentScope(await client.request(`${path(input.workspaceId, input.workflowId, input.draftId)}/edit-intents/${encodeURIComponent(input.intentId)}/discard`,
        GraphEditReadResultSchema, { method: 'POST', body: input }), input)
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
        ? await client.request(`${url}/operations`, GraphDraftCommandV2ResultSchema,
          { method: 'POST', body: GraphDraftApplyV2InputSchema.parse(payload) })
        : await client.request(`${url}/save`, GraphSaveCommandV2ResultSchema,
          { method: 'POST', body: GraphSaveV2InputSchema.parse(payload) })
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
