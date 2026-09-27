import { useEffect, useId, useRef, useState } from 'react'
import type { AgentChatContext, AgentChatIntent, AgentChatSessionState } from '@graphql/contracts/agent-chat'
import { Alert, Button, ConfirmDialog, LoadingState } from '../../../shared/ui/nocturne'
import { ApiError } from '../../../shared/api/client'
import { ConversationComposer } from '../ConversationComposer'
import { useConversationDraftStore } from '../conversationDraftStore'
import { AgentChatTranscript } from './AgentChatTranscript'
import { chatBusy, deliveryLabels, intentLabels, intentUnavailable } from './model'
import { useAgentChat } from './useAgentChat'
import './agentChat.css'

const stateLabels: Record<AgentChatSessionState, string> = {
  none: 'Start a conversation', creating: 'Creating the native session', idle: 'Ready for a follow-up', active: 'Agent is working',
  interrupting: 'Waiting for the interrupted turn to settle', waiting_approval: 'Waiting for approval', uncertain: 'Native delivery is unconfirmed',
  unavailable: 'Native session unavailable', error: 'The last turn failed',
}

/** Mounted ONLY through the existing Board AgentChatPanel. Server state stays in Query. */
export function AgentConversation({ context, name, onNewConversation }: {
  context: AgentChatContext; name: string; onNewConversation?: () => void
}) {
  const chat = useAgentChat(context), state = chat.state
  const draft = useConversationDraftStore((store) => store.drafts[chat.draftKey] ?? '')
  const composer = useRef<HTMLTextAreaElement>(null), focused = useRef(false)
  const [sendAgain, setSendAgain] = useState<string>()
  const reasonId = useId()
  useEffect(() => {
    if (!state || focused.current || !composer.current) return
    const active = document.activeElement, popover = composer.current.closest('.n-agent-popover')
    if (!active || active === document.body || active.matches('.n-agent-action--chat[aria-expanded="true"]')
      || active.getAttribute('role') === 'tab' && popover?.contains(active)) {
      focused.current = true
      composer.current.focus({ preventScroll: true })
    }
  }, [state])
  const focus = () => composer.current?.focus({ preventScroll: true })
  const submit = (intent: AgentChatIntent) => { chat.send(draft, intent); focus() }
  if (chat.access.isPending) return <LoadingState label="Checking Agent chat access…" rows={1} />
  if (chat.access.isError || chat.denial || !chat.state && !chat.canRead) return <Alert tone="warning" title="Agent chat access unavailable" live>
    <p>{chat.denial?.message ?? chat.access.error?.message ?? 'Your access does not allow reading chat for this Agent and Run.'}</p>
    <Button size="sm" onClick={() => { void chat.access.refetch(); chat.refresh() }}>Refresh access</Button>
  </Alert>

  const writeReason = chat.blocked('agent_chat:write')
  const nextReason = writeReason ?? (state ? intentUnavailable(state, 'next_turn') : 'Loading this conversation…')
  const steerReason = writeReason ?? (state ? intentUnavailable(state, 'steer') : 'Loading this conversation…')
  const interruptReason = writeReason ?? (state ? intentUnavailable(state, 'interrupt_and_send') : 'Loading this conversation…')
  const cancelReason = chat.blocked('agent_chat:cancel')
  const responseReason = chat.blocked('agent_chat:respond')
  const stopReason = cancelReason ?? (state?.capabilities.interruptAndSend ? undefined
    : state?.capabilities.unavailable.interruptAndSend ?? 'Interrupting is unavailable.')
  const busy = !!state && chatBusy(state), hasQueue = state?.turns.some((turn) => turn.delivery === 'queued')
  const empty = !draft.trim() || draft.length > 32_000
  const latest = chat.latestCommand
  const receipt = chat.latestReceipt
  const error = !receipt && latest?.status === 'error' ? latest.error : undefined
  const notActive = latest?.command?.kind === 'send' && ApiError.is(error) && error.code === 'AGENT_CHAT_TURN_NOT_ACTIVE'
  const stale = ApiError.is(error) && error.code === 'AGENT_CHAT_CONTEXT_STALE'
  const currentReceipt = chat.currentReceipt
  const unavailable = state ? [...new Set(Object.values(state.capabilities.unavailable).filter(Boolean))] : []
  const sessionMissing = state?.availability.reason === 'native_session_missing' || state?.sessionState === 'unavailable'
  const latestReply = state?.messages.filter((message) => message.role === 'assistant' && message.nativeMessageComplete !== false).at(-1)
  return <div className="agent-conversation" data-testid="agent-conversation" data-chat-key={chat.draftKey}>
    {state ? <p className="agent-chat-session-label" role="status">{stateLabels[state.sessionState]}</p> : null}
    {!chat.online ? <Alert tone="warning" title="You are offline" live>Your draft is kept. No messages will be sent automatically when you reconnect.</Alert>
      : state?.conversation && chat.connection !== 'connected' ? <Alert tone="warning" title={chat.connection === 'unavailable' ? 'Live updates unavailable' : 'Connecting to live activity'} live>
        {chat.connection === 'unavailable' ? 'Checking the latest saved state while live updates are unavailable.' : 'Reconnecting and checking the latest saved state. Messages are not resent.'}
      </Alert> : null}
    {chat.query.isError ? <Alert title="Chat could not be refreshed" tone="warning" live><p>{chat.query.error.message}</p>
      <Button size="sm" onClick={() => { void chat.query.refetch() }}>Refresh chat</Button></Alert> : null}
    {chat.query.isPending ? <LoadingState label="Loading this Agent conversation…" rows={1} /> : null}
    {state?.availability.message ? <Alert title={state.availability.reason === 'run_active' ? 'Selected Run — read only' : sessionMissing ? 'Native session missing' : 'Chat availability'} tone="warning">
      {state.availability.message}
    </Alert> : null}
    {sessionMissing ? <div className="agent-chat-new-conversation">
      <p>This conversation cannot be resumed. A separate conversation will not change this chat or the selected Run.</p>
      {onNewConversation ? <Button size="sm" onClick={onNewConversation}>{context.runId ? 'Start separate chat without this Run' : 'Choose another Agent for a new conversation'}</Button>
        : <p>Choose another saved Agent or leave the selected Run to start a separate conversation. There is no replacement-session command for this exact selection.</p>}
    </div> : null}
    {state?.sessionState === 'none' && state.availability.canSend ? <p className="agent-chat-note">
      {context.runId ? 'Your first message forks this finished Run’s native session. It never restarts or changes the Run.'
        : 'Your first message starts a native conversation using this Agent’s accepted settings. Unsaved settings do not apply.'}
    </p> : null}
    {state ? <AgentChatTranscript key={state.conversation?.id ?? 'none'} state={state} name={name} commands={chat.commands} history={chat.history}
      cancelReason={cancelReason} responseReason={responseReason} resendReason={nextReason}
      onCancel={chat.cancelQueued} onRespond={chat.respond} onSendAgain={setSendAgain} /> : null}
    {busy && !state?.messages.some((message) => message.role === 'assistant' && message.requestId === state.activeTurn?.requestId && message.nativeMessageComplete === false)
      ? <p className="agent-chat-note">No partial assistant text has been received for this turn. A completed reply will appear when available.</p> : null}
    {receipt ? <p className="agent-chat-note" role="status">{currentReceipt ? 'Server recorded' : 'Initial acknowledgement'}: {intentLabels[receipt.intent]} · {deliveryLabels[currentReceipt?.delivery ?? receipt.delivery]}</p> : null}
    {error ? <Alert title={stale ? 'Chat context changed' : notActive ? 'The targeted turn has finished' : 'Command not confirmed'} tone="warning" live>
      <p>{error instanceof Error ? error.message : 'The command could not be confirmed.'}</p>
      {stale ? <p>The latest conversation is being fetched. Your draft is kept; review it before sending again.</p> : null}
      {notActive ? <><p>Your draft is kept. It has not been sent as a different intent.</p>
        <Button size="sm" disabled={!!nextReason || empty} title={nextReason} onClick={() => submit('next_turn')}>Send as next turn</Button></> : null}
    </Alert> : null}
    <div className="agent-chat-composer-controls" aria-describedby={reasonId}>
      <ConversationComposer conversationId={chat.draftKey} inputRef={composer} maxLength={32_000}
        allowEditingWhileSending isSending={chat.pending} sendDisabled={!!nextReason} error={chat.localError}
        sendLabel={busy ? 'Queue message' : 'Send message'} onSubmit={(content) => chat.send(content, 'next_turn')} />
      {state?.activeTurn ? <div className="agent-chat-controls" role="group" aria-label="Active turn controls">
        {state.capabilities.steer !== 'unavailable' || state.capabilities.unavailable.steer ? <Button size="sm" disabled={!!steerReason || empty}
          title={steerReason} aria-describedby={reasonId} onClick={() => submit('steer')}>Steer</Button> : null}
        {state.capabilities.interruptAndSend || state.capabilities.unavailable.interruptAndSend ? <Button size="sm" disabled={!!interruptReason || empty}
          title={interruptReason} aria-describedby={reasonId} onClick={() => submit('interrupt_and_send')}>Interrupt and send</Button> : null}
      </div> : null}
      {state && (busy || hasQueue) && state.availability.reason !== 'run_active' && !sessionMissing
        && (state.capabilities.interruptAndSend || state.capabilities.unavailable.interruptAndSend) ? <div className="agent-chat-controls">
        <Button size="sm" disabled={!!stopReason} title={stopReason} aria-describedby={reasonId} onClick={() => { chat.stop(); focus() }}>Stop chat</Button>
        <span className="agent-chat-note">Stops this chat’s active turn and all queued messages, not the workflow Run.</span>
      </div> : null}
      <div id={reasonId} className="agent-chat-reasons">
        {nextReason ? <p>{nextReason}</p> : null}
        {unavailable.map((reason) => <p key={reason}>{reason}</p>)}
        {state?.activeTurn && steerReason && !unavailable.includes(steerReason) && steerReason !== nextReason ? <p>{steerReason}</p> : null}
        {stopReason && (busy || hasQueue) && stopReason !== nextReason && !unavailable.includes(stopReason) ? <p>{stopReason}</p> : null}
        {state?.capabilities.steer === 'cooperative_next_step' && state.activeTurn ? <p>Steer adds input at the next processing step; it does not guarantee which native turn consumes it.</p> : null}
      </div>
    </div>
    <div className="n-sr-only" aria-live="polite" aria-atomic="true">{latestReply ? `New reply from ${name}: ${latestReply.content}` : ''}</div>
    <ConfirmDialog open={sendAgain !== undefined} onOpenChange={(open) => { if (!open) setSendAgain(undefined) }}
      title="Send again as a new message?" description="The original message may already have been accepted. This creates a new message and can repeat work. It is not a retry or a resume."
      confirmLabel="Send as new message" error={nextReason} pending={chat.pending} onConfirm={() => {
        if (sendAgain !== undefined && chat.send(sendAgain, 'next_turn', false, true)) { setSendAgain(undefined); focus() }
      }} />
  </div>
}
