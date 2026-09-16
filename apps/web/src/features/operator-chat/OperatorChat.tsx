import { useEffect } from 'react'
import { MessageCircle, PanelLeftClose, PanelLeftOpen, Plus, X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ConversationComposer, ConversationHistory, useConversationDraftStore } from '../conversations'
import {
  cancelOperatorTurn, createOperatorConversation, getOperatorConversation,
  listOperatorConversations, sendOperatorMessage,
} from '../../shared/api/client'
import { useOperatorChatStore } from './operatorChatStore'
import { useOperatorChatVisibility } from './useOperatorChatVisibility'
import './operatorChat.css'

const listKey = ['operator-chat', 'conversations'] as const
const detailKey = (id: string) => ['operator-chat', 'conversation', id] as const

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
  const list = useQuery({ queryKey: listKey, queryFn: ({ signal }) => listOperatorConversations({ signal }), enabled: enabled && open })
  const selected = useQuery({ queryKey: detailKey(selectedId ?? ''), queryFn: ({ signal }) => getOperatorConversation(selectedId ?? '', { signal }), enabled: enabled && open && Boolean(selectedId), refetchInterval: 3_000 })
  const create = useMutation({ mutationFn: () => createOperatorConversation(), onSuccess: async ({ conversation }) => { select(conversation.id); await queryClient.invalidateQueries({ queryKey: listKey }) } })
  const send = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) => sendOperatorMessage(id, {
      requestId: crypto.randomUUID(), content, context: { route: window.location.pathname },
    }),
    onSuccess: async (_result, input) => { clearDraft(input.id); await Promise.all([queryClient.invalidateQueries({ queryKey: detailKey(input.id) }), queryClient.invalidateQueries({ queryKey: listKey })]) },
  })
  const cancel = useMutation({ mutationFn: (id: string) => cancelOperatorTurn(id), onSuccess: async (_result, id) => queryClient.invalidateQueries({ queryKey: detailKey(id) }) })

  useEffect(() => {
    if (!enabled || !open || !selectedId) return
    const events = new EventSource(`/api/operator/conversations/${encodeURIComponent(selectedId)}/events`)
    const refresh = () => { void queryClient.invalidateQueries({ queryKey: detailKey(selectedId) }); void queryClient.invalidateQueries({ queryKey: listKey }) }
    events.addEventListener('message', refresh); events.addEventListener('state', refresh); events.addEventListener('error', refresh)
    return () => events.close()
  }, [enabled, open, queryClient, selectedId])

  if (!enabled) return null
  const conversation = selected.data
  const active = conversation && !['idle', 'error'].includes(conversation.turnState)
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
            {!selectedId ? <button type="button" onClick={() => create.mutate()} disabled={create.isPending}>Start a new conversation</button> : null}
            {selected.isLoading ? <p>Loading conversation…</p> : null}
            {selected.isError ? <p role="alert">Conversation could not be loaded.</p> : null}
            {conversation ? <>
              <ConversationHistory messages={conversation.messages} />
              {conversation.error ? <p role="alert">{conversation.error}</p> : null}
              {active ? <button className="operator-chat-cancel" type="button" onClick={() => cancel.mutate(conversation.conversation.id)} disabled={cancel.isPending}>Cancel turn</button> : null}
              <ConversationComposer conversationId={conversation.conversation.id} disabled={Boolean(active)} isSending={send.isPending} error={send.error instanceof Error ? send.error.message : undefined} onSubmit={(content) => send.mutate({ id: conversation.conversation.id, content })} />
            </> : null}
          </main>
        </div>
      </section> : null}
      {!open ? <button className="operator-chat-launcher" type="button" aria-label="Open Operator chat" onClick={() => setOpen(true)}><MessageCircle /></button> : null}
    </div>
  )
}
