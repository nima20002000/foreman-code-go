import { AgentVersionResultSchema } from '@graphql/contracts/management'
import { CurrentWorkflowVersionDetailSchema, CurrentRunVersionSnapshotSchema, RepeatGraphScopeV3Schema, canonicalGraphJson,
  sameWorkflowValue, type RepeatGraphScopeV3, type RepeatGraphCurrentV3, type CurrentRunDetails } from '@graphql/contracts/wave25'
import { apiClient, ApiError, type RequestOptions } from '../../shared/api/client'
import { readBoardRun, scopeForBoardRun } from './client'
const part = encodeURIComponent
const invalid = (message: string) => new ApiError({ code: 'INVALID_RESPONSE', message })

export async function readPinnedRun(scope: RepeatGraphScopeV3, options?: RequestOptions) {
  RepeatGraphScopeV3Schema.parse(scope)
  const detail = await readBoardRun(scope.workspaceId, scope.workflowId, scope.runId, options)
  if (!sameWorkflowValue(scopeForBoardRun(detail.run), scope)) throw invalid('Run details changed the selected immutable version pins.')
  return detail
}
export async function readPinnedRunVersion(scope: RepeatGraphScopeV3, detail: CurrentRunDetails, options?: RequestOptions) {
  const { version } = await apiClient.request(`/api/management/workspaces/${part(scope.workspaceId)}/workflows/${part(scope.workflowId)}/versions/${part(scope.workflowVersionId)}`,
    CurrentWorkflowVersionDetailSchema, options)
  CurrentRunVersionSnapshotSchema.parse({ run: detail.run, version })
  const configurations = await Promise.all(Object.entries(version.agentConfigurationVersionIds).map(async ([agentId, versionId]) => {
    const result = await apiClient.request(`/api/management/workspaces/${part(scope.workspaceId)}/agents/${part(agentId)}/versions/${part(versionId)}`,
      AgentVersionResultSchema, options)
    if (result.version.id !== versionId || result.version.agentId !== agentId || result.version.workspaceId !== scope.workspaceId) throw invalid('Configuration detail returned a different immutable Agent pin.')
    return result.version
  }))
  return { version, configurations }
}
export async function digestCurrentValue(value: unknown, maxBytes = 4 * 1024 * 1024): Promise<string> {
  const input = new TextEncoder().encode(canonicalGraphJson(value, maxBytes))
  const digest = await crypto.subtle.digest('SHA-256', input)
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
/** Private details can be read after a newer cut. Match exact identities and immutable
 * input/result digests; never substitute those mutable lifecycle fields for the cut. */
export async function verifyRunExecutionDetails(snapshot: RepeatGraphCurrentV3, detail: CurrentRunDetails) {
  if (!sameWorkflowValue(scopeForBoardRun(detail.run), snapshot.scope)) throw invalid('Run evidence is out of scope.')
  const byId = new Map(detail.executions.map((execution) => [execution.id, execution]))
  return Promise.all(snapshot.state.executions.map(async (fact) => {
    const execution = byId.get(fact.identity.executionId)
    if (!execution) return { fact, execution: undefined, acceptedResult: undefined }
    if (execution.workflowNodeId !== fact.identity.workflowNodeId || execution.agentId !== fact.identity.agentId
      || execution.agentConfigurationVersionId !== fact.identity.agentConfigurationVersionId || execution.attempt !== fact.identity.attempt
      || await digestCurrentValue(execution.input) !== fact.inputDigest) throw invalid('Execution detail does not match its exact occurrence, attempt, configuration or input digest.')
    const accepted = snapshot.state.results.find((result) => result.execution.executionId === execution.id)
    if (accepted && (!sameWorkflowValue(accepted.execution, fact.identity) || !execution.result
      || await digestCurrentValue(execution.result, 64 * 1024) !== accepted.resultDigest)) throw invalid('Accepted result detail does not match its exact canonical result digest.')
    return { fact, execution, acceptedResult: accepted ? execution.result : undefined }
  }))
}
