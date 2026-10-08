import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query'
import type { BuildComputerStatus, BuildComputerChange, BuildComputerBatchUpdate } from '@foreman-code/contracts/build-computers'
import { buildComputerKeys, updateBuildComputers } from '../../shared/api/buildComputers'
import { ApiError } from '../../shared/api/client'
import { assertSession, sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { retainBuildComputerCommand, settleBuildComputerCommand, useBuildComputerCommand } from '../../shared/api/buildComputerCommands'
import { commandWasRejected } from '../../shared/api/commandAttempt'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'

export type ComputerPreferencePatch = Partial<Pick<BuildComputerChange,
  'buildEnabled' | 'buildPriority' | 'buildRole' | 'buildAllowancePercent'>>
export function preferenceEdit(status: BuildComputerStatus, patch: ComputerPreferencePatch): BuildComputerChange {
  const preference = status.preference
  return {
    target: preference.target, buildEnabled: patch.buildEnabled ?? preference.buildEnabled,
    buildPriority: patch.buildPriority ?? preference.buildPriority, buildRole: patch.buildRole ?? preference.buildRole,
    buildAllowancePercent: patch.buildAllowancePercent ?? preference.buildAllowancePercent,
    expectedRevision: preference.revision,
  }
}
export function reorderEdits(statuses: readonly BuildComputerStatus[], from: number, to: number) {
  const ordered = [...statuses]
  const [moved] = ordered.splice(from, 1)
  if (!moved || to < 0 || to >= statuses.length || from === to) return []
  ordered.splice(to, 0, moved)
  // A computer dropped among Backups becomes a Backup, and among Primaries a Primary.
  const role = (ordered[to - 1] ?? ordered[to + 1])!.preference.buildRole
  return ordered.map((status, index) => {
    const priority = ordered.length === 1 ? 100 : Math.round(100 * (ordered.length - 1 - index) / (ordered.length - 1))
    return preferenceEdit(status, { buildPriority: priority, ...(status === moved ? { buildRole: role } : {}) })
  })
}

interface SaveAttempt {
  input: BuildComputerBatchUpdate
  generation: number
  key: string
  recovering: boolean
}
async function saveWithRetry(attempt: SaveAttempt) {
  try {
    return await updateBuildComputers(attempt.input, attempt.generation)
  } catch (error) {
    assertSession(attempt.generation)
    if (error instanceof ApiError && (error.code === 'NETWORK_ERROR' || error.status >= 500)) {
      attempt.recovering = true
      return updateBuildComputers(attempt.input, attempt.generation)
    }
    throw error
  }
}
export function useComputerEdits(mainId: string) {
  const cache = useQueryClient()
  const generation = sessionGeneration()
  const journal = useBuildComputerCommand(mainId)
  const mutationKey = ['build-computer-save', generation, mainId]
  const busy = useIsMutating({ mutationKey }) > 0
  const active = (attempt: SaveAttempt) => attempt.generation === sessionGeneration() && !sessionIsSwitching()
  const save = useMutation({ mutationKey, mutationFn: saveWithRetry, retry: false, networkMode: 'always',
    onMutate: async attempt => {
      assertSession(attempt.generation)
      retainBuildComputerCommand(attempt.key, attempt.input)
      await cache.cancelQueries({ queryKey: ['build-computers', attempt.generation] })
      assertSession(attempt.generation)
      return { retained: true }
    },
    onSuccess: (statuses, attempt) => {
      if (!active(attempt)) return
      for (const status of statuses) {
        cache.setQueryData(buildComputerKeys.computer(status.preference.target, attempt.generation), status)
      }
      settleBuildComputerCommand(attempt.key, attempt.input.commandId)
    },
    onError: (error, attempt, context) => {
      if (!context?.retained || !active(attempt) || !commandWasRejected(error)) return
      // Lost responses followed by denied access cannot disprove an earlier commit.
      if (attempt.recovering && !(ApiError.is(error) && error.code === 'REVISION_CONFLICT')) return
      settleBuildComputerCommand(attempt.key, attempt.input.commandId)
    },
    onSettled: (_data, _error, attempt) => {
      if (active(attempt)) return cache.invalidateQueries({ queryKey: ['build-computers', attempt.generation] })
    },
  })
  const retry = () => {
    if (busy || !journal.pending || generation !== sessionGeneration() || sessionIsSwitching()) return
    save.mutate({ input: journal.pending, key: journal.key, generation, recovering: true })
  }
  useUnsavedChanges({ scope: 'surface', label: 'computer build settings', dirty: false, busy,
    uncertain: Boolean(journal.pending), saveDisabled: busy || !journal.pending,
    save: retry, discard: () => { throw new Error('Retry the original save before leaving.') },
  })
  return { ...save, isPending: busy, uncertain: Boolean(journal.pending) && !busy,
    locked: busy || Boolean(journal.pending) || !journal.ready || Boolean(journal.error) || sessionIsSwitching(),
    storageError: journal.error, retry, retryStorage: journal.reload,
    mutate: (edits: BuildComputerChange[]) => {
      if (busy || journal.pending || !journal.ready || journal.error || !edits.length
        || generation !== sessionGeneration() || sessionIsSwitching()) return
      save.mutate({ input: { commandId: crypto.randomUUID(), updates: edits },
        key: journal.key, generation, recovering: false })
    },
  }
}
export function computerEditError(error: unknown) {
  if (error instanceof ApiError && error.status === 409) return 'Settings changed elsewhere. No changes were saved; try again.'
  if (error instanceof Error) return error.message
  return 'Changes could not be saved. Try again.'
}
