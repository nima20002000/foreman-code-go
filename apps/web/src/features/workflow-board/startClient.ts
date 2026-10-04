import { WorkflowRunV3Schema, RunStartV3InputSchema, RunStartV3ResultSchema, sameWorkflowValue, type RunStartV3Input } from '@foreman-code/contracts/wave25'
import { apiClient, ApiError, type ApiClient } from '../../shared/api/client'

export type BoardStartInput = RunStartV3Input
/** No negotiation, missing-tag default, retired-tag fallback or repeat projection. */
export function parseBoardStart(value: unknown): BoardStartInput { return RunStartV3InputSchema.parse(value) }
export function createBoardStartClient(client: ApiClient = apiClient) {
  return {
    async start(raw: BoardStartInput) {
      const input = parseBoardStart(raw)
      const result = await client.request(
        `/api/management/workspaces/${encodeURIComponent(input.workspaceId)}/workflows/${encodeURIComponent(input.workflowId)}/runs`,
        RunStartV3ResultSchema, { method: 'POST', body: input })
      // The public Run omits its private authority principal; location is required.
      if (!WorkflowRunV3Schema.safeParse(result.run).success || !result.run.executionLocation) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The admitted Run is missing accepted configuration or location pins. Reconcile the same command.' })
      }
      if (result.run.workspaceId !== input.workspaceId || result.run.workflowId !== input.workflowId
        || result.run.workflowVersionId !== input.workflowVersionId || result.run.executionSemanticsVersion !== 3
        || !sameWorkflowValue(result.run.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)
        || !sameWorkflowValue(result.run.input, input.input)
        || result.run.executionLocation?.locationRevision !== input.expectedLocationRevision) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The admitted Run did not match the retained Start pins. Reconcile the same command.' })
      }
      return result
    },
  }
}
export const boardStartClient = createBoardStartClient()
