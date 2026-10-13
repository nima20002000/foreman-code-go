import { useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocalHumanAccessQuery } from '../../../shared/api/settingsExperience'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import { canUseBoardAction } from '../../workflow-board/permissions'
import { boardRunListKey } from '../../workflow-board/keys'
import type { useWorkflowBoard } from '../../workflow-board/context'
import { boardStartPins, readBoardStartPreflight, sameBoardStartPins, currentBoardStartRequest, useBoardStartPreflight } from '../../workflow-board/startPreflight'
import { boardStartClient, type BoardStartInput } from '../../workflow-board/startClient'
import { acknowledgeBoardStart, readBoardStart, rejectBoardStart, reserveBoardStart, useBoardStartOutbox } from '../../workflow-board/startOutbox'
import { scopeForBoardRun } from '../../workflow-board/client'
import { recoverBoardStart } from '../../workflow-board/startRecovery'
import { useGraphDraftStore } from '../store'
import { nextDraftDirty, type NextDraftEdit } from './state'
import type { DraftEditorCore } from './useDraftEditorCore'
import type { useDraftEditorSave } from './useDraftEditorSave'
import type { useGraphEditIntent } from './useGraphEditIntent'

/** Start permission, saved-version preflight and the durable Start outbox. */
export function useDraftStartState({ draftKey, edit, board }: {
  draftKey: string
  edit: NextDraftEdit
  board: ReturnType<typeof useWorkflowBoard>
}) {
  const graph = edit.graph, context = edit.context
  const preflight = useBoardStartPreflight(context.draft, { enabled: board?.authoringActive !== false })
  const access = useLocalHumanAccessQuery()
  const principal = !access.isError ? access.data?.principal : undefined
  const canStart = !!principal && Date.parse(principal.expiresAt) > Date.now()
    && canUseBoardAction(principal.grants, 'runs:start', { workspaceId: graph.workspaceId, workflowId: graph.id })
  const startOutbox = useBoardStartOutbox(draftKey)
  const storageFailed = !!startOutbox.error
  const pendingStart = startOutbox.request
  return { preflight, canStart, startOutbox, storageFailed, pendingStart }
}
export type DraftStartState = ReturnType<typeof useDraftStartState>

/** Save-then-start (or reconcile the earlier Start) for the exact saved version. */
export function useDraftStartMutation({ draftKey, edit, editIntent, core, startState, stopAndSave }: {
  draftKey: string
  edit: NextDraftEdit
  editIntent: ReturnType<typeof useGraphEditIntent>
  core: DraftEditorCore
  startState: DraftStartState
  stopAndSave: ReturnType<typeof useDraftEditorSave>['stopAndSave']
}) {
  const graph = edit.graph
  const { alive, latestBoard, runAfterSave, setLocalError, setMessage, report } = core
  const { canStart, preflight } = startState
  const queryClient = useQueryClient()
  const startLock = useRef(false)
  const startMutation = useMutation({ retry: false, mutationFn: async (options?: { saveFirst?: boolean; allowStop?: boolean }) => {
    if (startLock.current) return
    const generation = sessionGeneration()
    let sent: BoardStartInput | undefined
    startLock.current = true; setLocalError(undefined)
    try {
      // Reconcile the original persisted command before considering current pins
      // or capabilities. A lost acknowledgement never becomes a second Start.
      if (!canStart) throw new Error('Start permission is unavailable for this exact workflow. No command was sent.')
      const existing = readBoardStart(draftKey)
      if (!existing && !useGraphDraftStore.getState().nextDrafts[draftKey]?.graph.nodes.length) {
        throw new Error('Add an agent before saving and running.')
      }
      let saved = false
      if (!existing && options?.saveFirst) {
        runAfterSave.current = true
        const result = await stopAndSave(options.allowStop)
        assertSession(generation)
        saved = result.intent?.state === 'saved'
        if (!saved || !alive.current) return
        runAfterSave.current = false
      }
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!current) throw new Error('The draft is no longer mounted.')
      let candidate = existing
      if (!candidate) {
        if (current.busy || current.pending || current.startCanceled || (!saved && editIntent.locked) || nextDraftDirty(current)
          || current.startRejectedVersionId === current.context.draft.baseWorkflowVersionId
          || (!saved && (preflight.isError || !preflight.data))) throw new Error('Save, reload or reconcile before creating a new Start.')
        const displayedPins = saved ? undefined : boardStartPins(current.context.draft, preflight.data!)
        const fresh = await readBoardStartPreflight(current.context.draft)
        assertSession(generation)
        if ((displayedPins && !sameBoardStartPins(displayedPins, boardStartPins(current.context.draft, fresh)))
          || useGraphDraftStore.getState().nextDrafts[draftKey] !== current) {
          throw new Error('The displayed Start pins or local form changed. Reload before starting a new Run.')
        }
        candidate = currentBoardStartRequest(current.context.draft, fresh, crypto.randomUUID())
      }
      sent = await reserveBoardStart(draftKey, candidate)
      const result = await boardStartClient.start(sent)
      assertSession(generation)
      const acknowledgement = await acknowledgeBoardStart(draftKey, sent)
      void queryClient.invalidateQueries({ queryKey: boardRunListKey(graph.workspaceId, graph.id) })
      if (!alive.current || useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId !== current.instanceId) return
      if (acknowledgement !== 'superseded') latestBoard.current?.selectRun(scopeForBoardRun(result.run))
      setMessage('Start acknowledged for the exact saved version. Run status is read separately.')
    } catch (error) {
      try {
        assertSession(generation)
        if (sent && await rejectBoardStart(draftKey, sent, error)) {
          const rejectedVersion = sent.workflowVersionId
          useGraphDraftStore.getState().updateNextDraft(draftKey, (current) => ({ ...current, startRejectedVersionId: rejectedVersion }))
          setLocalError('This saved version can no longer start. Reload the saved draft before starting another Run.')
        } else report(error)
      } catch (releaseError) { report(releaseError) }
      // Navigation guards must not treat failed/uncertain Start as a successful save.
      throw error
    } finally { startLock.current = false }
  } })
  const recovery = useMutation({ retry: false, mutationFn: async () => {
    if (startLock.current) return
    startLock.current = true
    try {
      if (!canStart) throw new Error('Start permission is unavailable for this workflow.')
      const request = readBoardStart(draftKey)
      if (!request) return
      const instanceId = useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId
      const { result, acknowledgement } = await recoverBoardStart(draftKey, request)
      void queryClient.invalidateQueries({ queryKey: boardRunListKey(graph.workspaceId, graph.id) })
      if (!alive.current || acknowledgement === 'superseded'
        || useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId !== instanceId) return
      if (result.status === 'accepted') {
        latestBoard.current?.selectRun(scopeForBoardRun(result.run))
        setMessage('The earlier Run was accepted.')
      } else {
        useGraphDraftStore.getState().updateNextDraft(draftKey, current => ({ ...current, startCanceled: true }))
        setMessage('The earlier Start was canceled. Reload the saved draft, then review and start again.')
      }
    } finally { startLock.current = false }
  } })
  const starting = startMutation.isPending || recovery.isPending
  const start = () => startMutation.mutateAsync()
  const recoverStart = () => recovery.mutateAsync()
  return { startMutation, starting, start, recoverStart }
}
