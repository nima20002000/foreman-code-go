import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { parseSessionCommand, type SessionMode } from '@graphql/contracts'
import { Icon, IconButton } from '../../shared/ui/nocturne'
import { useConversationDraftStore } from '../conversations'
import type { useFileDrop } from '../../shared/ui/useFileDrop'
import { SessionControls } from '../conversations/sessionControls/SessionControls'
import { useSlashCommandMenu } from '../conversations/sessionControls/useSlashCommandMenu'
import type { ComposerSessionControls } from '../conversations/sessionControls/useSessionControls'
import '../conversations/chatAttachments.css'

export function OperatorComposer({ conversationId, context, attachmentControl, fileDropProps, hasAttachments = false,
  sendDisabled = false, isSending = false, onSubmit, onNewChat, onCancel, sessionControls }: {
  conversationId: string; context?: ReactNode; attachmentControl?: ReactNode; hasAttachments?: boolean;
  sendDisabled?: boolean; isSending?: boolean; sessionControls?: ComposerSessionControls;
  fileDropProps?: ReturnType<typeof useFileDrop>['dropTargetProps'];
  onSubmit(content: string, mode?: SessionMode): void; onNewChat(): void; onCancel?: () => void;
}) {
  const value = useConversationDraftStore((state) => state.drafts[conversationId] ?? '')
  const setDraft = useConversationDraftStore((state) => state.setDraft)
  const input = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const [commandError, setCommandError] = useState<string>()
  const command = parseSessionCommand(value)
  const commandOnly = command.kind === 'compact' || command.kind === 'mode'
  const isNew = command.kind === 'new'
  const pending = commandOnly ? sessionControls?.mutation.isPending : isSending
  const cannotSend = (!isNew && (pending || (!commandOnly && sendDisabled))) || (!value.trim() && !hasAttachments)
  useLayoutEffect(() => {
    if (!input.current) return
    input.current.style.height = '0px'
    input.current.style.height = `${Math.min(144, Math.max(36, input.current.scrollHeight))}px`
  }, [value])
  useLayoutEffect(() => { input.current?.focus() }, [conversationId])
  async function send(content = value.trim()) {
    if (cannotSend) return
    setCommandError(undefined)
    const parsed = parseSessionCommand(content)
    try {
      if (parsed.kind === 'invalid') throw new Error(parsed.message)
      if (parsed.kind === 'new') onNewChat()
      else if (parsed.kind === 'compact' || parsed.kind === 'mode') {
        if (!sessionControls) throw new Error('Native controls are unavailable for this conversation.')
        await sessionControls.command(content, conversationId)
      } else if (parsed.kind === 'plan-task') onSubmit(content, 'plan')
      else onSubmit(content)
    } catch (failure) {
      setCommandError(failure instanceof Error ? failure.message : 'The native command could not be confirmed.')
    }
  }
  const menu = useSlashCommandMenu(value, content => setDraft(conversationId, content), content => { void send(content) }, true)
  return <form className="operator-composer" aria-label="Conversation composer" {...fileDropProps}
    onSubmit={event => { event.preventDefault(); void send() }}>
    {menu.menu}
    <label htmlFor={id} className="n-sr-only">Message</label>
    {/* eslint-disable-next-line no-restricted-syntax -- combobox textarea uses the shared slash menu. */}
    <textarea ref={input} id={id} rows={1} value={value} maxLength={16000} placeholder="Message the operator…" {...menu.inputProps}
      onChange={event => { setDraft(conversationId, event.target.value); menu.reset(); setCommandError(undefined) }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || menu.onKeyDown(event)) return
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault(); void send()
        }
      }} />
    <div className="operator-composer-toolbar">
      {attachmentControl}
      <div className="operator-composer-model">{context}{sessionControls ? <SessionControls controls={sessionControls} /> : null}</div>
      {onCancel && !commandOnly ? <IconButton label="Stop response" onClick={onCancel} className="operator-composer-send"><Icon name="stop" size={15} /></IconButton>
        : <IconButton label="Send message" type="submit" disabled={cannotSend} className="operator-composer-send" loading={pending}><Icon name="arrow" className="operator-send-arrow" size={17} /></IconButton>}
    </div>
    {commandError ? <p role="alert">{commandError}</p> : null}
  </form>
}
