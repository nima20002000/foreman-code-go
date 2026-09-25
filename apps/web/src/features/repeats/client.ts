import {
  ManagedWorkspaceSchema,
  RepeatCapabilitiesResultSchema,
  type ManagedWorkspace,
  type RepeatCapabilitiesResult,
} from '@graphql/contracts/management'
import {
  SavedManagedWorkflowSchema,
  type SavedManagedWorkflow,
  RepeatGetInputSchema,
  RepeatGetResultSchema,
  RepeatMutationInputSchema,
  RepeatMutationResultSchema,
  RepeatRunReadInputSchema,
  RepeatRunReadbackSchema,
  RepeatWorkflowReadbackSchema,
  type RepeatGetInput,
  type RepeatGetResult,
  type RepeatMutationInput,
  type RepeatMutationResult,
  type RepeatRunReadInput,
  type RepeatRunReadback,
  type RepeatWorkflowReadback,
} from '@graphql/contracts/wave25'
import { apiClient, ApiError, type ApiClient, type RequestOptions } from '../../shared/api/client'

const part = (value: string) => encodeURIComponent(value)
const repeatPath = (workspaceId: string, workflowId: string) =>
  `/api/management/workspaces/${part(workspaceId)}/workflows/${part(workflowId)}/repeat`

export type RepeatRunScope = Pick<RepeatRunReadInput, 'workspaceId' | 'workflowId' | 'runId'> & {
  workflowVersionId: string
  executionSemanticsVersion: 3
}

export interface RepeatClient {
  capabilities(workspaceId: string, workflowId: string, options?: RequestOptions): Promise<RepeatCapabilitiesResult>
  workflowMeta(workspaceId: string, workflowId: string, options?: RequestOptions): Promise<SavedManagedWorkflow>
  workspaceMeta(workspaceId: string, options?: RequestOptions): Promise<ManagedWorkspace>
  get(input: RepeatGetInput, options?: RequestOptions): Promise<RepeatGetResult>
  mutate(input: RepeatMutationInput, options?: RequestOptions): Promise<RepeatMutationResult>
  run(input: RepeatRunReadInput, options?: RequestOptions): Promise<RepeatRunReadback>
}

function assertWorkflowReadback(value: RepeatGetResult, workspaceId: string, workflowId: string): RepeatWorkflowReadback {
  const parsed = RepeatWorkflowReadbackSchema.safeParse(value)
  if (!parsed.success || parsed.data.workspaceId !== workspaceId || parsed.data.workflowId !== workflowId) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Repeat readback returned a different workflow scope.' })
  }
  return parsed.data
}

export function createRepeatClient(client: ApiClient = apiClient): RepeatClient {
  return {
    capabilities: async (workspaceId, workflowId, options) => {
      const query = new URLSearchParams({ workspaceId, workflowId })
      return client.request(`/api/management/repeats/capabilities?${query}`, RepeatCapabilitiesResultSchema, options)
    },
    workflowMeta: (workspaceId, workflowId, options) => client.request(
      `/api/management/workspaces/${part(workspaceId)}/workflows/${part(workflowId)}`,
      SavedManagedWorkflowSchema,
      options,
    ),
    workspaceMeta: (workspaceId, options) => client.request(
      `/api/management/workspaces/${part(workspaceId)}`,
      ManagedWorkspaceSchema,
      options,
    ),
    get: async (raw, options) => {
      const input = RepeatGetInputSchema.parse(raw)
      if ('action' in input && input.action === 'read_edits') {
        const query = new URLSearchParams({ draftId: input.draftId })
        if (input.intentId) query.set('intentId', input.intentId)
        return client.request(`${repeatPath(input.workspaceId, input.workflowId)}/edits?${query}`, RepeatGetResultSchema, options)
      }
      const value = await client.request(repeatPath(input.workspaceId, input.workflowId), RepeatGetResultSchema, options)
      return assertWorkflowReadback(value, input.workspaceId, input.workflowId)
    },
    mutate: async (raw, options) => {
      const input = RepeatMutationInputSchema.parse(raw)
      const edit = 'action' in input
      return client.request(
        edit ? `${repeatPath(input.workspaceId, input.workflowId)}/edits` : repeatPath(input.workspaceId, input.workflowId),
        RepeatMutationResultSchema,
        { ...options, method: edit ? 'POST' : 'PUT', body: input },
      )
    },
    run: async (raw, options) => {
      const input = RepeatRunReadInputSchema.parse(raw)
      const query = new URLSearchParams({ limit: String(input.limit), includeResultData: String(input.includeResultData) })
      if (input.cursor) query.set('cursor', input.cursor)
      const value = await client.request(
        `/api/management/workspaces/${part(input.workspaceId)}/workflows/${part(input.workflowId)}/runs/${part(input.runId)}/repeats?${query}`,
        RepeatRunReadbackSchema,
        options,
      )
      if (value.workspaceId !== input.workspaceId || value.workflowId !== input.workflowId || value.runId !== input.runId) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Repeat occurrence readback returned a different Run scope.' })
      }
      return value
    },
  }
}

export const repeatClient = createRepeatClient()
export { ApiError as RepeatClientError }
