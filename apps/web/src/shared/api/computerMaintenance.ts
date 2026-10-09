import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'
import {
  ComputerMaintenanceListSchema, ComputerMaintenanceStartInputSchema, ComputerMaintenanceStartResultSchema,
  type ComputerMaintenanceList, type ComputerMaintenanceStartInput, type ComputerMaintenanceStartResult,
} from '@foreman-code/contracts/computer-maintenance'
import { ApiError, apiClient } from './client'
import { commandWasRejected } from './commandAttempt'
import { useHarnessSessionEpoch } from './harnessSettings'
import { assertSession, sessionGeneration, sessionIsSwitching } from './sessionBoundary'

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

type MaintenanceInput = Omit<ComputerMaintenanceStartInput, 'commandId'>
// A batch mutation has one result/error. Retain each sibling's acknowledgement only for retry ownership;
// current task facts still come from the maintenance query cache.
type MaintenanceAttempt = {
  input: MaintenanceInput[]
  generation: number
  entries: { request: ComputerMaintenanceStartInput; outcome?: PromiseSettledResult<ComputerMaintenanceStartResult> }[]
}

/** Keeps immutable command identities while a response is unknown, including each sibling of a fleet action. */
export function useStartMaintenance() {
  const client = useQueryClient()
  const pending = useRef<MaintenanceAttempt | undefined>(undefined)
  const mutation = useMutation({ retry: false,
    mutationFn: async (input: MaintenanceInput | MaintenanceInput[]) => {
      const requests = Array.isArray(input) ? input : [input]
      const reconciling = pending.current !== undefined
      if (pending.current && JSON.stringify(pending.current.input) !== JSON.stringify(requests)) {
        throw new Error('Retry the original maintenance request before starting another action.')
      }
      pending.current ??= {
        input: structuredClone(requests), generation: sessionGeneration(),
        entries: requests.map(request => ({
          request: ComputerMaintenanceStartInputSchema.parse({ ...request, commandId: crypto.randomUUID() }),
        })),
      }
      const attempt = pending.current
      assertSession(attempt.generation)
      const unresolved = attempt.entries.filter(entry => entry.outcome === undefined)
      const outcomes = await Promise.allSettled(unresolved.map(entry => apiClient.request(
        '/api/management/computers/maintenance/start', ComputerMaintenanceStartResultSchema,
        { method: 'POST', body: entry.request },
      )))
      const failures: unknown[] = []
      for (const [index, outcome] of outcomes.entries()) {
        const entry = unresolved[index]!
        if (outcome.status === 'fulfilled') entry.outcome = outcome
        else {
          failures.push(outcome.reason as unknown)
          const deniedReadback = reconciling && outcome.reason instanceof ApiError
            && (outcome.reason.status === 401 || outcome.reason.status === 403)
            && outcome.reason.code !== 'conflict'
          if (commandWasRejected(outcome.reason) && !deniedReadback) entry.outcome = outcome
        }
      }
      if (attempt.entries.every(entry => entry.outcome !== undefined)) pending.current = undefined
      for (const entry of attempt.entries) {
        if (entry.outcome?.status === 'rejected') failures.push(entry.outcome.reason as unknown)
      }
      if (failures.length) throw failures[0]
      return attempt.entries.flatMap(entry => entry.outcome?.status === 'fulfilled' ? [entry.outcome.value] : [])
    },
    onSettled: () => client.invalidateQueries({ queryKey: key() }),
  })
  return {
    ...mutation,
    unresolved: pending.current !== undefined,
    retryOriginal: () => { if (pending.current) mutation.mutate(pending.current.input) },
    reconcile: async () => { if (pending.current) await mutation.mutateAsync(pending.current.input) },
  }
}
