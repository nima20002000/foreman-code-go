import { useRef, type ReactNode, type RefObject } from 'react'
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
  attachmentControl?: ReactNode
  hasAttachments?: boolean
  error?: string
  sendLabel?: string
  maxLength?: number
  inputRef?: RefObject<HTMLTextAreaElement | null>
  onSubmit: (content: string) => void
}

/** A local draft composer; it never sends anything without its parent callback. */
export function ConversationComposer({
  conversationId,
  disabled = false,
  sendDisabled = false,
  allowEditingWhileSending = false,
  isSending = false,
  attachmentControl,
  hasAttachments = false,
  error,
  sendLabel = 'Send message',
  maxLength,
  inputRef,
  onSubmit,
}: ConversationComposerProps) {
  const localRef = useRef<HTMLTextAreaElement>(null)
  const field = inputRef ?? localRef
  const draft = useConversationDraftStore((state) => state.drafts[conversationId] ?? '')
  const setDraft = useConversationDraftStore((state) => state.setDraft)

  return (
    <MessageComposer
      footerControl={attachmentControl}
      hasAttachments={hasAttachments}
      formLabel="Conversation composer"
      label="Message"
      placeholder="Write a message for this agent"
      sendLabel={sendLabel}
      maxLength={maxLength}
      inputRef={field}
      value={draft}
      onValueChange={(value) => setDraft(conversationId, value)}
      onSend={(content) => { onSubmit(content.trim()); field.current?.focus({ preventScroll: true }) }}
      pending={isSending}
      disabled={disabled || (isSending && !allowEditingWhileSending)}
      sendDisabled={sendDisabled}
      error={error ? `Message could not be sent: ${error}` : undefined}
    />
  )
}
