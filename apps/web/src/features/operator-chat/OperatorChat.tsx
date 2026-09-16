import { useEffect, useState } from 'react'
import { MessageCircle, PanelLeftClose, PanelLeftOpen, Plus, X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OperatorConversationState, SendOperatorMessageRequest, RespondOperatorInteractionRequest } from '@graphql/contracts'

import { ConversationComposer, ConversationHistory, useConversationDraftStore } from '../conversations'
import { cancelOperatorTurn, createOperatorConversation, getOperatorConversation,
  listOperatorConversations, sendOperatorMessage, respondOperatorInteraction } from '../../shared/api/client'
import { subscribeOperatorChat } from '../../shared/api/operatorChatStream'
import { sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { useOperatorChatStore } from './operatorChatStore'
import { useOperatorChatVisibility } from './useOperatorChatVisibility'
import { acknowledgeOperatorMessage, readPendingOperatorMessage, reserveOperatorMessage } from './operatorOutbox'
import { projectOperatorText, type OperatorTextProjection } from './operatorTextProjection'
import './operatorChat.css'

const listKey = ['operator-chat', 'conversations'] as const
const detailKey = (id: string) => ['operator-chat', 'conversation', id] as const
function newer(current: OperatorConversationState | undefined, next: OperatorConversationState): OperatorConversationState {
  return current && current.revision > next.revision ? current : next
}

export function OperatorChat() {
  const enabled = useOperatorChatVisibility()
  const queryClient = useQueryClient()
  const open = useOperatorChatStore((state) => state.open)
  const historyOpen = useOperatorChatStore((state) => state.historyOpen)
  const selectedId = useOperatorChatStore((state) => state.selectedConversationId)
  const setOpen = useOperatorChatStore((state) => state.setOpen)
  const setHistoryOpen = useOperatorChatStore((state) => state.setHistoryOpen)
  const select = useOperatorChatStore((state) => state.select)
  const clearDraft = useConversationDraftStore((state) => state.clearDraft)
  // Presentation-only fragments. PostgreSQL/TanStack Query continue to own finalized messages.
  const [partial, setPartial] = useState<{ conversationId: string; value?: OperatorTextProjection }>()
  const [preparationError, setPreparationError] = useState<{ id: string; message: string }>()
  const [, refreshOutbox] = useState(0)
  const list = useQuery({ queryKey: listKey, queryFn: ({ signal }) => listOperatorConversations({ signal }), enabled: enabled && open })
  const selected = useQuery({ queryKey: detailKey(selectedId ?? ''), enabled: enabled && open && Boolean(selectedId),
    queryFn: async ({ signal }) => {
      const state = await getOperatorConversation(selectedId ?? '', { signal })
      return newer(queryClient.getQueryData<OperatorConversationState>(detailKey(selectedId ?? '')), state)
    }, refetchInterval: 3_000 })
  const invalidate = async (id: string) => { await Promise.all([
    queryClient.invalidateQueries({ queryKey: detailKey(id) }), queryClient.invalidateQueries({ queryKey: listKey }),
  ]) }
  const create = useMutation({ mutationFn: () => createOperatorConversation(), onSuccess: async ({ conversation }) => {
    select(conversation.id); await queryClient.invalidateQueries({ queryKey: listKey })
  } })
  const send = useMutation({
    mutationFn: ({ id, command }: { id: string; command: SendOperatorMessageRequest; generation: number }) => sendOperatorMessage(id, command),
    onSuccess: async (result, input) => {
      if (sessionIsSwitching() || sessionGeneration() !== input.generation) return
      acknowledgeOperatorMessage(input.id, input.command.requestId)
      clearDraft(input.id, input.command.content)
      refreshOutbox((value) => value + 1)
      queryClient.setQueryData<OperatorConversationState>(detailKey(input.id), (current) => newer(current, result.state))
      await invalidate(input.id)
    },
    // Even a later 4xx cannot prove that an earlier lost delivery was not accepted.
    // Keep the same durable request identity until a successful receipt is read.

  })
  const cancel = useMutation({ mutationFn: ({ id, requestId }: { id: string; requestId: string }) => cancelOperatorTurn(id, requestId),
    onSuccess: async (result, { id }) => { queryClient.setQueryData<OperatorConversationState>(detailKey(id), (current) => newer(current, result.state)); await invalidate(id) } })
  const respond = useMutation({ mutationFn: ({ id, input }: { id: string; input: RespondOperatorInteractionRequest }) => respondOperatorInteraction(id, input),
    onSuccess: async (result, { id }) => { queryClient.setQueryData<OperatorConversationState>(detailKey(id), (current) => newer(current, result.state)); await invalidate(id) } })

  useEffect(() => {
    if (!enabled || !open || !selectedId) return
    const refresh = () => { void queryClient.invalidateQueries({ queryKey: detailKey(selectedId) }); void queryClient.invalidateQueries({ queryKey: listKey }) }
    return subscribeOperatorChat(selectedId, {
      snapshot: (state) => queryClient.setQueryData<OperatorConversationState>(detailKey(selectedId), (current) => newer(current, state)),
      reconnect: refresh,
      event: (event) => {
        const state = queryClient.getQueryData<OperatorConversationState>(detailKey(selectedId))
        if (event.type === 'delta') {
          setPartial((current) => ({ conversationId: selectedId,
            value: projectOperatorText(current?.conversationId === selectedId ? current.value : undefined, state?.activeRequestId ?? null, event.data) }))
        } else {
          if (event.type === 'state' && typeof event.data.activeRequestId === 'string'
            && typeof event.data.revision === 'number' && Number.isSafeInteger(event.data.revision)
            && ['active', 'canceling'].includes(String(event.data.turnState))) {
            // A submission event precedes its deltas, even when the POST/GET response is still in flight.
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
  }, [enabled, open, queryClient, selectedId])

  if (!enabled) return null
  const conversation = selected.data
  const active = Boolean(conversation && (conversation.activeRequestId || !['idle', 'error'].includes(conversation.turnState)))
  const requestId = conversation?.activeRequestId
  const pending = selectedId ? readPendingOperatorMessage(selectedId) : {}
  const scopedSendError = send.variables?.id === selectedId && send.error instanceof Error ? send.error.message : undefined
  const sendError = preparationError && preparationError.id === selectedId ? preparationError.message : scopedSendError
  const partialText = partial?.value && partial.conversationId === selectedId && partial.value.requestId === requestId
    ? Object.values(partial.value.parts).join('\n\n') : ''
  const respondVariables = respond.variables
  const cancelVariables = cancel.variables
  const submit = (content: string) => {
    if (!selectedId) return
    try {
      const command = reserveOperatorMessage(selectedId, content, window.location.pathname + window.location.search)
      setPreparationError(undefined)
      send.mutate({ id: selectedId, command, generation: sessionGeneration() })
    } catch (error) { setPreparationError({ id: selectedId, message: error instanceof Error ? error.message : 'Message preparation failed.' }) }
  }
  return (
    <div className="operator-chat-root">
      {open ? <section className="operator-chat" role="dialog" aria-label="Operator chat">
        <header>
          <button type="button" aria-label={historyOpen ? 'Collapse history' : 'Open history'} onClick={() => setHistoryOpen(!historyOpen)}>{historyOpen ? <PanelLeftClose /> : <PanelLeftOpen />}</button>
          <strong>Operator</strong>
          <button type="button" aria-label="Close Operator chat" onClick={() => setOpen(false)}><X /></button>
        </header>
        <div className="operator-chat-body">
          {historyOpen ? <aside aria-label="Operator conversation history">
            <button type="button" onClick={() => create.mutate()} disabled={create.isPending}><Plus /> New chat</button>
            {list.isError ? <p role="alert">Conversation history could not be loaded.</p> : null}
            <nav>{list.data?.conversations.map((item) => <button type="button" aria-current={item.id === selectedId ? 'page' : undefined} key={item.id} onClick={() => select(item.id)}>{item.title ?? 'Conversation'}</button>)}</nav>
          </aside> : null}
          <main>
            {create.error instanceof Error ? <p role="alert">Conversation could not be created: {create.error.message}</p> : null}
            {!selectedId ? <button type="button" onClick={() => create.mutate()} disabled={create.isPending}>Start a new conversation</button> : null}
            {selected.isLoading ? <p>Loading conversation…</p> : null}
            {selected.isError ? <p role="alert">Conversation could not be loaded.</p> : null}
            {conversation ? <>
              <ConversationHistory messages={conversation.messages} />
              {partialText ? <div className="operator-chat-partial" role="status" aria-label="Assistant response in progress">{partialText}</div> : null}
              {active ? <p role="status">{conversation.turnState === 'uncertain' ? 'Reconnecting. The previous turn may still be running.' : conversation.turnState === 'canceling' ? 'Waiting for confirmed cancellation…' : 'Operator is working…'}</p> : null}
              {conversation.error ? <p role="alert">{conversation.error}</p> : null}
              {requestId && conversation.pendingInteraction ? <fieldset disabled={(respond.isPending && respond.variables?.id === selectedId) || conversation.responseDelivery !== 'offered'}>
                <legend>Operator permission request</legend>
                <pre className="operator-chat-approval-details">{JSON.stringify(conversation.pendingInteraction.request, null, 2)}</pre>
                {conversation.pendingInteraction.responseOptions.map((option) => <div key={option.optionId}>
                  <button type="button" onClick={() => respond.mutate({ id: conversation.conversation.id,
                    input: { requestId, nativeRequestId: conversation.pendingInteraction!.turn.nativeRequestId!, optionId: option.optionId } })}>{option.label}</button>
                  <p>{option.scopeSummary ?? `Applies to: ${option.persistence}`}{option.mutatesPersistentPolicy ? ' — changes persistent native policy' : ''}</p>
                </div>)}
                {conversation.responseDelivery !== 'offered' ? <p>Response delivery is being reconciled. It will not be sent twice.</p> : null}
              </fieldset> : null}
              {respondVariables && respondVariables.id === selectedId && respondVariables.input.requestId === requestId && respond.error instanceof Error ? <p role="alert">Approval response failed: {respond.error.message}</p> : null}
              {requestId ? <button className="operator-chat-cancel" type="button" onClick={() => cancel.mutate({ id: conversation.conversation.id, requestId })}
                disabled={cancel.isPending && cancel.variables?.id === selectedId}>Cancel turn</button> : null}
              {cancelVariables && cancelVariables.id === selectedId && cancelVariables.requestId === requestId && cancel.error instanceof Error ? <p role="alert">Cancellation failed: {cancel.error.message}</p> : null}
              {pending.error ? <p role="alert">{pending.error}</p> : null}
              {pending.command ? <button type="button" disabled={send.isPending && send.variables?.id === selectedId} onClick={() => {
                setPreparationError(undefined)
                send.mutate({ id: conversation.conversation.id, command: pending.command!, generation: sessionGeneration() })
              }}>Retry pending message</button> : null}
              <ConversationComposer conversationId={conversation.conversation.id} disabled={active || Boolean(pending.error)}
                isSending={send.isPending && send.variables?.id === selectedId} error={sendError} onSubmit={submit} />
            </> : null}
          </main>
        </div>
      </section> : null}
      {!open ? <button className="operator-chat-launcher" type="button" aria-label="Open Operator chat" onClick={() => setOpen(true)}><MessageCircle /></button> : null}
    </div>
  )
}
