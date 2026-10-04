import { useMutation, useMutationState, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  ScheduleDisableInputSchema, ScheduleSaveInputSchema,
  type ScheduleDisableInput, type ScheduleGetInput, type ScheduleGetResult, type ScheduleSaveInput,
  type ScheduleSaveResult,
} from '@foreman-code/contracts/schedules'
import { ApiError } from '../../shared/api/client'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { scheduleApi } from './client'

/** These are client command envelopes, not new API/domain shapes. */
export type ScheduleCommand = (
  | { kind: 'save'; input: ScheduleSaveInput }
  | { kind: 'disable'; input: ScheduleDisableInput }
) & { uncertainBefore: boolean }
export type NewScheduleCommand =
  | { kind: 'save'; input: Omit<ScheduleSaveInput, 'commandId'> }
  | { kind: 'disable'; input: Omit<ScheduleDisableInput, 'commandId'> }

type CommandState = {
  status: 'idle' | 'pending' | 'success' | 'error'
  variables?: ScheduleCommand
  error: unknown
}

export const scheduleKeys = {
  read: (scope: ScheduleGetInput, generation = sessionGeneration()) =>
    ['workflow-schedule', generation, scope.workspaceId, scope.workflowId] as const,
  latestOccurrence: (scope: ScheduleGetInput, generation = sessionGeneration()) =>
    ['workflow-schedule-latest-occurrence', generation, scope.workspaceId, scope.workflowId] as const,
  command: (scope: ScheduleGetInput, generation = sessionGeneration()) =>
    ['workflow-schedule-command', generation, scope.workspaceId, scope.workflowId] as const,
}

export function useLatestScheduleOccurrence(scope: ScheduleGetInput, open: boolean) {
  const generation = sessionGeneration()
  return useQuery({
    queryKey: scheduleKeys.latestOccurrence(scope, generation),
    queryFn: ({ signal }) => {
      assertSession(generation)
      return scheduleApi.occurrences({ ...scope, limit: 1 }, { signal })
    },
    enabled: open, staleTime: 0, retry: false,
    refetchOnMount: 'always', refetchOnWindowFocus: true, refetchOnReconnect: true,
    refetchInterval: open ? 5_000 : false,
  })
}

// Same conservative distinction as shared/api/commandAttempt.ts. An HTML 4xx,
// timeout, throttling, invalid response, or server/network failure can follow a commit.
function definiteRejection(error: unknown): boolean {
  return ApiError.is(error) && (error.code === 'INVALID_REQUEST'
    || (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
      && error.code !== 'HTTP_ERROR' && error.code !== 'INVALID_RESPONSE'))
}
function isUnconfirmed(state: CommandState | undefined): boolean {
  return state?.status === 'error' && (!!state.variables?.uncertainBefore || !definiteRejection(state.error))
}
function latest(client: QueryClient, key: readonly unknown[]): CommandState | undefined {
  // Only this hook writes this exact, session-scoped mutation key.
  return client.getMutationCache().findAll({ mutationKey: key, exact: true }).at(-1)?.state as CommandState | undefined
}

export function useWorkflowSchedule(scope: ScheduleGetInput, open = true) {
  const generation = sessionGeneration()
  return useQuery({
    queryKey: scheduleKeys.read(scope, generation),
    queryFn: ({ signal }) => { assertSession(generation); return scheduleApi.get(scope, { signal }) },
    enabled: open, staleTime: 0, retry: false,
    refetchOnMount: 'always', refetchOnWindowFocus: true, refetchOnReconnect: true,
    refetchInterval: open ? 5_000 : false,
  })
}

/**
 * TanStack owns the sole request/receipt state, including immutable command variables.
 * Retain the latest attempt across modal/board remounts. GET cannot prove whether an
 * unknown command committed; only an explicit replay of that SAME command can settle it.
 */
export function useScheduleCommand(scope: ScheduleGetInput) {
  const client = useQueryClient()
  const generation = sessionGeneration()
  const key = scheduleKeys.command(scope, generation)
  const readKey = scheduleKeys.read(scope, generation)
  const states = useMutationState<CommandState>({
    filters: { mutationKey: key, exact: true },
    select: (mutation) => mutation.state as CommandState,
  })
  const state = states.at(-1)
  const mutation = useMutation<ScheduleSaveResult, unknown, ScheduleCommand>({
    mutationKey: key,
    retry: false,
    // Do not queue an automatic offline mutation which could run after the user leaves.
    networkMode: 'always',
    gcTime: Infinity,
    mutationFn: (command) => {
      assertSession(generation)
      return command.kind === 'save' ? scheduleApi.save(command.input) : scheduleApi.disable(command.input)
    },
    onSuccess: async (result) => {
      await client.cancelQueries({ queryKey: readKey, exact: true })
      if (sessionGeneration() !== generation) return
      // This is validated persisted readback, never an optimistic draft projection.
      client.setQueryData<ScheduleGetResult>(readKey, { schedule: result.value })
      // A replay can return an older revision. Read today's authoritative state too.
      // A failed GET must NOT turn an already-confirmed write into an unknown write.
      void client.invalidateQueries({ queryKey: readKey, exact: true }).catch(() => undefined)
    },
    onError: (error) => {
      if (ApiError.is(error) && error.status === 409 && sessionGeneration() === generation) {
        void client.invalidateQueries({ queryKey: readKey, exact: true }).catch(() => undefined)
      }
    },
  })

  function execute(command: ScheduleCommand): Promise<ScheduleSaveResult> {
    // Retain one settled attempt (or the unresolved one) per workflow, not all past saves.
    for (const previous of client.getMutationCache().findAll({ mutationKey: key, exact: true })) {
      if (previous.state.status !== 'pending') client.getMutationCache().remove(previous)
    }
    return mutation.mutateAsync(command)
  }

  async function submit(command: NewScheduleCommand): Promise<ScheduleSaveResult | undefined> {
    assertSession(generation)
    const current = latest(client, key)
    // Read the cache synchronously, not a render snapshot: double clicks and a second
    // mounted control cannot start another command while the first is pending/unknown.
    if (current?.status === 'pending' || isUnconfirmed(current)) return undefined
    if (command.input.workspaceId !== scope.workspaceId || command.input.workflowId !== scope.workflowId) {
      throw new ApiError({ code: 'INVALID_REQUEST', message: 'The command belongs to a different workflow.' })
    }
    const input = { ...command.input, commandId: crypto.randomUUID() }
    return command.kind === 'save'
      ? execute({ kind: 'save', input: ScheduleSaveInputSchema.parse(input), uncertainBefore: false })
      : execute({ kind: 'disable', input: ScheduleDisableInputSchema.parse(input), uncertainBefore: false })
  }

  async function retry(): Promise<ScheduleSaveResult | undefined> {
    assertSession(generation)
    const current = latest(client, key)
    if (!isUnconfirmed(current) || !current?.variables) return undefined
    // The uncertainty latch survives even a later structured 4xx: it cannot disprove
    // an earlier commit. Never allocate a new command id or revalidate a past Once here.
    return execute({ ...current.variables, uncertainBefore: true })
  }

  const unconfirmed = isUnconfirmed(state)
  return {
    submit, retry,
    pending: state?.status === 'pending',
    unconfirmed,
    conflict: !unconfirmed && state?.status === 'error' && ApiError.is(state.error) && state.error.status === 409,
    error: state?.status === 'error' ? state.error : undefined,
    command: state?.variables,
  }
}
