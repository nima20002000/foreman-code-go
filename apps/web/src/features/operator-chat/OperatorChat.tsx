import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { MessageCircle, PanelLeftClose, PanelLeftOpen, Plus, X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OperatorConversationState, OperatorConversationSummary, SendOperatorMessageRequest, RespondOperatorInteractionRequest } from '@graphql/contracts'

import { ConversationComposer, useConversationDraftStore } from '../conversations'
import { ApprovalRequestSummary } from '../approvals/ApprovalRequestSummary'
import { cancelOperatorTurn, createOperatorConversation, getOperatorConversation,
  sendOperatorMessage, respondOperatorInteraction } from '../../shared/api/client'
import { listOperatorConversationSummaries } from '../../shared/api/operatorChatSummaries'
import { subscribeOperatorChat, type OperatorChatConnection } from '../../shared/api/operatorChatStream'
import { useAccessFailureLatch } from '../../shared/api/useAccessFailureLatch'
import { sessionGeneration, sessionIsSwitching, SessionChangedError } from '../../shared/api/sessionBoundary'
import { approvalOptionScope } from '../../shared/ui/approvalOptionScope'
import { isNarrowOperatorChat, operatorChatNarrowQuery, useOperatorChatStore } from './operatorChatStore'
import { useOperatorChatVisibility } from './useOperatorChatVisibility'
import { acknowledgeOperatorMessage, readPendingOperatorMessage, reserveOperatorMessage } from './operatorOutbox'
import { projectOperatorText, type OperatorTextProjection } from './operatorTextProjection'
import { newerOperatorSummaries, operatorNavigationStatus, operatorTurnStatus, summarizeOperatorConversation } from './operatorChatStatus'
import { OperatorTranscript } from './OperatorTranscript'
import './operatorChat.css'

const listKey = ['operator-chat', 'summaries'] as const
const detailKey = (id: string) => ['operator-chat', 'conversation', id] as const
type Summaries = Awaited<ReturnType<typeof listOperatorConversationSummaries>>
function newer(current: OperatorConversationState | undefined, next: OperatorConversationState): OperatorConversationState {
  return current && current.revision > next.revision ? current : next
}
function currentSession(generation: number): boolean {
  return !sessionIsSwitching() && sessionGeneration() === generation
}

export function OperatorChat({ settingsWarning }: { settingsWarning?: string } = {}) {
  const enabled = useOperatorChatVisibility()
  const queryClient = useQueryClient()
  const open = useOperatorChatStore((state) => state.open)
  const historyOpen = useOperatorChatStore((state) => state.historyOpen)
  const selectedId = useOperatorChatStore((state) => state.selectedConversationId)
  const setOpen = useOperatorChatStore((state) => state.setOpen)
  const setHistoryOpen = useOperatorChatStore((state) => state.setHistoryOpen)
  const select = useOperatorChatStore((state) => state.select)
  const clearDraft = useConversationDraftStore((state) => state.clearDraft)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const historyTriggerRef = useRef<HTMLButtonElement>(null)
  const historyRef = useRef<HTMLElement>(null)
  const panelId = useId()
  const historyId = useId()
  // Presentation-only fragments. Query/PostgreSQL still own all finalized state.
  const [partial, setPartial] = useState<{ conversationId: string; value?: OperatorTextProjection }>()
  const [preparationError, setPreparationError] = useState<{ id: string; message: string }>()
  const [connection, setConnection] = useState<{ id: string; state: OperatorChatConnection }>()
  const [, refreshOutbox] = useState(0)
  const list = useQuery({ queryKey: listKey, enabled, refetchInterval: 5_000,
    queryFn: async ({ signal }) => {
      const next = await listOperatorConversationSummaries({ signal })
      const current = queryClient.getQueryData<Summaries>(listKey)
      const conversations = newerOperatorSummaries(current?.conversations, next.conversations).map((item) => {
        const detail = queryClient.getQueryData<OperatorConversationState>(detailKey(item.conversationId))
        return detail && detail.revision > item.revision ? summarizeOperatorConversation(detail) : item
      })
      return { conversations }
    } })
  const listDenied = useAccessFailureLatch(list)
  const selected = useQuery({ queryKey: detailKey(selectedId ?? ''), enabled: enabled && open && !listDenied && Boolean(selectedId),
    queryFn: async ({ signal }) => {
      const state = await getOperatorConversation(selectedId ?? '', { signal })
      return newer(queryClient.getQueryData<OperatorConversationState>(detailKey(selectedId ?? '')), state)
    }, refetchInterval: 3_000 })
  const selectedDenied = useAccessFailureLatch(selected)
  const accessDenied = listDenied || selectedDenied
  const acceptState = useCallback((id: string, state: OperatorConversationState) => {
    const accepted = newer(queryClient.getQueryData<OperatorConversationState>(detailKey(id)), state)
    queryClient.setQueryData(detailKey(id), accepted)
    const summary = summarizeOperatorConversation(accepted)
    queryClient.setQueryData<Summaries>(listKey, (current) => current ? {
      conversations: current.conversations.some((item) => item.conversationId === id)
        ? current.conversations.map((item) => item.conversationId === id && summary.revision >= item.revision ? summary : item)
        : [summary, ...current.conversations],
    } : current)
  }, [queryClient])
  const invalidate = async (id: string) => { await Promise.all([
    queryClient.invalidateQueries({ queryKey: detailKey(id) }), queryClient.invalidateQueries({ queryKey: listKey }),
  ]) }
  const create = useMutation({ mutationFn: (input: { generation: number }) => {
    if (!currentSession(input.generation)) throw new SessionChangedError()
    return createOperatorConversation()
  },
    onSuccess: async ({ conversation }, input) => {
      if (!currentSession(input.generation)) return
      select(conversation.id)
      if (isNarrowOperatorChat()) historyTriggerRef.current?.focus()
      await queryClient.invalidateQueries({ queryKey: listKey })
    } })
  const send = useMutation({
    mutationFn: ({ id, command }: { id: string; command: SendOperatorMessageRequest; generation: number }) => sendOperatorMessage(id, command),
    onSuccess: async (result, input) => {
      if (!currentSession(input.generation)) return
      acknowledgeOperatorMessage(input.id, input.command.requestId)
      clearDraft(input.id, input.command.content)
      refreshOutbox((value) => value + 1)
      acceptState(input.id, result.state)
      await invalidate(input.id)
    },
    // A later 4xx cannot prove an earlier lost delivery was not accepted.
    // Keep the same durable request identity until a successful receipt is read.
  })
  const cancel = useMutation({ mutationFn: ({ id, requestId }: { id: string; requestId: string; generation: number }) => cancelOperatorTurn(id, requestId),
    onSuccess: async (result, input) => {
      if (!currentSession(input.generation)) return
      acceptState(input.id, result.state); await invalidate(input.id)
    } })
  const respond = useMutation({ mutationFn: ({ id, input }: { id: string; input: RespondOperatorInteractionRequest; generation: number }) => respondOperatorInteraction(id, input),
    onSuccess: async (result, variables) => {
      if (!currentSession(variables.generation)) return
      acceptState(variables.id, result.state); await invalidate(variables.id)
    } })

  useEffect(() => {
    if (enabled && open) closeRef.current?.focus()
  }, [enabled, open])
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(operatorChatNarrowQuery)
    const change = () => { if (media.matches) setHistoryOpen(false) }
    change()
    media.addEventListener?.('change', change)
    return () => media.removeEventListener?.('change', change)
  }, [setHistoryOpen])
  useEffect(() => {
    if (!enabled || !open || !selectedId || accessDenied) return
    const refresh = () => { void queryClient.invalidateQueries({ queryKey: detailKey(selectedId) }); void queryClient.invalidateQueries({ queryKey: listKey }) }
    return subscribeOperatorChat(selectedId, {
      snapshot: (state) => acceptState(selectedId, state),
      reconnect: refresh,
      connection: (state) => setConnection((current) => current?.id === selectedId && current.state === state ? current : { id: selectedId, state }),
      event: (event) => {
        const state = queryClient.getQueryData<OperatorConversationState>(detailKey(selectedId))
        if (event.type === 'delta') {
          setPartial((current) => ({ conversationId: selectedId,
            value: projectOperatorText(current?.conversationId === selectedId ? current.value : undefined, state?.activeRequestId ?? null, event.data) }))
        } else {
          if (event.type === 'state' && typeof event.data.activeRequestId === 'string'
            && typeof event.data.revision === 'number' && Number.isSafeInteger(event.data.revision)
            && ['active', 'canceling'].includes(String(event.data.turnState))) {
            const { activeRequestId, revision, turnState } = event.data
            queryClient.setQueryData<OperatorConversationState>(detailKey(selectedId), (current) => current
              && revision >= current.revision ? { ...current, revision, activeRequestId,
                turnState: turnState as 'active' | 'canceling' } : current)
          }
          if (event.type === 'message' || (event.type === 'state' && ['idle', 'error'].includes(String(event.data.turnState)))) {
            setPartial((current) => current?.conversationId === selectedId && current.value?.requestId === event.data.requestId ? undefined : current)
          }
          refresh()
        }
      },
    })
  }, [acceptState, accessDenied, enabled, open, queryClient, selectedId])

  if (!enabled || sessionIsSwitching()) return null
  const conversation = accessDenied ? undefined : selected.data
  const active = Boolean(conversation && (conversation.activeRequestId || !['idle', 'error'].includes(conversation.turnState)))
  const requestId = conversation?.activeRequestId
  const pending = selectedId && !accessDenied ? readPendingOperatorMessage(selectedId) : {}
  const scopedSendError = send.variables?.id === selectedId && send.error instanceof Error ? send.error.message : undefined
  const sendError = preparationError && preparationError.id === selectedId ? preparationError.message : scopedSendError
  const partialText = partial?.value && partial.conversationId === selectedId && partial.value.requestId === requestId
    ? Object.values(partial.value.parts).join('\n\n') : ''
  const entries: OperatorConversationSummary[] = accessDenied ? [] : (list.data?.conversations ?? []).map((item) =>
    conversation?.conversation.id === item.conversationId && conversation.revision >= item.revision ? summarizeOperatorConversation(conversation) : item)
  const selectedTitle = conversation?.conversation.title?.trim()
    || entries.find((item) => item.conversationId === selectedId)?.title?.trim()
    || (selectedId ? 'Untitled conversation' : 'New conversation')
  const attention = entries.filter((item) => item.needsAttention)
  const liveConnection = connection && connection.id === selectedId ? connection.state : 'connecting'
  const connectionState = selected.isError || selected.failureCount > 0
    ? 'reconnecting' : liveConnection
  const respondVariables = respond.variables
  const cancelVariables = cancel.variables
  const close = () => {
    setOpen(false)
    window.requestAnimationFrame(() => launcherRef.current?.focus())
  }
  const showHistory = (next: boolean) => {
    setHistoryOpen(next)
    window.requestAnimationFrame(() => {
      if (next) historyRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      else historyTriggerRef.current?.focus()
    })
  }
  const createConversation = () => create.mutate({ generation: sessionGeneration() })
  const submit = (content: string) => {
    if (!selectedId || active || accessDenied || pending.command || pending.error || (send.isPending && send.variables?.id === selectedId)) return
    try {
      const command = reserveOperatorMessage(selectedId, content, window.location.pathname + window.location.search)
      setPreparationError(undefined)
      send.mutate({ id: selectedId, command, generation: sessionGeneration() })
    } catch (error) { setPreparationError({ id: selectedId, message: error instanceof Error ? error.message : 'Message preparation failed.' }) }
  }
  return <div className="operator-chat-root">
    {open ? <section id={panelId} className="operator-chat" role="dialog" aria-modal={false} aria-label="Operator chat"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault(); event.stopPropagation()
        if (historyOpen && isNarrowOperatorChat()) showHistory(false)
        else close()
      }}>
      <header>
        <button ref={historyTriggerRef} type="button" aria-label={historyOpen ? 'Collapse history' : 'Open history'}
          aria-expanded={historyOpen} aria-controls={historyOpen ? historyId : undefined} onClick={() => showHistory(!historyOpen)}>{historyOpen ? <PanelLeftClose /> : <PanelLeftOpen />}</button>
        <div className="operator-chat-identity"><strong title={selectedTitle}>Operator · {selectedTitle}{attention.length ? <span className="operator-chat-attention">{attention.length} need a decision</span> : null}</strong>
          <select aria-label="Switch conversation" value={selectedId ?? ''} onChange={(event) => {
            if (!event.target.value) return
            select(event.target.value)
            if (isNarrowOperatorChat()) showHistory(false)
          }}>
            <option value="" disabled>Choose a conversation</option>
            {selectedId && !entries.some((item) => item.conversationId === selectedId) ? <option value={selectedId}>{selectedTitle}</option> : null}
            {entries.map((item) => <option key={item.conversationId} value={item.conversationId}>{item.title?.trim() || 'Untitled conversation'}</option>)}
          </select>
        </div>
        <button ref={closeRef} type="button" aria-label="Close Operator chat" onClick={close}><X /></button>
      </header>
      {settingsWarning ? <p className="operator-chat-warning" role="status">{settingsWarning}</p> : null}
      {accessDenied ? <p className="operator-chat-warning" role="alert">Operator access is unavailable. Check your browser enrollment and permissions.</p> : null}
      {!accessDenied && list.isError ? <p className="operator-chat-warning" role="status">Conversation status could not be refreshed. Attention indicators may be stale.</p> : null}
      <div className={`operator-chat-body${historyOpen ? ' operator-chat-history-open' : ''}`}>
        {historyOpen ? <aside ref={historyRef} id={historyId} aria-label="Operator conversation history">
          <button type="button" onClick={createConversation} disabled={create.isPending || accessDenied}><Plus /> New chat</button>
          {list.isPending ? <p role="status">Loading conversation history…</p> : null}
          {list.isError ? <div role="alert"><p>{list.data ? 'History refresh failed. Previously loaded conversations are still shown.' : 'Conversation history could not be loaded.'}</p><button type="button" disabled={list.isFetching} onClick={() => void list.refetch()}>Retry history</button></div> : null}
          {list.isSuccess && entries.length === 0 ? <p>No conversations yet. Start a new chat.</p> : null}
          <nav>{entries.map((item) => <button type="button" aria-current={item.conversationId === selectedId ? 'page' : undefined}
            key={item.conversationId} onClick={() => {
              select(item.conversationId)
              if (isNarrowOperatorChat()) historyTriggerRef.current?.focus()
            }}><span>{item.title ?? 'Conversation'}</span><small className={item.needsAttention ? 'operator-chat-attention' : undefined}>{operatorNavigationStatus(item)}</small></button>)}</nav>
        </aside> : null}
        <main className="operator-chat-main">
          {create.error instanceof Error ? <p className="operator-chat-feedback" role="alert">Conversation could not be created: {create.error.message}</p> : null}
          {!selectedId && !accessDenied ? <button type="button" onClick={createConversation} disabled={create.isPending}>Start a new conversation</button> : null}
          {selected.isLoading ? <p role="status">Loading conversation…</p> : null}
          {selected.isError ? <div className="operator-chat-feedback" role="alert"><p>{conversation ? 'Conversation refresh failed. Previously loaded messages are still shown.' : 'Conversation could not be loaded.'}</p><button type="button" disabled={selected.isFetching} onClick={() => void selected.refetch()}>Retry conversation</button></div> : null}
          {conversation ? <>
            {conversation.messages.length === 0 && !active ? <p>No messages yet. Send a message to start this conversation.</p> : null}
            <OperatorTranscript key={conversation.conversation.id} messages={conversation.messages} partialText={partialText} />
            {conversation.pendingInteraction || conversation.error || pending.error || pending.command || sendError
              || (respondVariables?.id === selectedId && respond.error) || (cancelVariables?.id === selectedId && cancel.error) ? <div className="operator-chat-decision-area">
              {requestId && conversation.pendingInteraction ? <fieldset disabled={(respond.isPending && respond.variables?.id === selectedId) || conversation.responseDelivery !== 'offered' || conversation.turnState === 'canceling'}>
                <legend>Operator permission request</legend>
                <ApprovalRequestSummary request={conversation.pendingInteraction.request} nativeRequestType={conversation.pendingInteraction.nativeRequestType} />
                <details><summary>Technical details</summary><pre className="operator-chat-approval-details">{JSON.stringify(conversation.pendingInteraction.request, null, 2)}</pre></details>
                {conversation.pendingInteraction.responseOptions.map((option) => <div key={option.optionId}>
                  <button type="button" aria-describedby={`${panelId}-scope-${encodeURIComponent(option.optionId)}`} onClick={() => respond.mutate({ id: conversation.conversation.id, generation: sessionGeneration(),
                    input: { requestId, nativeRequestId: conversation.pendingInteraction!.turn.nativeRequestId!, optionId: option.optionId } })}>{option.label}</button>
                  <p id={`${panelId}-scope-${encodeURIComponent(option.optionId)}`}>{approvalOptionScope(option)}{option.scopeSummary ? ` ${option.scopeSummary}` : ''}</p>
                </div>)}
                {conversation.responseDelivery !== 'offered' ? <p>Response delivery is being reconciled. It will not be sent twice.</p> : null}
              </fieldset> : null}
              <div className="operator-chat-feedback">
                {conversation.error ? <p role="alert">{conversation.error}</p> : null}
                {respondVariables && respondVariables.id === selectedId && respondVariables.input.requestId === requestId && respond.error instanceof Error ? <p role="alert">Approval response failed: {respond.error.message}</p> : null}
                {cancelVariables && cancelVariables.id === selectedId && cancelVariables.requestId === requestId && cancel.error instanceof Error ? <p role="alert">Cancellation failed: {cancel.error.message}</p> : null}
                {pending.error ? <p role="alert">{pending.error}</p> : null}
                {sendError ? <p role="alert">Message could not be sent: {sendError}</p> : null}
              </div>
              {pending.command ? <button type="button" disabled={send.isPending && send.variables?.id === selectedId} onClick={() => {
                setPreparationError(undefined)
                send.mutate({ id: conversation.conversation.id, command: pending.command!, generation: sessionGeneration() })
              }}>Retry pending message</button> : null}
            </div> : null}
            <footer className="operator-chat-controls">
              <div className="operator-chat-turn-actions">
                <p role="status">{operatorTurnStatus(conversation, connectionState)}</p>
                {requestId ? <button className="operator-chat-cancel" type="button" onClick={() => cancel.mutate({ id: conversation.conversation.id, requestId, generation: sessionGeneration() })}
                  disabled={conversation.turnState === 'canceling' || (cancel.isPending && cancel.variables?.id === selectedId)}>{conversation.turnState === 'canceling' ? 'Cancel requested' : 'Cancel turn'}</button> : null}
              </div>
              <ConversationComposer conversationId={conversation.conversation.id} sendDisabled={active || Boolean(pending.error) || Boolean(pending.command)}
                allowEditingWhileSending isSending={send.isPending && send.variables?.id === selectedId} onSubmit={submit} />
            </footer>
          </> : null}
        </main>
      </div>
    </section> : null}
    <button ref={launcherRef} className="operator-chat-launcher" type="button" hidden={open}
      aria-label={attention.length ? `Open Operator chat, ${attention.length} conversation${attention.length === 1 ? '' : 's'} need your decision` : 'Open Operator chat'}
      aria-expanded={open} aria-controls={open ? panelId : undefined} aria-haspopup="dialog"
      aria-description={settingsWarning ?? (list.isError ? 'Conversation status may be stale.' : undefined)}
      title={settingsWarning ?? (list.isError ? 'Conversation status may be stale' : 'Open Operator chat')}
      onClick={() => { if (attention[0]) select(attention[0].conversationId); setOpen(true) }}><MessageCircle />
      {attention.length ? <span className="operator-chat-badge" aria-hidden="true">{attention.length}</span> : null}
      {settingsWarning || list.isError ? <span className="operator-chat-connection-badge" aria-label="Connection warning">!</span> : null}
    </button>
  </div>
}
