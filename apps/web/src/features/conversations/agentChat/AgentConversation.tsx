import { errorMessage } from '../../../shared/errorMessage'
import { useSessionControls } from '../sessionControls/useSessionControls'
import { compactionBlocksSend, parseSessionCommand, type SessionMode } from '@foreman-code/contracts'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentChatContext, AgentChatIntent, SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { ChatAttachmentControl, useConversationAttachments } from '../../attachments'
import { ChatAttachmentBoundary } from '../ChatAttachmentBoundary'
import { prepareChatAttachments } from '../chatAttachmentAttempt'
import { Alert, Button, CodeBlock, Dialog, IconButton, LoadingState, Select, Tooltip } from '../../../shared/ui/nocturne'
import { createFileCardHttpClient, MessageFileCards } from '../../file-cards'
import { ApiError } from '../../../shared/api/client'
import { useFileDrop } from '../../../shared/ui/useFileDrop'
import { AgentChatComposer } from './AgentChatComposer'
import { AgentChatHeader, AgentChatStatus } from './AgentChatHeader'
import { agentChatStateLabel } from './chatStateLabel'
import { CornerDownLeft, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { ConversationViewport } from '../ConversationViewport'
import { useConversationDraftStore } from '../conversationDraftStore'
import { chatBackgroundWork } from '../chatWorkStatus'
import { AgentChatTranscript } from './AgentChatTranscript'
import { chatBusy, intentUnavailable } from './model'
import { useAgentChat } from './useAgentChat'
import { PinnedProviderAccount } from '../../provider-accounts/PinnedProviderAccount'
import './agentChat.css'
import '../chatAttachments.css'

/** Mounted ONLY through the existing Board AgentChatPanel. Server state stays in Query. */
type AgentConversationProps = {
  context: AgentChatContext; name: string; role?: string; activity?: string; runLabel?: string
  onClose?: () => void; onNewConversation?: () => void
}
export function AgentConversation(props: AgentConversationProps) {
  return <ChatAttachmentBoundary><AgentConversationContent {...props} /></ChatAttachmentBoundary>
}

function AgentConversationContent({ context, name, role, activity, runLabel, onClose, onNewConversation }: AgentConversationProps) {
  const chat = useAgentChat(context), state = chat.state
  const conversation = state?.conversation
  const retired = conversation?.harness === 'opencode' || state?.capabilities.harness === 'opencode'
  const conversationId = conversation?.id
  const sessionControls = useSessionControls(conversationId, {
    workspaceId: context.workspaceId, context, executionId: state?.sourceTranscript?.executionId,
    enabled: !!state,
  })
  const resendFileClient = useMemo(() => conversationId ? createFileCardHttpClient({
    download: `/api/workspaces/${encodeURIComponent(context.workspaceId)}/agent-chat/conversations/${encodeURIComponent(conversationId)}/files/{fileId}/revisions/{revisionId}/content`,
  }) : undefined, [context.workspaceId, conversationId])
  const attachments = useConversationAttachments(conversation ? { kind: 'temporary', chat: {
    kind: 'agent', conversationId: conversation.id, agentId: conversation.agentId,
    workspaceId: conversation.workspaceId, workflowId: conversation.workflowId,
    ...(conversation.origin.kind === 'run_execution' ? { runId: conversation.origin.runId, executionId: conversation.origin.executionId } : {}),
  } } : null)
  const writeReason = retired ? 'Retired harness (OpenCode): read-only' : chat.blocked('agent_chat:write')
  const drop = useFileDrop({ disabled: !!writeReason || !attachments.canAdd, onFiles: attachments.addFiles })
  const draft = useConversationDraftStore((store) => store.drafts[chat.draftKey] ?? '')
  const composer = useRef<HTMLTextAreaElement>(null), focused = useRef(false)
  const [sendAgainDraft, setSendAgain] = useState<Pick<SendAgentChatMessageRequest,
    'content' | 'attachments' | 'sessionMode'> & { draftKey: string }>()
  const sendAgain = sendAgainDraft?.draftKey === chat.draftKey ? sendAgainDraft : undefined
  const resendCommand = parseSessionCommand(sendAgain?.content ?? '')
  const resendControl = resendCommand.kind === 'compact' || resendCommand.kind === 'mode'
  const resendPending = chat.pending || resendControl && sessionControls.mutation.isPending
  const [commandError, setCommandError] = useState<{ draftKey: string; content: string; message: string }>()
  const commandCompaction = sessionControls.commandFeedback?.draft.content === commandError?.content
    ? sessionControls.commandFeedback?.compaction : undefined
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
  const submit = async (intent: AgentChatIntent, content = draft, sessionMode?: SessionMode,
    resend?: Pick<SendAgentChatMessageRequest, 'attachments'>) => {
    const command = parseSessionCommand(content)
    setCommandError(undefined)
    try {
      if (command.kind === 'invalid') throw new Error(command.message)
      if (command.kind === 'compact' || command.kind === 'mode') {
        return await sessionControls.command(content, resend ? `${chat.draftKey}:resend` : chat.draftKey)
      }
      if (command.kind === 'new') throw new Error('/new is available in Operator chat.')
      const mode = command.kind === 'plan-task' ? 'plan' : sessionMode ?? sessionControls.state?.desiredMode
      if (intent === 'steer' && mode === 'plan') return false
      if (compactionBlocksSend(sessionControls.state?.compaction ?? null)) return false
      const attempt = resend ? { attachments: resend.attachments ?? [] } : prepareChatAttachments(attachments)
      return !!attempt && chat.send(content, intent, !resend, !!resend, attempt, mode)
    } catch (failure) {
      setCommandError({ draftKey: chat.draftKey, content,
        message: errorMessage(failure, 'The native command could not be confirmed.') })
      return false
    } finally {
      focus()
    }
  }
  const header = <AgentChatHeader name={name} role={role} state={agentChatStateLabel(state, runLabel)}
    detail={[activity, state?.availability.message, state ? chatBackgroundWork(state.activitySnapshot)?.message : undefined]
      .filter(Boolean).join(' · ')} onClose={onClose} />
  if (chat.access.isPending) return <div className="agent-conversation">{header}
    <ConversationViewport revision="access">{() => <LoadingState label="Checking Agent chat access…" rows={1} />}</ConversationViewport>
  </div>
  if (chat.access.isError || chat.denial || !chat.state && !chat.canRead) return <div className="agent-conversation">{header}<ConversationViewport revision="denied">{() => <Alert tone="warning" title="Agent chat access unavailable" live>
    <p>{chat.denial?.message ?? chat.access.error?.message ?? 'Your access does not allow reading chat for this Agent and Run.'}</p>
    <Button size="sm" onClick={() => { void chat.access.refetch(); chat.refresh() }}>Refresh access</Button>
  </Alert>}</ConversationViewport></div>

  const command = parseSessionCommand(draft)
  const commandOnly = command.kind === 'compact' || command.kind === 'mode'
  const compactReason = compactionBlocksSend(sessionControls.state?.compaction ?? null)
    ? sessionControls.state?.compaction?.message : undefined
  const planSteerReason = !commandOnly && (command.kind === 'plan-task' || sessionControls.state?.desiredMode === 'plan')
    ? 'Plan messages need a new turn. Use Queue message or Interrupt and send.' : undefined
  const nextReason = writeReason ?? compactReason ?? (state ? intentUnavailable(state, 'next_turn') : 'Loading this conversation…')
  const controlReason = writeReason ?? (sessionControls.mutation.isPending ? 'A session control is still pending.' : undefined)
  const resendReason = resendControl ? controlReason : nextReason
  const steerReason = commandOnly ? controlReason : writeReason ?? compactReason ?? planSteerReason
    ?? (state ? intentUnavailable(state, 'steer') : 'Loading this conversation…')
  const interruptReason = commandOnly ? controlReason : writeReason ?? compactReason
    ?? (state ? intentUnavailable(state, 'interrupt_and_send') : 'Loading this conversation…')
  const cancelReason = retired ? 'Retired harness (OpenCode): read-only' : chat.blocked('agent_chat:cancel')
  const responseReason = (retired ? 'Retired harness (OpenCode): read-only' : chat.blocked('agent_chat:respond'))
    ?? (state?.pendingInteraction && (!state.pendingInteraction.turn.nativeRequestId || state.pendingInteraction.session.nativeSessionId !== state.conversation?.nativeSession?.nativeSessionId || state.activeTurn?.nativeTurnId && state.pendingInteraction.turn.nativeTurnId !== state.activeTurn.nativeTurnId) ? 'The original native request is not available.' : undefined)
    ?? (state?.pendingInteraction && !state.responseAvailability?.available ? state.responseAvailability?.message ?? 'Refresh this conversation to check reply availability.' : undefined)
    ?? (state?.responseAvailability && (state.responseAvailability.nativeRequestId !== state.pendingInteraction?.turn.nativeRequestId || state.responseAvailability.nativeSessionId !== state.pendingInteraction?.session.nativeSessionId || state.responseAvailability.nativeRequestType !== state.pendingInteraction?.nativeRequestType) ? 'Refresh this conversation before replying.' : undefined)
  const stopReason = cancelReason ?? (state?.capabilities.interruptAndSend ? undefined
    : state?.capabilities.unavailable.interruptAndSend ?? 'Interrupting is unavailable.')
  const busy = !!state && chatBusy(state)
  const hasQueue = !!state?.turns.some(turn => turn.delivery === 'queued')
  const background = state && !busy ? chatBackgroundWork(state.activitySnapshot) : undefined
  const empty = (!draft.trim() && !attachments.hasAttachments) || attachments.hasBlockingAttachments || draft.length > 32_000
  const latest = chat.latestCommand
  const receipt = chat.currentReceipt ?? chat.confirmedReceipt ?? chat.latestReceipt
  const error = !receipt && latest?.status === 'error' ? latest.error : undefined
  const notActive = latest?.command?.kind === 'send' && ApiError.is(error) && error.code === 'AGENT_CHAT_TURN_NOT_ACTIVE'
  const stale = ApiError.is(error) && error.code === 'AGENT_CHAT_CONTEXT_STALE'
  const sessionMissing = state?.availability.reason === 'native_session_missing' || state?.sessionState === 'unavailable'
  const canStop = !retired && !!state && (busy || hasQueue) && state.availability.reason !== 'run_active' && !sessionMissing
    && state.capabilities.interruptAndSend
  const latestReply = state?.messages.filter((message) => message.role === 'assistant' && message.activityChannel !== 'reasoning' && message.nativeMessageComplete !== false).at(-1)
  const resendFiles = sendAgain && state ? [...state.messages, ...(chat.history.data?.pages.flatMap((batch) => batch.pages.flatMap((page) => page.messages)) ?? [])]
    .flatMap((message) => message.attachments ?? []) : []
  const controlError = commandError?.draftKey === chat.draftKey
    && (!commandCompaction || commandCompaction.status === 'failed')
    ? commandCompaction?.message ?? commandError.message : undefined
  let attention = controlError ?? chat.localError
  let attentionAction: ReactNode
  if (!attention && error) {
    attention = errorMessage(error, 'Delivery failed')
    if (!retired && notActive) attentionAction = <Button size="sm" variant="ghost" disabled={!!nextReason || empty}
      title={nextReason} onClick={() => submit('next_turn')}>Send as next turn</Button>
    else if (stale) attentionAction = <Button size="sm" variant="ghost" onClick={chat.refresh}>Refresh</Button>
  }
  if (!attention && (state?.pendingInteraction || state?.sessionState === 'waiting_approval')) attention = responseReason ?? 'Approval pending'
  if (!attention && state?.sessionState === 'interrupting') attention = 'Stopping chat'
  if (!attention && state?.sessionState === 'uncertain') attention = 'Delivery unconfirmed'
  if (!attention && !chat.online) attention = 'You are offline'
  if (sessionMissing) {
    attention = 'Original session unavailable'
    if (!conversation?.providerAccountBinding && onNewConversation) attentionAction = <Button size="sm" variant="ghost"
      onClick={onNewConversation}>{context.runId ? 'Start separate chat without this Run' : 'Choose another Agent for a new conversation'}</Button>
  }
  if (!attention && (chat.connection === 'reconnecting' || chat.connection === 'unavailable')) attention = 'Reconnecting to live updates'
  if (!attention && chat.query.isError) {
    attention = 'Chat could not be refreshed'
    attentionAction = <Button size="sm" variant="ghost" onClick={() => void chat.query.refetch()}>Retry</Button>
  }
  if (!attention && compactReason) attention = compactReason
  if (!attention && background) attention = background.label
  const composerDisabled = retired || !!state && !state.conversation && !state.availability.canSend
  let composerReason = commandOnly ? controlReason : nextReason
  // One compact line while the Run Agent works: "Working — you can message it when it finishes".
  if (state?.availability.reason === 'run_active') composerReason = state.availability.message
    ?? (state.sourceTranscript?.state === 'starting' ? 'Read-only while starting' : 'Read-only while working')
  else if (state?.sessionState === 'creating') composerReason = 'Read-only while starting'
  else if (retired) composerReason = 'Retired harness: read-only'
  if (!composerReason && attachments.hasBlockingAttachments) composerReason = 'Wait for attachments'
  return <div className="agent-conversation" data-testid="agent-conversation" data-chat-key={chat.draftKey}>
    {header}
    <AgentChatStatus>{attention ? <><Tooltip content={attention}><span tabIndex={0}>{attention}</span></Tooltip><Tooltip content="Read the latest conversation status">
      <IconButton size="sm" variant="ghost" label="Refresh chat" disabled={chat.query.isFetching} onClick={chat.refresh}>
        <RotateCcw size={12} aria-hidden="true" />
      </IconButton>
    </Tooltip>{attentionAction}</> : null}</AgentChatStatus>
    {state ? <AgentChatTranscript key={state.conversation?.id ?? 'none'} state={state} name={name} readOnly={retired}
      commands={chat.commands} history={chat.history} cancelReason={cancelReason} responseReason={responseReason}
      resendReason={nextReason} controlResendReason={controlReason}
      onRefresh={chat.refresh} refreshing={chat.query.isFetching} onCancel={chat.cancelQueued} onRespond={chat.respond}
      onSendAgain={(content, pins, mode) => setSendAgain({ content, attachments: pins, draftKey: chat.draftKey,
        sessionMode: parseSessionCommand(content).kind === 'plan-task' ? 'plan' : mode })} />
      : <ConversationViewport revision="loading">{() => <LoadingState label="Loading conversation…" rows={1} />}</ConversationViewport>}
    {state ? <div className="agent-chat-composer-controls" role="group" aria-label="Chat actions" {...drop.dropTargetProps}>
      <AgentChatComposer name={name} draftKey={chat.draftKey} inputRef={composer} sessionControls={sessionControls}
        disabled={composerDisabled} reason={composerReason} pending={chat.pending} controlPending={sessionControls.mutation.isPending}
        hasAttachments={attachments.hasAttachments} canStop={canStop} stopReason={stopReason}
        onStop={() => { chat.stop(); focus() }} onSubmit={(content, mode) => { void submit('next_turn', content, mode) }}
        attachmentControl={!composerDisabled ? <Tooltip content="Attach files">
          <div><ChatAttachmentControl draft={attachments} disabled={!!writeReason} composerDrop={drop} /></div>
        </Tooltip> : undefined}
        actions={!retired ? <>
          {state.activeTurn && (state.capabilities.steer !== 'unavailable' || state.capabilities.unavailable.steer)
            ? <Tooltip content={steerReason ?? 'Steer the active turn'}>
              <IconButton size="sm" variant="ghost" label="Steer" title={steerReason ?? 'Steer the active turn'} disabled={!!steerReason || empty}
                onClick={() => void submit('steer')}><CornerDownLeft size={15} aria-hidden="true" /></IconButton>
            </Tooltip> : null}
          {state.activeTurn && (state.capabilities.interruptAndSend || state.capabilities.unavailable.interruptAndSend)
            ? <Tooltip content={interruptReason ?? 'Interrupt and send'}>
              <IconButton size="sm" variant="ghost" label="Interrupt and send" title={interruptReason ?? 'Interrupt and send'} disabled={!!interruptReason || empty}
                onClick={() => void submit('interrupt_and_send')}><RotateCcw size={15} aria-hidden="true" /></IconButton>
            </Tooltip> : null}
          {conversation?.providerAccountBinding ? <details className="agent-chat-options agent-chat-account">
            <summary aria-label="Saved account details" title="Saved account details"><SlidersHorizontal size={15} aria-hidden="true" /></summary>
            <div className="agent-chat-options-content"><PinnedProviderAccount binding={conversation.providerAccountBinding}
              label={conversation.origin.kind === 'run_execution' ? 'Source Run account · saved chat account' : 'Saved chat account'} /></div>
          </details> : null}
        </> : undefined} />
    </div> : null}
    <div className="n-sr-only" aria-live="polite" aria-atomic="true">{latestReply ? `New reply from ${name}: ${latestReply.content}` : ''}</div>
    <Dialog open={sendAgain !== undefined} onOpenChange={(open) => { if (!open) setSendAgain(undefined) }}
      title={resendControl ? 'Apply session command?' : 'Send again as a new message?'}
      description={resendControl ? 'This applies the displayed command to this chat’s native session.'
        : 'The original message may already have been accepted. This creates a new message and can repeat work. It is not a retry or a resume.'}
      dismissible={!resendPending} busy={resendPending} role="alertdialog" size="sm">
      {sendAgain ? <div className="n-stack">
        <CodeBlock label="Original message text" code={sendAgain.content} />
        {resendCommand.kind === 'message' ? <>
          {!sendAgain.sessionMode ? <p>The original mode is unavailable. Choose the mode for this new message.</p> : null}
          <Select label="Mode for new message" value={sendAgain.sessionMode ?? ''} options={[{ value: '', label: 'Choose a mode', disabled: true },
            { value: 'regular', label: 'Regular' }, { value: 'plan', label: 'Plan' }]}
            onChange={event => {
              if (event.target.value === 'regular' || event.target.value === 'plan') {
                setSendAgain({ ...sendAgain, sessionMode: event.target.value })
              }
            }} />
        </> : null}
        {resendCommand.kind === 'plan-task' ? <p>Mode: Plan</p> : null}
        {resendControl ? <p>This command uses native session controls. Attached files will not be sent.</p> : <>
          <p>Only the original file pins below will be sent. Displayed output files are excluded.</p>
          {sendAgain.attachments?.length ? <>
          <CodeBlock label="Original file pins" language="json" code={JSON.stringify(sendAgain.attachments, null, 2)} />
          {resendFileClient ? <MessageFileCards attachments={sendAgain.attachments} files={resendFiles} client={resendFileClient} /> : null}
          </> : <p>No original files. This new message will contain text only.</p>}
        </>}
        {resendReason ? <p className="n-field-error" role="alert">{resendReason}</p> : null}
        <div className="n-actions"><Button disabled={resendPending} onClick={() => setSendAgain(undefined)}>Keep it</Button>
          <Button variant="danger" loading={resendPending}
            disabled={resendPending || !!resendReason || !sendAgain.sessionMode && resendCommand.kind === 'message'}
            onClick={() => {
              void submit('next_turn', sendAgain.content, sendAgain.sessionMode, {
                attachments: sendAgain.attachments,
              }).then(sent => {
                if (sent) setSendAgain(draft => draft === sendAgain ? undefined : draft)
              })
          }}>{resendControl ? 'Apply session command' : 'Send as new message'}</Button></div>
      </div> : null}
    </Dialog>
  </div>
}
