import { useCallback, useEffect } from 'react'
import {
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { WorkspaceDetailsResponse } from '@graphql/contracts'

import { WorkflowGraph } from '../features/graph'
import { ApiError } from '../shared/api/client'
import {
  queryKeys,
  useWorkspaceDetailsQuery,
} from '../shared/api/query'
import {
  getMockScenario,
  resetMockScenario,
  selectMockScenario,
  type MockScenarioResponse,
} from '../shared/mocks/control'
import { WorkspaceSelection } from './WorkspaceRoute'

const mockScenarioQueryKey = ['workbench', 'mock-scenario'] as const

function isMockControlsEnabled(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_ENABLE_MSW === 'true'
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function isNotFound(error: unknown): boolean {
  return ApiError.is(error) && error.status === 404
}

function WorkspaceHeader({ details }: { details: WorkspaceDetailsResponse }) {
  return <strong data-testid="workspace-name">{details.workspace.name}</strong>
}

function cacheWorkspaceProjection(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
  details: WorkspaceDetailsResponse,
) {
  queryClient.setQueryData(queryKeys.agents(workspaceId), { agents: details.agents })
  for (const workflow of details.workflows) {
    queryClient.setQueryData(queryKeys.workflow(workspaceId, workflow.id), { workflow })
  }
}

interface MockDataControlProps {
  workspaceId: string
}

/**
 * The selector intentionally talks to the mock HTTP control endpoints. It
 * never imports fixture data, and removing only query caches leaves graph and
 * conversation drafts in their local stores.
 */
function MockDataControl({ workspaceId }: MockDataControlProps) {
  const queryClient = useQueryClient()
  const controlsEnabled = isMockControlsEnabled()
  const scenarioQuery = useQuery<MockScenarioResponse>({
    queryKey: mockScenarioQueryKey,
    queryFn: ({ signal }) => getMockScenario({ signal }),
    enabled: controlsEnabled,
    staleTime: Infinity,
    retry: false,
  })
  const scenarioMutation = useMutation({
    mutationFn: async (scenarioId: string) => {
      // Selecting a scenario rebuilds server state; the explicit reset keeps
      // this route's control correct even if the control endpoint changes its
      // selection semantics later.
      await selectMockScenario(scenarioId)
      return resetMockScenario()
    },
    onSuccess: (nextScenario) => {
      queryClient.setQueryData(mockScenarioQueryKey, nextScenario)

      // Product state is server-owned. Remove workspace projections so active
      // queries refetch the selected fixture. Zustand-owned unsaved graph and
      // conversation drafts are deliberately untouched.
      queryClient.removeQueries({ queryKey: queryKeys.workspace(workspaceId), type: 'inactive' })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workspace(workspaceId),
        refetchType: 'active',
      })
    },
  })

  if (!controlsEnabled) return null

  if (scenarioQuery.isPending) {
    return (
      <section className="mock-data-control" data-testid="mock-data-control" aria-label="Mock data">
        <span className="slot-label">Mock data</span>
        <p role="status">Loading scenarios…</p>
      </section>
    )
  }

  if (scenarioQuery.isError || !scenarioQuery.data) {
    return (
      <section className="mock-data-control" data-testid="mock-data-control" aria-label="Mock data">
        <span className="slot-label">Mock data</span>
        <p role="alert">Mock scenarios are unavailable.</p>
      </section>
    )
  }

  const selectedScenario = scenarioMutation.variables ?? scenarioQuery.data.scenarioId
  const activeFailureMode = scenarioQuery.data.failureMode

  return (
    <section className="mock-data-control" data-testid="mock-data-control" aria-label="Mock data">
      <div>
        <span className="slot-label">Mock data</span>
        <strong data-testid="mock-mode">{selectedScenario}</strong>
        {activeFailureMode !== 'none' ? <span> · {activeFailureMode}</span> : null}
      </div>
      <label>
        Scenario
        <select
          aria-label="Mock data scenario"
          value={selectedScenario}
          disabled={scenarioMutation.isPending}
          onChange={(event) => scenarioMutation.mutate(event.target.value)}
        >
          {scenarioQuery.data.scenarios.map((scenario) => (
            <option value={scenario} key={scenario}>
              {scenario}
            </option>
          ))}
        </select>
      </label>
      {scenarioMutation.isError ? (
        <p role="alert">Could not switch mock scenario: {readableError(scenarioMutation.error, 'request failed')}</p>
      ) : null}
    </section>
  )
}

function routeChildren(workspaceId: string) {
  return <MockDataControl workspaceId={workspaceId} />
}

/** Router adapter: URL state stays in TanStack Router and is handed to the shell as props. */
export function WorkspaceRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId' })
  const { agentId } = useSearch({ from: '/workspaces/$workspaceId' })
  const navigate = useNavigate({ from: '/workspaces/$workspaceId' })
  const queryClient = useQueryClient()
  const workspaceQuery = useWorkspaceDetailsQuery(workspaceId)

  const selectAgent = useCallback(
    (nextAgentId: string) => {
      void navigate({
        search: (previous) => ({ ...previous, agentId: nextAgentId }),
      })
    },
    [navigate],
  )

  const clearAgent = useCallback(() => {
    void navigate({
      search: (previous) => {
        const next = { ...previous }
        delete next.agentId
        return next
      },
    })
  }, [navigate])

  useEffect(() => {
    if (!workspaceQuery.data) return
    cacheWorkspaceProjection(queryClient, workspaceId, workspaceQuery.data)
  }, [queryClient, workspaceId, workspaceQuery.data])

  const children = routeChildren(workspaceId)

  if (workspaceQuery.isPending) {
    return <WorkspaceSelection workspaceId={workspaceId} state="loading" children={children} />
  }

  if (workspaceQuery.isError || !workspaceQuery.data) {
    const notFound = isNotFound(workspaceQuery.error)
    return (
      <WorkspaceSelection
        workspaceId={workspaceId}
        state={notFound ? 'not-found' : 'error'}
        stateMessage={readableError(
          workspaceQuery.error,
          notFound ? `Workspace ${workspaceId} is not available.` : 'The workspace could not be loaded.',
        )}
        children={
          <>
            {children}
            {!notFound ? (
              <button type="button" onClick={() => void workspaceQuery.refetch()}>
                Retry workspace request
              </button>
            ) : null}
          </>
        }
      />
    )
  }

  const details = workspaceQuery.data
  const selectedAgentIsStale = Boolean(agentId && !details.agents.some((agent) => agent.id === agentId))
  const workflow = details.workflows[0]
  const state = selectedAgentIsStale ? 'stale' : workflow ? 'ready' : 'empty'

  return (
    <WorkspaceSelection
      workspaceId={workspaceId}
      selectedAgentId={agentId}
      state={state}
      slots={{
        workspace: <WorkspaceHeader details={details} />,
        graph: workflow ? (
          <WorkflowGraph
            workspaceId={workspaceId}
            workflowId={workflow.id}
            selectedAgentId={agentId}
            onSelectAgent={selectAgent}
            onClearAgent={clearAgent}
          />
        ) : undefined,
      }}
      children={children}
    />
  )
}
