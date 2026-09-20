import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, IconButton } from '../../shared/ui/nocturne'
import { useConversationDraftStore } from '../conversations'

export function OperatorComposer({ conversationId, context, access, sendDisabled = false, isSending = false, onSubmit, onNewChat, onCancel }: {
  conversationId: string; context?: ReactNode; access?: ReactNode; sendDisabled?: boolean; isSending?: boolean;
  onSubmit(content: string): void; onNewChat(): void; onCancel?: () => void;
}) {
  const value = useConversationDraftStore((state) => state.drafts[conversationId] ?? '')
  const setDraft = useConversationDraftStore((state) => state.setDraft)
  const input = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const [dismissed, setDismissed] = useState(false)
  const commandsOpen = !dismissed && /^\/n?e?w?$/.test(value.trim())
  const isNew = value.trim() === '/new'
  const cannotSend = isSending || (!isNew && sendDisabled) || !value.trim()
  useLayoutEffect(() => {
    if (!input.current) return
    input.current.style.height = '0px'
    input.current.style.height = `${Math.min(144, Math.max(36, input.current.scrollHeight))}px`
  }, [value])
  useLayoutEffect(() => { input.current?.focus() }, [conversationId])
  function send() {
    if (cannotSend) return
    if (isNew) onNewChat()
    else onSubmit(value.trim())
  }
  return <form className="operator-composer" aria-label="Conversation composer" onSubmit={(event) => { event.preventDefault(); send() }}>
    {commandsOpen ? <div className="operator-slash-menu" role="listbox" aria-label="Chat commands" id={`${id}-commands`}>
      <button id={`${id}-new`} type="button" role="option" aria-selected tabIndex={-1} onMouseDown={(event) => event.preventDefault()}
        onClick={onNewChat}><code>/new</code><span>Start a new chat</span><kbd>↵</kbd></button>
    </div> : null}
    <label htmlFor={id} className="n-sr-only">Message</label>
    <textarea ref={input} id={id} rows={1} value={value} maxLength={16000} placeholder="Message the operator…"
      aria-controls={commandsOpen ? `${id}-commands` : undefined} aria-expanded={commandsOpen}
      aria-autocomplete="list" aria-activedescendant={commandsOpen ? `${id}-new` : undefined}
      onChange={(event) => { setDraft(conversationId, event.target.value); setDismissed(false) }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (commandsOpen && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(true); return }
        if (commandsOpen && ['ArrowDown', 'ArrowUp', 'Tab'].includes(event.key)) { event.preventDefault(); setDraft(conversationId, '/new'); return }
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault()
          if (commandsOpen && !isSending) onNewChat()
          else send()
        }
      }} />
    <div className="operator-composer-toolbar">
      <IconButton label="New chat" variant="ghost" onClick={onNewChat} disabled={isSending}><Icon name="plus" size={17} /></IconButton>
      {access}
      <div className="operator-composer-model">{context}</div>
      {onCancel ? <IconButton label="Stop response" onClick={onCancel} className="operator-composer-send"><Icon name="stop" size={15} /></IconButton>
        : <IconButton label="Send message" type="submit" disabled={cannotSend} className="operator-composer-send" loading={isSending}><Icon name="arrow" className="operator-send-arrow" size={17} /></IconButton>}
    </div>
  </form>
}
