import { staysOnWorkflowBoard } from '@foreman-code/contracts/wave25'
import { useUnsavedChanges } from '../../../shared/ui/unsavedChanges'
import { useGraphDraftStore } from '../store'
import { storeEditSnapshot } from './editIntentStorage'
import { nextDraftDirty, type NextDraftEdit } from './state'
import type { useDraftEditorSave } from './useDraftEditorSave'
import type { useGraphEditIntent } from './useGraphEditIntent'

/** Registers the draft with the navigation guard: dirty/busy/uncertain state and explicit Save/Discard. */
export function useDraftUnsavedGuard({ draftKey, edit, editIntent, saveActions, pendingStart, starting, localError, start }: {
  draftKey: string
  edit: NextDraftEdit
  editIntent: ReturnType<typeof useGraphEditIntent>
  saveActions: ReturnType<typeof useDraftEditorSave>
  pendingStart: unknown
  starting: boolean
  localError: string | undefined
  start: () => Promise<unknown>
}) {
  const { reloading, stopAndSave, discardChanges } = saveActions
  useUnsavedChanges({ label: `${edit.graph.name} next draft`,
    canResume: () => {
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!current || current.busy || current.pending || reloading || starting || editIntent.mutation.isPending) return false
      try { storeEditSnapshot(draftKey, current); return true } catch { return false }
    },
    dirty: nextDraftDirty(edit) || edit.busy || !!pendingStart || editIntent.locked,
    busy: edit.busy || reloading || starting || editIntent.mutation.isPending, uncertain: edit.error?.uncertain || !!pendingStart || editIntent.intent?.state === 'uncertain',
    error: edit.error?.message ?? localError,
    // A generic navigation Save must not implicitly issue Stop. The board
    // exposes the explicit destructive action and the separate safe Discard.
    saveDisabled: !pendingStart && !edit.pending,
    save: () => pendingStart ? start() : edit.pending ? stopAndSave()
      : Promise.reject(new Error('Use “Save changes” on the board to review affected Runs, or Discard changes.')),
    discard: discardChanges }, (current, next) =>
    // The draft document stays mounted when authoring selection changes; dirty contextual forms
    // keep separate registrations for explicit Save/Discard and failed recovery.
    !staysOnWorkflowBoard({ ...current, search: { ...current.search, agentId: undefined } },
      { ...next, search: { ...next.search, agentId: undefined } }))
}
