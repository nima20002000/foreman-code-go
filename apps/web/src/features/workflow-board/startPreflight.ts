import { useQuery } from '@tanstack/react-query'
import { ManagedWorkspaceSchema } from '@graphql/contracts/management'
import { CurrentManagedWorkflowSchema, CurrentWorkflowCapabilitiesSchema, CurrentWorkflowVersionDetailSchema,
  GraphDraftV3Schema, RunStartV3InputSchema, sameExecutableWorkflow, sameWorkflowValue,
  type GraphDraftV3, type RunStartV3Input } from '@graphql/contracts/wave25'
import { apiClient, ApiError, type ApiClient, type RequestOptions } from '../../shared/api/client'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
const part = encodeURIComponent
const mismatch = (message: string) => new ApiError({ code: 'START_PREFLIGHT_CONFLICT', message }, 409)

/** Generic saved V3 reads, irrespective of optional repeat. These are not native admission authority. */
export function createBoardPreflightClient(client: ApiClient = apiClient) {
  return async (displayed: GraphDraftV3, options?: RequestOptions) => {
    const { workspaceId, workflowId } = displayed
    const workflowPath = `/api/management/workspaces/${part(workspaceId)}/workflows/${part(workflowId)}`
    const query = new URLSearchParams({ workspaceId, workflowId })
    const [workflow, workspace, capabilities, draft] = await Promise.all([
      client.request(workflowPath, CurrentManagedWorkflowSchema, options),
      client.request(`/api/management/workspaces/${part(workspaceId)}`, ManagedWorkspaceSchema, options),
      client.request(`/api/management/repeats/capabilities?${query}`, CurrentWorkflowCapabilitiesSchema, options),
      client.request(`${workflowPath}/drafts/${part(displayed.id)}`, GraphDraftV3Schema, options),
    ])
    if (workflow.workflow.id !== workflowId || workflow.workflow.workspaceId !== workspaceId || workspace.workspace.id !== workspaceId
      || draft.id !== displayed.id || draft.workspaceId !== workspaceId || draft.workflowId !== workflowId) {
      throw mismatch('Saved Start readback belongs to a different scope.')
    }
    const detail = workflow.currentVersionId ? await client.request(
      `${workflowPath}/versions/${part(workflow.currentVersionId)}`, CurrentWorkflowVersionDetailSchema, options) : undefined
    const version = detail?.version
    if (version && (version.id !== workflow.currentVersionId || version.workspaceId !== workspaceId || version.workflowId !== workflowId)) {
      throw mismatch('Immutable workflow readback returned a different saved version.')
    }
    return { workflow, workspace, capabilities, draft, version }
  }
}
export const readBoardStartPreflight = createBoardPreflightClient()
export type BoardStartPreflight = Awaited<ReturnType<typeof readBoardStartPreflight>>
export type BoardStartPins = Pick<RunStartV3Input, 'workflowVersionId' | 'expectedWorkflowRevision' |
  'expectedAgentConfigurationVersionIds' | 'expectedLocationRevision' | 'draftId' | 'expectedDraftRevision'>

export function boardStartPins(displayed: GraphDraftV3, facts: BoardStartPreflight): BoardStartPins {
  const { workflow, workspace, capabilities, draft, version } = facts
  if (!capabilities.supported || !capabilities.availability.runtimeAdmission || !capabilities.availability.persistedReadback) {
    throw new Error(`Current workflow Start is unavailable on this deployment${capabilities.availability.reasons.length ? `: ${capabilities.availability.reasons.join(', ')}` : '.'}`)
  }
  if (!version || !displayed.baseWorkflowVersionId) throw new Error('Save the workflow before starting a Run.')
  if (workflow.archivedAt || workspace.archivedAt || workspace.locationValidation.status !== 'ready') throw new Error('The workspace, workflow or execution folder is unavailable.')
  if (draft.id !== displayed.id || draft.revision !== displayed.revision || draft.baseWorkflowVersionId !== displayed.baseWorkflowVersionId
    || draft.publishedRevision !== draft.revision || displayed.publishedRevision !== displayed.revision || draft.stagedAgents.length
    || version.id !== displayed.baseWorkflowVersionId || version.id !== workflow.currentVersionId
    || !sameExecutableWorkflow(draft.graph, displayed.graph) || !sameExecutableWorkflow(version.definition, displayed.graph)) {
    throw mismatch('The displayed draft is not the exact published workflow. Save or explicitly reload before Start.')
  }
  // Metadata labels may have changed since the immutable version. They do not
  // replace executable fields, and the displayed workflow revision remains pinned.
  if (!sameExecutableWorkflow(version.definition, { ...workflow.workflow, name: version.definition.name, description: version.definition.description })) {
    throw mismatch('Saved executable meaning changed. Reload before Start.')
  }
  if (draft.sourceAgentPins && Object.entries(version.agentConfigurationVersionIds).some(([agentId, configurationVersionId]) =>
    !draft.sourceAgentPins?.some((pin) => pin.agentId === agentId && pin.configurationVersionId === configurationVersionId))) {
    throw mismatch('The displayed configuration pins are no longer current. Save or reload the workflow.')
  }
  return { workflowVersionId: version.id, expectedWorkflowRevision: workflow.revision,
    expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds, expectedLocationRevision: workspace.locationRevision,
    draftId: displayed.id, expectedDraftRevision: displayed.revision }
}
export function sameBoardStartPins(a: BoardStartPins, b: BoardStartPins) { return sameWorkflowValue(a, b) }
export function currentBoardStartRequest(displayed: GraphDraftV3, facts: BoardStartPreflight, commandId: string): RunStartV3Input {
  return RunStartV3InputSchema.parse({ executionSemanticsVersion: 3, workspaceId: displayed.workspaceId,
    workflowId: displayed.workflowId, ...boardStartPins(displayed, facts), commandId, input: {} })
}
export function useBoardStartPreflight(draft: GraphDraftV3) {
  return useQuery({ queryKey: ['workbench', 'board-start-preflight', sessionGeneration(), draft.workspaceId, draft.workflowId,
    draft.id, draft.revision, draft.baseWorkflowVersionId],
    queryFn: ({ signal }) => readBoardStartPreflight(draft, { signal }), retry: false, staleTime: 1000,
    refetchOnReconnect: 'always', refetchOnWindowFocus: true,
    refetchInterval: (state) => ApiError.is(state.state.error) && [401, 403, 404].includes(state.state.error.status ?? 0) ? false : 3000,
  })
}
