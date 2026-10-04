import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { assertSession, sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { runReadErrorLabel } from '../runs-selector/query'
import { NodePlacementFacts } from './NodePlacementFacts'
import { readNodePlacement } from './client'

/** The parent keys this read by the complete immutable inspection scope. Each
 * mount owns a distinct query visit, including A→B→A after ignored cancellation. */
export function PinnedNodePlacement({ scope, nodeId }: { scope: RepeatGraphScopeV3; nodeId: string }) {
  const visit = useId(), session = sessionGeneration()
  const query = useQuery({
    queryKey: ['node-placement-inspection', session, visit, scope.workspaceId, scope.workflowId, scope.runId,
      scope.workflowVersionId, scope.executionSemanticsVersion, nodeId],
    queryFn: async ({ signal }) => {
      const result = await readNodePlacement({ workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId, nodeId }, { signal })
      assertSession(session)
      return result
    },
    enabled: !sessionIsSwitching(), retry: false, staleTime: 0, gcTime: 0, placeholderData: () => undefined,
  })
  if (session !== sessionGeneration() || sessionIsSwitching()) return null
  if (query.isError) return <p role="status">{runReadErrorLabel(query.error)}. Computer evidence is unavailable.</p>
  if (!query.data) return <p role="status">{query.isPaused ? 'Offline. Computer evidence is unavailable.' : 'Reading accepted computer evidence…'}</p>
  return <NodePlacementFacts runId={scope.runId} nodeId={nodeId} readback={query.data.readback} />
}
