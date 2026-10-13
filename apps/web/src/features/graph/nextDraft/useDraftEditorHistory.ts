import { useEffect } from 'react'
import { useGraphDraftStore } from '../store'
import { announceBoardChange, describeDraftChange, pendingBoardAction, popBoardAction, popBoardRedo, pushDraftRedo } from '../../workflow-board/boardUndo'
import type { useWorkflowBoard } from '../../workflow-board/context'
import type { DraftEditorCore } from './useDraftEditorCore'
import type { useGraphEditIntent } from './useGraphEditIntent'

/** Undo/redo across draft steps and server-saved settings, plus the Ctrl/Cmd+Z/Y shortcuts. */
export function useDraftEditorHistory({ draftKey, undoScope, board, editIntent, core, saveBusy, starting }: {
  draftKey: string
  undoScope: string
  board: ReturnType<typeof useWorkflowBoard>
  editIntent: ReturnType<typeof useGraphEditIntent>
  core: DraftEditorCore
  saveBusy: boolean
  starting: boolean
}) {
  const { prepare, canvas, layout, report } = core
  const historyAction = (direction: 'undo' | 'redo') => {
    if (saveBusy || starting || editIntent.locked || board?.run) return
    void prepare(async () => {
      canvas.current?.flush()
      const store = useGraphDraftStore.getState()
      const current = store.nextDrafts[draftKey]
      if (!current) return
      // Settings saved straight to the server (schedule) interleave with draft steps in the order they happened.
      if (direction === 'undo') {
        const action = pendingBoardAction(undoScope, current.history.length + (current.historyOffset ?? 0))
        if (action) {
          await action.undo()
          popBoardAction(undoScope, action)
          announceBoardChange(undoScope, `Undid ${action.label}`)
          return
        }
        const previous = current.history.at(-1)
        if (!previous) return
        store.undoNextDraft(draftKey)
        pushDraftRedo(undoScope)
        announceBoardChange(undoScope, `Undid ${describeDraftChange(previous, current.graph)}`)
      } else {
        const next = popBoardRedo(undoScope)
        if (next?.kind === 'action') {
          await next.action.redo()
          announceBoardChange(undoScope, `Redid ${next.action.label}`)
          return
        }
        const target = current.future?.at(-1)
        if (!target) return
        store.redoNextDraft(draftKey)
        announceBoardChange(undoScope, `Redid ${describeDraftChange(current.graph, target.graph)}`)
      }
      layout.mutate()
    }).catch(report)
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.defaultPrevented) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], dialog')) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      if (saveBusy || starting || editIntent.locked || board?.run) return
      event.preventDefault()
      historyAction(key === 'y' || event.shiftKey ? 'redo' : 'undo')
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  })
  return historyAction
}
