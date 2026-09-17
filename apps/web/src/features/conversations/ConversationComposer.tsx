import { MessageComposer } from '../../shared/ui/nocturne'
import { useConversationDraftStore } from './conversationDraftStore'

export interface ConversationComposerProps {
  conversationId: string
  /** Disable both editing and submission. */
  disabled?: boolean
  /** Block submission without locking the draft. */
  sendDisabled?: boolean
  /** Existing callers keep their original in-flight editing behavior. */
  allowEditingWhileSending?: boolean
  isSending?: boolean
  error?: string
  onSubmit: (content: string) => void
}

/** A local draft composer; it never sends anything without its parent callback. */
export function ConversationComposer({
  conversationId,
  disabled = false,
  sendDisabled = false,
  allowEditingWhileSending = false,
  isSending = false,
  error,
  onSubmit,
}: ConversationComposerProps) {
  const draft = useConversationDraftStore((state) => state.drafts[conversationId] ?? '')
  const setDraft = useConversationDraftStore((state) => state.setDraft)

  return (
    <MessageComposer
      formLabel="Conversation composer"
      label="Message"
      placeholder="Write a message for this agent"
      sendLabel="Send message"
      value={draft}
      onValueChange={(value) => setDraft(conversationId, value)}
      onSend={(content) => onSubmit(content.trim())}
      pending={isSending}
      disabled={disabled || (isSending && !allowEditingWhileSending)}
      sendDisabled={sendDisabled}
      error={error ? `Message could not be sent: ${error}` : undefined}
    />
  )
}
