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
import { acknowledgeEditOutbox, editSnapshotAcknowledged, matchesEditIntent, readEditOutbox, readEditSubmission,
  rejectEditOutbox, reserveEditOutbox, storeEditSnapshot, withEditIntentLock, type EditIntentOutbox } from './editIntentStorage'

export const activeEditIntent = (intent: GraphEditIntent | null | undefined) => !!intent && !['saved', 'discarded'].includes(intent.state)
export const graphEditIntentKey = (workspaceId: string, workflowId: string, draftId: string, generation = sessionGeneration()) =>
  ['graph-edit-intent', generation, workspaceId, workflowId, draftId] as const
const readInput = (edit: NextDraftEdit) => ({ action: 'read_edits' as const, workspaceId: edit.context.draft.workspaceId,
  workflowId: edit.context.draft.workflowId, draftId: edit.context.draft.id })
const commandInput = (intent: GraphEditIntent) => ({ workspaceId: intent.workspaceId, workflowId: intent.workflowId,
  draftId: intent.draftId, intentId: intent.id })

/** Reconcile only authenticated terminal readback for this exact form base.
 * Persist consumption with the resulting form before exposing it to new typing;
 * the shared outbox is not a per-tab acknowledgement marker. */
export function acknowledgeEditIntentSnapshot(draftKey: string, current: NextDraftEdit, intent: GraphEditIntent): NextDraftEdit {
  const draft = current.context.draft
  if (current.busy || current.pending || !['saved', 'discarded'].includes(intent.state)
    || draft.workspaceId !== intent.workspaceId || draft.workflowId !== intent.workflowId || draft.id !== intent.draftId
    || draft.revision !== intent.expectedRevision || draft.baseWorkflowVersionId !== intent.expectedWorkflowVersionId
    || editSnapshotAcknowledged(draftKey, current, intent.stageCommandId)) return current
  const submission = readEditSubmission(draftKey, intent)
  // Without exact local evidence, a remote Discard says nothing about this form.
  if (intent.state === 'discarded' && !submission) return current
  let context = current.context
  if (intent.state === 'saved') {
    if (!intent.result) return current
    const catalog = new Map(context.agents.map((item) => [item.agent.id, item]))
    for (const item of intent.result.agents) catalog.set(item.agent.id, item)
    context = { draft: intent.result.draft, agents: [...catalog.values()] }
  }
  const graph = mergeAcknowledgement(current.graph, submission?.target ?? intent.stagedDraft.graph, context.draft.graph)
  const next = { ...current, context, graph,
    // Never substitute normalized server Agents for a lost local submission.
    agentEdits: acknowledgeAgentEdits(current.agentEdits, submission?.agentTarget, context,
      intent.state === 'discarded' ? graph : undefined),
    error: undefined, validation: undefined }
  storeEditSnapshot(draftKey, next, intent.stageCommandId)
  return next
}

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
    const ownOutbox = !!retained && matchesEditIntent(retained, intent)
    if (intent.state === 'saved' || intent.state === 'discarded') {
      useGraphDraftStore.getState().updateNextDraft(draftKey, (state) => acknowledgeEditIntentSnapshot(draftKey, state, intent))
      // Removing a shared reservation must not remove the submission evidence
      // needed by another tab that has not consumed this terminal readback yet.
      const acknowledged = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (acknowledged) storeEditSnapshot(draftKey, acknowledged)
      if (ownOutbox) acknowledgeEditOutbox(draftKey, intent.stageCommandId)
      setOutboxPending(!!readEditOutbox(draftKey))
      if (intent.state === 'saved') void queryClient.invalidateQueries({ queryKey: boardDraftContextKey(workspaceId, workflowId) })
    } else if (activeEditIntent(intent) && hydrated.current !== intent.id) {
      const submission = readEditSubmission(draftKey, intent)
      const submittedGraph = submission?.target ?? intent.stagedDraft.graph
      const submittedAgents = submission ? submission.agentTarget
        : Object.fromEntries(intent.stagedDraft.stagedAgents.map((item) => [item.agent.id, item.agent]))
      hydrated.current = intent.id
      // Fresh/reopened clean boards show the exact private payload. Never
      // overwrite another tab's/newer unsent form or replace its revision base.
      if (!hasLocalChanges(current.context, current.graph) && !hasAgentEdits(current)
        && current.context.draft.id === intent.draftId && current.context.draft.revision === intent.expectedRevision) {
        useGraphDraftStore.getState().updateNextDraft(draftKey, (state) => ({ ...state,
          graph: preserveWorkflowGeometry(submittedGraph, state.graph),
          agentEdits: submittedAgents,
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
    const stage = async (outbox: EditIntentOutbox) => {
      try { return await nextDraftApi.editStage(outbox.request) }
      catch (error) {
        assertSession(generation)
        if (rejectEditOutbox(draftKey, outbox.request, error)) {
          setOutboxPending(!!readEditOutbox(draftKey))
          void queryClient.invalidateQueries({ queryKey })
        }
        // No replacement command, automatic retry, or form discard on failure.
        throw error
      }
    }
    // Stage replay is read/receipt reconciliation, not Stop. Even Discard must
    // first settle an uncertain Stage reply; it never calls editAdvance.
    let data = retained ? await stage(retained)
      : await nextDraftApi.editRead(readInput(current))
    assertSession(generation)
    const beforeAcknowledgement = useGraphDraftStore.getState().nextDrafts[draftKey]
    accept(data)
    // A sibling tab may have finished this form while consuming the shared
    // outbox. Acknowledge that result, not a new Stage from the captured old base.
    if (data.intent && !activeEditIntent(data.intent)
      && useGraphDraftStore.getState().nextDrafts[draftKey] !== beforeAcknowledgement) return data
    if (action === 'advance' && !activeEditIntent(data.intent) && !retained) {
      if (!nextDraftDirty(current)) { accept(data); return data }
      const request = GraphEditStageInputSchema.parse({ ...readInput(current), action: 'stage_edits',
        commandId: crypto.randomUUID(), expectedRevision: current.context.draft.revision,
        expectedWorkflowVersionId: current.context.draft.baseWorkflowVersionId, executionSemanticsVersion: 2,
        operations: draftOperations(current.context, current.graph, current.agentEdits) })
      const reserved = reserveEditOutbox(draftKey, { request, target: current.graph,
        ...(current.agentEdits ? { agentTarget: current.agentEdits } : {}) })
      setOutboxPending(true)
      data = await stage(reserved)
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
