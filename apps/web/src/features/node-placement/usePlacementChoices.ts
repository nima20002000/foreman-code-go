import { useQuery } from '@tanstack/react-query'
import type { NodePlacementChoicesInput } from '@foreman-code/contracts/placement-readback'
import { assertSession, sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { readPlacementChoices } from './client'
import type { NodePlacementOption } from './NodePlacementField'

export function usePlacementChoices(scope: NodePlacementChoicesInput | undefined, visit: string) {
  const session = sessionGeneration()
  const query = useQuery({
    queryKey: ['node-placement-choices', session, visit, scope?.workspaceId, scope?.workflowId, scope?.nodeId, scope?.agentConfigurationVersionId],
    queryFn: async ({ signal }) => {
      if (!scope) throw new Error('Save this node and Agent before choosing a computer.')
      const response = await readPlacementChoices(scope, { signal })
      assertSession(session)
      return response
    },
    enabled: !!scope && !sessionIsSwitching(), retry: false, staleTime: 0, gcTime: 0, placeholderData: () => undefined,
  })
  const current = session === sessionGeneration() && !sessionIsSwitching()
  const options: readonly NodePlacementOption[] = current && !query.isError && query.data ? query.data.choices.map((choice) => ({
    placement: choice.placement, label: choice.label,
    ...(choice.availability !== 'ready' ? { unavailableReason: choice.reason ?? `Computer ${choice.availability}` } : {}),
  })) : []
  return { ...query, current, options }
}
