import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ComputerMaintenanceListSchema, ComputerMaintenanceStartInputSchema, ComputerMaintenanceStartResultSchema,
  type ComputerMaintenanceList, type ComputerMaintenanceStartInput,
} from '@foreman-code/contracts/computer-maintenance'
import { apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

const key = () => ['computer-maintenance', sessionGeneration()] as const
const running = (value: ComputerMaintenanceList | undefined) =>
  Boolean(value?.computers.some(computer => computer.status?.tasks.some(task => task.state === 'running')))

/** Versions, OS updates, restart need, disk and recent maintenance tasks for every computer. Polls faster while a task runs. */
export function useComputerMaintenance() {
  useHarnessSessionEpoch()
  return useQuery<ComputerMaintenanceList>({ queryKey: key(), enabled: !sessionIsSwitching(), retry: false, staleTime: 15_000,
    refetchInterval: query => running(query.state.data) ? 5_000 : 60_000,
    queryFn: ({ signal }) => apiClient.request('/api/management/computers/maintenance', ComputerMaintenanceListSchema, { signal }) })
}

/** Starts one maintenance task. Each call is a new command; status readback shows its progress. */
export function useStartMaintenance() {
  const client = useQueryClient()
  return useMutation({ retry: false,
    mutationFn: (input: Omit<ComputerMaintenanceStartInput, 'commandId'> | Omit<ComputerMaintenanceStartInput, 'commandId'>[]) => {
      const requests = Array.isArray(input) ? input : [input]
      return Promise.all(requests.map(request => apiClient.request('/api/management/computers/maintenance/start',
        ComputerMaintenanceStartResultSchema, {
          method: 'POST', body: ComputerMaintenanceStartInputSchema.parse({ ...request, commandId: crypto.randomUUID() }),
        })))
    },
    onSettled: () => client.invalidateQueries({ queryKey: key() }),
  })
}
