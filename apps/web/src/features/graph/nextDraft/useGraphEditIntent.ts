import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GraphEditStageInputSchema, preserveWorkflowGeometry, sameExecutableWorkflow,
  type GraphEditIntent, type GraphEditReadResult } from '@graphql/contracts/wave25'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import { useGraphDraftStore } from '../store'
import { boardDraftContextKey } from '../../workflow-board/keys'
import { acknowledgeAgentEdits, hasAgentEdits } from './agentEdits'
import { draftOperations, hasLocalChanges, mergeAcknowledgement } from './model'
import { nextDraftDirty, type NextDraftEdit } from './state'
import { nextDraftApi } from './transport'
import { acknowledgeEditOutbox, readEditOutbox, reserveEditOutbox, storeEditSnapshot, withEditIntentLock } from './editIntentStorage'

export const activeEditIntent = (intent: GraphEditIntent | null | undefined) => !!intent && !['saved', 'discarded'].includes(intent.state)
export const graphEditIntentKey = (workspaceId: string, workflowId: string, draftId: string, generation = sessionGeneration()) =>
  ['graph-edit-intent', generation, workspaceId, workflowId, draftId] as const
const readInput = (edit: NextDraftEdit) => ({ action: 'read_edits' as const, workspaceId: edit.context.draft.workspaceId,
  workflowId: edit.context.draft.workflowId, draftId: edit.context.draft.id })
const commandInput = (intent: GraphEditIntent) => ({ workspaceId: intent.workspaceId, workflowId: intent.workflowId,
  draftId: intent.draftId, intentId: intent.id })

/** Server plans/facts and request lifecycle are Query-owned. Only the local
 * form and its pinned authoring base live in Zustand; storage is an outbox,
 * never an authentication, Run-state or publication authority. */
export function useGraphEditIntent(draftKey: string, edit: NextDraftEdit) {
  const queryClient = useQueryClient()
  const [storageError, setStorageError] = useState<string>()
  const [outboxPending, setOutboxPending] = useState(false)
  const { workspaceId, workflowId, id: draftId } = edit.context.draft
  const generation = sessionGeneration()
  const queryKey = useMemo(() => graphEditIntentKey(workspaceId, workflowId, draftId, generation), [workspaceId, workflowId, draftId, generation])
  const hydrated = useRef<string | undefined>(undefined)
  const automaticAttempt = useRef<string | undefined>(undefined)
  const query = useQuery({ queryKey,
    queryFn: ({ signal }) => nextDraftApi.editRead({ action: 'read_edits', workspaceId, workflowId, draftId }, { signal }),
    retry: false,
    refetchInterval: (state) => activeEditIntent(state.state.data?.intent) ? 1000 : false,
  })
  useEffect(() => {
    const persist = () => {
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!current) return
      try {
        storeEditSnapshot(draftKey, current)
        setOutboxPending(!!readEditOutbox(draftKey)); setStorageError(undefined)
      } catch (error) {
        setStorageError(error instanceof Error ? `Edits remain in this tab. ${error.message}` : 'The current form is not durably stored.')
      }
    }
    persist()
    const unsubscribe = useGraphDraftStore.subscribe((state, previous) => {
      if (state.nextDrafts[draftKey] !== previous.nextDrafts[draftKey]) persist()
    })
    const changed = () => {
      try { setOutboxPending(!!readEditOutbox(draftKey)) } catch (error) { setStorageError(String(error)) }
      void queryClient.invalidateQueries({ queryKey })
    }
    window.addEventListener('storage', changed)
    return () => { unsubscribe(); window.removeEventListener('storage', changed) }
  }, [draftKey, queryClient, queryKey])

  const accept = useCallback((data: GraphEditReadResult) => {
    queryClient.setQueryData(queryKey, data)
    const intent = data.intent
    if (!intent) return
    const current = useGraphDraftStore.getState().nextDrafts[draftKey]
    if (!current || current.busy || current.pending) return
    const retained = readEditOutbox(draftKey)
    const ownOutbox = retained?.request.commandId === intent.stageCommandId
    if (intent.state === 'saved' && intent.result) {
      const result = intent.result
      if (current.context.draft.id === intent.draftId && current.context.draft.revision === intent.expectedRevision) {
        useGraphDraftStore.getState().updateNextDraft(draftKey, (state) => {
          const catalog = new Map(state.context.agents.map((item) => [item.agent.id, item]))
          for (const item of result.agents) catalog.set(item.agent.id, item)
          const context = { draft: result.draft, agents: [...catalog.values()] }
          return { ...state, context, graph: mergeAcknowledgement(state.graph, intent.stagedDraft.graph, result.draft.graph),
            agentEdits: acknowledgeAgentEdits(state.agentEdits,
              Object.fromEntries(intent.stagedDraft.stagedAgents.map((item) => [item.agent.id, item.agent])), context),
            error: undefined, validation: undefined }
        })
      }
      // Persist the acknowledged form before clearing the sole uncertain Stage
      // identity. An interrupted local acknowledgement simply replays readback.
      const acknowledged = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (acknowledged) storeEditSnapshot(draftKey, acknowledged)
      if (ownOutbox) acknowledgeEditOutbox(draftKey, intent.stageCommandId)
      setOutboxPending(!!readEditOutbox(draftKey))
      void queryClient.invalidateQueries({ queryKey: boardDraftContextKey(workspaceId, workflowId) })
    } else if (intent.state === 'discarded' && ownOutbox) {
      // Recover a lost Discard reply without discarding independently newer edits.
      useGraphDraftStore.getState().updateNextDraft(draftKey, (state) => ({ ...state,
        graph: mergeAcknowledgement(state.graph, intent.stagedDraft.graph, state.context.draft.graph),
        agentEdits: acknowledgeAgentEdits(state.agentEdits,
          Object.fromEntries(intent.stagedDraft.stagedAgents.map((item) => [item.agent.id, item.agent])), state.context),
      }))
      storeEditSnapshot(draftKey, useGraphDraftStore.getState().nextDrafts[draftKey]!)
      acknowledgeEditOutbox(draftKey, intent.stageCommandId); setOutboxPending(false)
    } else if (activeEditIntent(intent) && hydrated.current !== intent.id) {
      hydrated.current = intent.id
      // Fresh/reopened clean boards show the exact private payload. Never
      // overwrite another tab's/newer unsent form or replace its revision base.
      if (!hasLocalChanges(current.context, current.graph) && !hasAgentEdits(current)
        && current.context.draft.id === intent.draftId && current.context.draft.revision === intent.expectedRevision) {
        useGraphDraftStore.getState().updateNextDraft(draftKey, (state) => ({ ...state,
          graph: preserveWorkflowGeometry(intent.stagedDraft.graph, state.graph),
          agentEdits: Object.fromEntries(intent.stagedDraft.stagedAgents.map((item) => [item.agent.id, item.agent])),
        }))
      }
    }
  }, [draftKey, queryClient, queryKey, workspaceId, workflowId])
  // Reconcile persisted results after refresh, independently of the HTTP reply
  // that first caused them. The query itself performs no Stop or publication.
  const seen = useRef<GraphEditReadResult | undefined>(undefined)
  useEffect(() => {
    if (!query.data || seen.current === query.data) return
    seen.current = query.data
    try { accept(query.data) } catch (error) { setStorageError(String(error)) }
  }, [accept, query.data])

  const mutation = useMutation({ mutationFn: async (action: 'advance' | 'discard') => withEditIntentLock(draftKey, async () => {
    const generation = sessionGeneration()
    const current = useGraphDraftStore.getState().nextDrafts[draftKey]
    if (!current || current.busy || current.pending || useGraphDraftStore.getState().pendingRunStarts[draftKey]) {
      throw new Error('Reconcile the earlier draft or Start command first. No replacement command was sent.')
    }
    storeEditSnapshot(draftKey, current)
    const retained = readEditOutbox(draftKey)
    // Stage replay is read/receipt reconciliation, not Stop. Even Discard must
    // first settle an uncertain Stage reply; it never calls editAdvance.
    let data = retained ? await nextDraftApi.editStage(retained.request)
      : await nextDraftApi.editRead(readInput(current))
    assertSession(generation)
    if (action === 'advance' && !activeEditIntent(data.intent) && !retained) {
      if (!nextDraftDirty(current)) { accept(data); return data }
      const request = GraphEditStageInputSchema.parse({ ...readInput(current), action: 'stage_edits',
        commandId: crypto.randomUUID(), expectedRevision: current.context.draft.revision,
        expectedWorkflowVersionId: current.context.draft.baseWorkflowVersionId, executionSemanticsVersion: 2,
        operations: draftOperations(current.context, current.graph, current.agentEdits) })
      const reserved = reserveEditOutbox(draftKey, { request, target: current.graph,
        ...(current.agentEdits ? { agentTarget: current.agentEdits } : {}) })
      setOutboxPending(true)
      data = await nextDraftApi.editStage(reserved.request)
      assertSession(generation)
    }
    accept(data)
    const intent = data.intent
    if (intent && activeEditIntent(intent)) {
      if (action === 'advance') {
        if (data.affectedSetChanged) throw new Error('The affected Run set changed. Retained commands will not Stop any newly discovered Run.')
        if (!data.canStop) throw new Error('Stop permission is missing for one or more affected Runs. The exact staged edits remain retained.')
        data = await nextDraftApi.editAdvance({ ...commandInput(intent), action: 'stop_and_save', commandId: intent.advanceCommandId })
      } else data = await nextDraftApi.editDiscard({ ...commandInput(intent), action: 'discard_edits', commandId: intent.discardCommandId })
      assertSession(generation); accept(data)
    }
    return data
  }), retry: false })

  const { mutate, isPending } = mutation
  useEffect(() => {
    const data = query.data, intent = data?.intent
    if (!intent || isPending || data.affectedSetChanged || storageError) return
    // Only finish an already explicitly initiated intent when authoritative
    // readback says every obligation settled. Staged/blocked/uncertain intents
    // need an explicit click; no Start is ever issued here.
    if (!['waiting', 'stopping', 'saving'].includes(intent.state) || !data.current.every((item) => item.settled)) return
    const attempt = `${intent.id}:${intent.state}:${intent.updatedAt}`
    if (automaticAttempt.current === attempt) return
    automaticAttempt.current = attempt
    mutate('advance')
  }, [query.data, isPending, storageError, mutate])
  const intent = query.data?.intent
  const locked = activeEditIntent(intent) || outboxPending || mutation.isPending
  return { query, mutation, intent, locked, storageError, outboxPending,
    sameDisplayedPayload: !intent || sameExecutableWorkflow(edit.graph, intent.stagedDraft.graph),
    advance: () => mutation.mutateAsync('advance'),
    discard: () => mutation.mutateAsync('discard'),
  }
}
