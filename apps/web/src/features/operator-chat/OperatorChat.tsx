import { useCallback, useEffect, useId, useRef, useState } from 'react'
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
import { chatStoragePrefix, identityEpoch } from '../../shared/api/protectedChatStorage'
import { approvalOptionScope } from '../../shared/ui/approvalOptionScope'
import { Alert, Badge, Button, EmptyState, Icon, IconButton, LoadingState, Select } from '../../shared/ui/nocturne'
import { isNarrowOperatorChat, operatorChatNarrowQuery, useOperatorChatStore } from './operatorChatStore'
import { useOperatorChatVisibility } from './useOperatorChatVisibility'
import { acknowledgeOperatorMessage, assertOperatorMessageReserved, readPendingOperatorMessage, reserveOperatorMessage } from './operatorOutbox'
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
  const reservations = useRef(new Set<string>())
  const [preparingId, setPreparingId] = useState<string>()
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
    mutationFn: ({ id, command, generation, epoch }: { id: string; command: SendOperatorMessageRequest; generation: number; epoch: string }) => {
      if (!currentSession(generation) || epoch !== identityEpoch()) throw new SessionChangedError()
      assertOperatorMessageReserved(id, command)
      return sendOperatorMessage(id, command)
    },
    onSuccess: async (result, input) => {
      if (!currentSession(input.generation) || input.epoch !== identityEpoch()) return
      try {
        const acknowledged = await acknowledgeOperatorMessage(input.id, input.command.requestId)
        if (!currentSession(input.generation) || input.epoch !== identityEpoch()) return
        if (acknowledged) clearDraft(input.id, input.command.content)
      } catch (error) {
        if (!currentSession(input.generation) || input.epoch !== identityEpoch()) return
        setPreparationError({ id: input.id, message: error instanceof Error ? error.message : 'The message receipt could not be saved.' })
      }
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
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(chatStoragePrefix)) refreshOutbox((value) => value + 1)
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])

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
  const archived = conversation?.conversation.status === 'archived'
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
  const submit = async (content: string) => {
    if (!selectedId || archived || active || accessDenied || pending.command || pending.error
      || reservations.current.has(selectedId) || (send.isPending && send.variables?.id === selectedId)) return
    const id = selectedId
    const generation = sessionGeneration()
    const epoch = identityEpoch()
    reservations.current.add(id); setPreparingId(id)
    try {
      const command = await reserveOperatorMessage(id, content, window.location.pathname + window.location.search)
      if (!currentSession(generation) || epoch !== identityEpoch()) return
      setPreparationError(undefined)
      send.mutate({ id, command, generation, epoch })
    } catch (error) {
      if (currentSession(generation) && epoch === identityEpoch()) setPreparationError({ id,
        message: error instanceof Error ? error.message : 'Message preparation failed.' })
    } finally {
      reservations.current.delete(id)
      setPreparingId((current) => current === id ? undefined : current)
      refreshOutbox((value) => value + 1)
    }
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
        <IconButton ref={historyTriggerRef} label={historyOpen ? 'Collapse history' : 'Open history'} variant="ghost"
          aria-expanded={historyOpen} aria-controls={historyOpen ? historyId : undefined} onClick={() => showHistory(!historyOpen)}><Icon name={historyOpen ? 'close' : 'menu'} /></IconButton>
        <div className="operator-chat-identity"><strong title={selectedTitle}>Operator · {selectedTitle}{attention.length ? <Badge tone="warning" className="operator-chat-attention">{attention.length} need a decision</Badge> : null}</strong>
          <Select label="Switch conversation" value={selectedId ?? ''} options={[
            { value: '', label: 'Choose a conversation', disabled: true },
            ...(selectedId && !entries.some((item) => item.conversationId === selectedId) ? [{ value: selectedId, label: selectedTitle }] : []),
            ...entries.map((item) => ({ value: item.conversationId, label: item.title?.trim() || 'Untitled conversation' })),
          ]} onChange={(event) => {
            if (!event.target.value) return
            select(event.target.value)
            if (isNarrowOperatorChat()) showHistory(false)
          }} />
        </div>
        <IconButton ref={closeRef} label="Close Operator chat" variant="ghost" onClick={close}><Icon name="close" /></IconButton>
      </header>
      {settingsWarning ? <Alert live tone="warning" title="Operator settings unavailable">{settingsWarning}</Alert> : null}
      {accessDenied ? <Alert live tone="danger" title="Operator access unavailable">Check your browser enrollment and permissions.</Alert> : null}
      {!accessDenied && list.isError ? <Alert live tone="warning" title="Conversation status could not be refreshed">Attention indicators may be stale.</Alert> : null}
      <div className={`operator-chat-body${historyOpen ? ' operator-chat-history-open' : ''}`}>
        {historyOpen ? <aside ref={historyRef} id={historyId} aria-label="Operator conversation history">
          <Button variant="primary" leading={<Icon name="plus" size={15} />} onClick={createConversation} disabled={create.isPending || accessDenied} loading={create.isPending}>New chat</Button>
          {list.isPending ? <LoadingState label="Loading conversation history…" rows={3} /> : null}
          {list.isError ? <Alert live tone="danger" title={list.data ? 'History refresh failed' : 'Conversation history could not be loaded'} action={<Button size="sm" disabled={list.isFetching} loading={list.isFetching} onClick={() => void list.refetch()}>Retry history</Button>}>{list.data ? 'Previously loaded conversations are still shown.' : 'Try the request again.'}</Alert> : null}
          {list.isSuccess && entries.length === 0 ? <EmptyState icon="history" title="No conversations yet. Start a new chat." description="The Operator will keep the conversation history here." /> : null}
          <nav>{entries.map((item) => <Button variant="ghost" aria-current={item.conversationId === selectedId ? 'page' : undefined}
            key={item.conversationId} onClick={() => {
              select(item.conversationId)
              if (isNarrowOperatorChat()) historyTriggerRef.current?.focus()
            }}><span>{item.title ?? 'Conversation'}</span><small className={item.needsAttention ? 'operator-chat-attention' : undefined}>{operatorNavigationStatus(item)}</small></Button>)}</nav>
        </aside> : null}
        <main className="operator-chat-main">
          {create.error instanceof Error ? <Alert live tone="danger" title="Conversation could not be created">{create.error.message}</Alert> : null}
          {!selectedId && !accessDenied ? <Button variant="primary" leading={<Icon name="plus" size={15} />} onClick={createConversation} disabled={create.isPending} loading={create.isPending}>Start a new conversation</Button> : null}
          {selected.isLoading ? <LoadingState label="Loading conversation…" rows={4} /> : null}
          {selected.isError ? <Alert live tone="danger" title={conversation ? 'Conversation refresh failed' : 'Conversation could not be loaded'} action={<Button size="sm" disabled={selected.isFetching} loading={selected.isFetching} onClick={() => void selected.refetch()}>Retry conversation</Button>}>{conversation ? 'Previously loaded messages are still shown.' : 'Try the request again.'}</Alert> : null}
          {conversation ? <>
            {archived ? <Alert tone="warning" title="Conversation ended">This conversation is read-only. Its history and pending receipt remain available.</Alert> : null}
            {conversation.messages.length === 0 && !active ? <p>No messages yet. Send a message to start this conversation.</p> : null}
            <OperatorTranscript key={conversation.conversation.id} messages={conversation.messages} partialText={partialText} />
            {conversation.pendingInteraction || conversation.error || pending.error || pending.command || sendError
              || (respondVariables?.id === selectedId && respond.error) || (cancelVariables?.id === selectedId && cancel.error) ? <div className="operator-chat-decision-area">
              {requestId && conversation.pendingInteraction ? <fieldset disabled={archived || (respond.isPending && respond.variables?.id === selectedId) || conversation.responseDelivery !== 'offered' || conversation.turnState === 'canceling'}>
                <legend>Operator permission request</legend>
                <ApprovalRequestSummary request={conversation.pendingInteraction.request} nativeRequestType={conversation.pendingInteraction.nativeRequestType} />
                <details><summary>Technical details</summary><pre className="operator-chat-approval-details">{JSON.stringify(conversation.pendingInteraction.request, null, 2)}</pre></details>
                {conversation.pendingInteraction.responseOptions.map((option) => <div key={option.optionId}>
                  <Button variant={option.semantic === 'reject' || option.semantic === 'cancel' ? 'danger' : 'secondary'} aria-describedby={`${panelId}-scope-${encodeURIComponent(option.optionId)}`} onClick={() => respond.mutate({ id: conversation.conversation.id, generation: sessionGeneration(),
                    input: { requestId, nativeRequestId: conversation.pendingInteraction!.turn.nativeRequestId!, optionId: option.optionId } })}>{option.label}</Button>
                  <p id={`${panelId}-scope-${encodeURIComponent(option.optionId)}`}>{approvalOptionScope(option)}{option.scopeSummary ? ` ${option.scopeSummary}` : ''}</p>
                </div>)}
                {conversation.responseDelivery !== 'offered' ? <Alert tone="warning" title="Response delivery is being reconciled">It will not be sent twice.</Alert> : null}
              </fieldset> : null}
              <div className="operator-chat-feedback">
                {conversation.error ? <Alert live tone="danger" title="Operator turn failed">{conversation.error}</Alert> : null}
                {respondVariables && respondVariables.id === selectedId && respondVariables.input.requestId === requestId && respond.error instanceof Error ? <Alert live tone="danger" title="Approval response failed">{respond.error.message}</Alert> : null}
                {cancelVariables && cancelVariables.id === selectedId && cancelVariables.requestId === requestId && cancel.error instanceof Error ? <Alert live tone="danger" title="Cancellation failed">{cancel.error.message}</Alert> : null}
                {pending.error ? <Alert live tone="danger" title="Pending message unavailable">{pending.error}</Alert> : null}
                {sendError ? <Alert live tone="danger" title="Message could not be sent">{sendError}</Alert> : null}
              </div>
              {pending.command ? <Button disabled={send.isPending && send.variables?.id === selectedId} loading={send.isPending && send.variables?.id === selectedId} onClick={() => {
                setPreparationError(undefined)
                send.mutate({ id: conversation.conversation.id, command: pending.command!, generation: sessionGeneration(), epoch: identityEpoch() })
              }}>Retry pending message</Button> : null}
            </div> : null}
            <footer className="operator-chat-controls">
              <div className="operator-chat-turn-actions">
                <p role="status">{operatorTurnStatus(conversation, connectionState)}</p>
                {requestId ? <Button className="operator-chat-cancel" variant="danger" size="sm" onClick={() => cancel.mutate({ id: conversation.conversation.id, requestId, generation: sessionGeneration() })}
                  disabled={conversation.turnState === 'canceling' || (cancel.isPending && cancel.variables?.id === selectedId)}>{conversation.turnState === 'canceling' ? 'Cancel requested' : 'Cancel turn'}</Button> : null}
              </div>
              <ConversationComposer conversationId={conversation.conversation.id} sendDisabled={archived || active || preparingId === selectedId || Boolean(pending.error) || Boolean(pending.command)}
                allowEditingWhileSending isSending={preparingId === selectedId || (send.isPending && send.variables?.id === selectedId)} onSubmit={submit} />
            </footer>
          </> : null}
        </main>
      </div>
    </section> : null}
    <IconButton ref={launcherRef} className="operator-chat-launcher" variant="primary" label={attention.length ? `Open Operator chat, ${attention.length} conversation${attention.length === 1 ? '' : 's'} need your decision` : 'Open Operator chat'} hidden={open}
      aria-expanded={open} aria-controls={open ? panelId : undefined} aria-haspopup="dialog"
      aria-description={settingsWarning ?? (list.isError ? 'Conversation status may be stale.' : undefined)}
      title={settingsWarning ?? (list.isError ? 'Conversation status may be stale' : 'Open Operator chat')}
      onClick={() => { if (attention[0]) select(attention[0].conversationId); setOpen(true) }}><Icon name="bot" />
      {attention.length ? <Badge tone="warning" className="operator-chat-badge" aria-hidden="true">{attention.length}</Badge> : null}
      {settingsWarning || list.isError ? <Badge tone="warning" className="operator-chat-connection-badge" aria-label="Connection warning">!</Badge> : null}
    </IconButton>
  </div>
}
