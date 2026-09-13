import { useId, type FormEvent } from 'react'

import { useConversationDraftStore } from './conversationDraftStore'

export interface ConversationComposerProps {
  conversationId: string
  disabled?: boolean
  isSending?: boolean
  error?: string
  onSubmit: (content: string) => void
}

/** A local draft composer; it never sends anything without its parent callback. */
export function ConversationComposer({
  conversationId,
  disabled = false,
  isSending = false,
  error,
  onSubmit,
}: ConversationComposerProps) {
  const inputId = useId()
  const draft = useConversationDraftStore((state) => state.drafts[conversationId] ?? '')
  const setDraft = useConversationDraftStore((state) => state.setDraft)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const content = draft.trim()
    if (!content || disabled || isSending) return
    onSubmit(content)
  }

  return (
    <form onSubmit={submit} aria-label="Conversation composer">
      <label htmlFor={inputId}>Message</label>
      <textarea
        id={inputId}
        value={draft}
        rows={3}
        disabled={disabled || isSending}
        onChange={(event) => setDraft(conversationId, event.target.value)}
        placeholder="Write a message for this agent"
      />
      <button type="submit" disabled={disabled || isSending || !draft.trim()}>
        {isSending ? 'Sending…' : 'Send message'}
      </button>
      {error ? (
        <p role="alert">Message could not be sent: {error}</p>
      ) : null}
    </form>
  )
}
