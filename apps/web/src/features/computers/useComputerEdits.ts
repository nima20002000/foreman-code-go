import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { BuildComputerStatus, BuildComputerUpdate } from '@foreman-code/contracts/build-computers'
import { buildComputerKeys, updateBuildComputer } from '../../shared/api/buildComputers'
import { ApiError } from '../../shared/api/client'

interface ComputerEdit {
  before: BuildComputerStatus
  input: BuildComputerUpdate
  restoreCommandId: string
}
export type ComputerPreferencePatch = Partial<Pick<BuildComputerUpdate,
  'buildEnabled' | 'buildPriority' | 'buildRole' | 'buildAllowancePercent'>>
export function preferenceEdit(status: BuildComputerStatus, patch: ComputerPreferencePatch): ComputerEdit {
  const preference = status.preference
  return { before: status, restoreCommandId: crypto.randomUUID(), input: {
    target: preference.target, buildEnabled: patch.buildEnabled ?? preference.buildEnabled,
    buildPriority: patch.buildPriority ?? preference.buildPriority, buildRole: patch.buildRole ?? preference.buildRole,
    buildAllowancePercent: patch.buildAllowancePercent ?? preference.buildAllowancePercent,
    expectedRevision: preference.revision, commandId: crypto.randomUUID(),
  } }
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
  }).filter(value => value.input.buildPriority !== value.before.preference.buildPriority
    || value.input.buildRole !== value.before.preference.buildRole)
}

async function saveWithRetry(input: BuildComputerUpdate) {
  try {
    return await updateBuildComputer(input)
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'NETWORK_ERROR' || error.status >= 500)) {
      return updateBuildComputer(input)
    }
    throw error
  }
}
async function saveEdits(edits: ComputerEdit[]) {
  const saved: { edit: ComputerEdit; status: BuildComputerStatus }[] = []
  try {
    for (const edit of edits) saved.push({ edit, status: await saveWithRetry(edit.input) })
    return saved.map(value => value.status)
  } catch (error) {
    // The single-computer API is revisioned. Restore completed writes if a later row conflicts.
    for (const value of saved.reverse()) {
      const restore = preferenceEdit(value.status, value.edit.before.preference).input
      try {
        await saveWithRetry({ ...restore, commandId: value.edit.restoreCommandId,
          expectedRevision: value.status.preference.revision })
      } catch (restoreError) {
        throw new Error('Some changes could not be restored. Refresh to see the saved order.', { cause: restoreError })
      }
    }
    throw error
  }
}
export function useComputerEdits() {
  const cache = useQueryClient()
  return useMutation({ mutationFn: saveEdits, retry: false,
    onMutate: async edits => {
      await cache.cancelQueries({ queryKey: buildComputerKeys.root })
      for (const { before, input } of edits) {
        cache.setQueryData(buildComputerKeys.computer(input.target), { ...before,
          preference: { ...before.preference, buildEnabled: input.buildEnabled, buildPriority: input.buildPriority,
            buildRole: input.buildRole ?? before.preference.buildRole,
            buildAllowancePercent: input.buildAllowancePercent ?? before.preference.buildAllowancePercent } })
      }
    },
    onSuccess: statuses => {
      for (const status of statuses) cache.setQueryData(buildComputerKeys.computer(status.preference.target), status)
    },
    onError: (_error, edits) => {
      for (const edit of edits) cache.setQueryData(buildComputerKeys.computer(edit.input.target), edit.before)
    },
    onSettled: () => cache.invalidateQueries({ queryKey: buildComputerKeys.root }),
  })
}
export function computerEditError(error: unknown) {
  if (error instanceof ApiError && error.status === 409) return 'Settings changed elsewhere. Order restored; try again.'
  if (error instanceof Error) return error.message
  return 'Changes could not be saved. Try again.'
}
