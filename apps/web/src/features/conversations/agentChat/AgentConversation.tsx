import { ChatPrimaryActions } from '../ChatPrimaryActions'
import { CompactionActivity } from '../sessionControls/CompactionActivity'
import { useSessionControls } from '../sessionControls/useSessionControls'
import { compactionBlocksSend, parseSessionCommand, type SessionMode } from '@foreman-code/contracts'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentChatContext, AgentChatIntent, SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { ChatAttachmentControl, useConversationAttachments } from '../../attachments'
import { ChatAttachmentBoundary } from '../ChatAttachmentBoundary'
import { prepareChatAttachments } from '../chatAttachmentAttempt'
import { Alert, Button, CodeBlock, Dialog, LoadingState, Select } from '../../../shared/ui/nocturne'
import { createFileCardHttpClient, MessageFileCards } from '../../file-cards'
import { ApiError } from '../../../shared/api/client'
import { useFileDrop } from '../../../shared/ui/useFileDrop'
import { ConversationComposer } from '../ConversationComposer'
import { ConversationViewport } from '../ConversationViewport'
import { useConversationDraftStore } from '../conversationDraftStore'
import { chatBackgroundWork } from '../chatWorkStatus'
import { chatStatus } from '../chatStatus'
import { AgentChatTranscript } from './AgentChatTranscript'
import { chatBusy, deliveryLabels, intentLabels, intentUnavailable } from './model'
import { useAgentChat } from './useAgentChat'
import { PinnedProviderAccount } from '../../provider-accounts/PinnedProviderAccount'
import './agentChat.css'
import '../chatAttachments.css'

/** Mounted ONLY through the existing Board AgentChatPanel. Server state stays in Query. */
type AgentConversationProps = {
  context: AgentChatContext; name: string; runActivity?: ReactNode; onNewConversation?: () => void
}
export function AgentConversation(props: AgentConversationProps) {
  return <ChatAttachmentBoundary><AgentConversationContent {...props} /></ChatAttachmentBoundary>
}

function AgentConversationContent({ context, name, runActivity, onNewConversation }: AgentConversationProps) {
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
        message: failure instanceof Error ? failure.message : 'The native command could not be confirmed.' })
      return false
    } finally {
      focus()
    }
  }
  if (chat.access.isPending) return <ConversationViewport revision="access">{() => <>{runActivity}<LoadingState label="Checking Agent chat access…" rows={1} /></>}</ConversationViewport>
  if (chat.access.isError || chat.denial || !chat.state && !chat.canRead) return <ConversationViewport revision="denied">{() => <>{runActivity}<Alert tone="warning" title="Agent chat access unavailable" live>
    <p>{chat.denial?.message ?? chat.access.error?.message ?? 'Your access does not allow reading chat for this Agent and Run.'}</p>
    <Button size="sm" onClick={() => { void chat.access.refetch(); chat.refresh() }}>Refresh access</Button>
  </Alert></>}</ConversationViewport>

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
  const busy = !!state && chatBusy(state), hasQueue = state?.turns.some((turn) => turn.delivery === 'queued')
  const background = state && !busy ? chatBackgroundWork(state.activitySnapshot) : undefined
  const empty = (!draft.trim() && !attachments.hasAttachments) || attachments.hasBlockingAttachments || draft.length > 32_000
  const latest = chat.latestCommand
  const error = !receipt && latest?.status === 'error' ? latest.error : undefined
  const notActive = latest?.command?.kind === 'send' && ApiError.is(error) && error.code === 'AGENT_CHAT_TURN_NOT_ACTIVE'
  const stale = ApiError.is(error) && error.code === 'AGENT_CHAT_CONTEXT_STALE'
  const receipt = chat.currentReceipt ?? chat.confirmedReceipt ?? chat.latestReceipt
  // Capability notes describe actions available NOW, not every provider limitation while idle.
  const unavailable = state ? [...new Set([
    state.activeTurn && state.capabilities.steer === 'unavailable' ? state.capabilities.unavailable.steer : undefined,
    (busy || hasQueue) && !state.capabilities.interruptAndSend ? state.capabilities.unavailable.interruptAndSend : undefined,
    busy && !state.capabilities.queueNextTurn ? state.capabilities.unavailable.queueNextTurn : undefined,
    state.conversation && !busy && !state.capabilities.resume ? state.capabilities.unavailable.resume : undefined,
  ].filter((reason): reason is string => !!reason))] : []
  const sessionMissing = state?.availability.reason === 'native_session_missing' || state?.sessionState === 'unavailable'
  // Do not offer a first-message form for a selection that cannot create a conversation.
  // Existing conversations retain their editable local draft during temporary/unavailable states.
  const showComposer = !retired && !!state && (!!state.conversation || state.availability.canSend)
  const canStop = !retired && !!state && (busy || hasQueue) && state.availability.reason !== 'run_active' && !sessionMissing
    && (state.capabilities.interruptAndSend || !!state.capabilities.unavailable.interruptAndSend)
  const latestReply = state?.messages.filter((message) => message.role === 'assistant' && message.activityChannel !== 'reasoning' && message.nativeMessageComplete !== false).at(-1)
  const resendFiles = sendAgain && state ? [...state.messages, ...(chat.history.data?.pages.flatMap((batch) => batch.pages.flatMap((page) => page.messages)) ?? [])]
    .flatMap((message) => message.attachments ?? []) : []
  const status = chatStatus({
    phase: state?.sessionState ?? 'none',
    ...(state?.sessionState === 'idle' && background ? { executionLabel: background.label } : {}),
    connection: chat.connection,
    online: chat.online,
    hasConversation: !!state?.conversation,
    snapshotFresh: chat.query.isSuccess && chat.query.failureCount === 0,
  })
  let sessionLabel = status.execution
  if (!state?.conversation && state?.sourceTranscript) {
    sessionLabel = state.availability.canSend ? 'Ready for a follow-up' : 'Execution transcript · read-only'
  } else if (state && !state.conversation && !state.availability.canSend) {
    sessionLabel = context.runId ? 'No conversation for this Run' : 'No conversation yet'
  }
  let availabilityLabel = 'Chat note'
  if (state && !state.availability.canSend) {
    availabilityLabel = 'Messaging paused'
  }
  const notices = <div className="agent-chat-notices">
    {runActivity}
    {!retired && conversation ? <PinnedProviderAccount binding={conversation.providerAccountBinding}
      label={conversation.origin.kind === 'run_execution' ? 'Source Run account · saved chat account' : 'Saved chat account'} /> : null}
    {retired ? <p role="status">Retired harness (OpenCode): read-only</p> : <CompactionActivity controls={sessionControls} />}
    {state ? <p className="agent-chat-session-label" role="status">{sessionLabel}</p> : null}
    {background ? <p role="status">{background.message}</p> : null}
    {status.connection ? <Alert tone="warning" title={!chat.online ? 'You are offline'
      : chat.connection === 'unavailable' ? 'Live updates unavailable' : 'Connecting to live activity'} live>
      {status.connection}
    </Alert> : null}
    {chat.query.isError ? <Alert title="Chat could not be refreshed" tone="warning" live><p>{chat.query.error.message}</p>
      <Button size="sm" onClick={() => { void chat.query.refetch() }}>Refresh chat</Button></Alert> : null}
    {chat.query.isPending ? <LoadingState label="Loading this Agent conversation…" rows={1} /> : null}
    {state?.availability.message ? <details className="agent-chat-availability">
      <summary title={state.availability.message}>{availabilityLabel}</summary>
      <p>{state.availability.message}</p>
    </details> : null}
    {sessionMissing && conversation?.providerAccountBinding ? <p role="status">This chat keeps its saved account and native profile. Restore access to its original computer and profile to continue.</p> : null}
    {sessionMissing && !conversation?.providerAccountBinding ? <div className="agent-chat-new-conversation">
      <p>{state?.conversation
        ? 'This conversation cannot be resumed. A separate conversation will not change this chat or the selected Run.'
        : context.runId ? 'No chat exists for this Run selection. A separate chat with the Agent outside the Run will not change the Run.'
          : 'No conversation exists for this selection. Choose another saved Agent to start a separate chat.'}</p>
      {onNewConversation ? <Button size="sm" onClick={onNewConversation}>{context.runId ? 'Start separate chat without this Run' : 'Choose another Agent for a new conversation'}</Button>
        : <p>Choose another saved Agent or leave the selected Run to start a separate conversation. There is no replacement-session command for this exact selection.</p>}
    </div> : null}
    {receipt && !state?.turns.some(turn => turn.requestId === receipt.requestId) ? <details
      aria-label={`Latest command delivery: ${intentLabels[receipt.intent]} · ${deliveryLabels[receipt.delivery]}`}>
      <summary>Last message: {deliveryLabels[receipt.delivery]}</summary>
      <p>{intentLabels[receipt.intent]}. Load earlier messages to see its text.</p>
    </details> : null}
    {error ? <Alert title={stale ? 'Chat context changed' : notActive ? 'The targeted turn has finished' : 'Command not confirmed'} tone="warning" live>
      <p>{error instanceof Error ? error.message : 'The command could not be confirmed.'}</p>
      {stale ? <p>The latest conversation is being fetched. Your draft is kept; review it before sending again.</p> : null}
      {!retired && notActive ? <><p>Your draft is kept. It has not been sent as a different intent.</p>
        <Button size="sm" disabled={!!nextReason || empty} title={nextReason} onClick={() => submit('next_turn')}>Send as next turn</Button></> : null}
    </Alert> : null}
    <div id={reasonId} className="agent-chat-reasons">
      {nextReason ? <p>{nextReason}</p> : null}
      {unavailable.map((reason) => <p key={reason}>{reason}</p>)}
      {state?.activeTurn && steerReason && !unavailable.includes(steerReason) && steerReason !== nextReason ? <p>{steerReason}</p> : null}
      {stopReason && (busy || hasQueue) && stopReason !== nextReason && !unavailable.includes(stopReason) ? <p>{stopReason}</p> : null}
      {state?.activeTurn && interruptReason && interruptReason !== nextReason && !unavailable.includes(interruptReason) ? <p>{interruptReason}</p> : null}
    </div>
  </div>
  return <div className="agent-conversation" data-testid="agent-conversation" data-chat-key={chat.draftKey}>
    {state ? <AgentChatTranscript key={state.conversation?.id ?? 'none'} state={state} name={name} readOnly={retired} commands={chat.commands} history={chat.history}
      notices={notices} cancelReason={cancelReason} responseReason={responseReason} resendReason={nextReason}
      controlResendReason={controlReason}
      onRefresh={chat.refresh} refreshing={chat.query.isFetching} onCancel={chat.cancelQueued} onRespond={chat.respond}
      onSendAgain={(content, pins, mode) => setSendAgain({ content, attachments: pins, draftKey: chat.draftKey,
        sessionMode: parseSessionCommand(content).kind === 'plan-task' ? 'plan' : mode })} />
      : <ConversationViewport revision="loading">{() => notices}</ConversationViewport>}
    {showComposer || canStop ? <div className="agent-chat-composer-controls" role="group" aria-label="Chat actions" aria-describedby={reasonId} {...drop.dropTargetProps}>
      {showComposer ? <ConversationComposer sessionControls={sessionControls} conversationId={chat.draftKey} inputRef={composer} maxLength={32_000}
        allowEditingWhileSending isSending={chat.pending} sendDisabled={!!nextReason || attachments.hasBlockingAttachments}
        hasAttachments={attachments.hasAttachments}
        attachmentControl={<ChatAttachmentControl draft={attachments} disabled={!!writeReason} composerDrop={drop} />} error={chat.localError}
        sendLabel={busy ? 'Queue message' : 'Send message'} onSubmit={(content, mode) => submit('next_turn', content, mode)} /> : null}
      {!retired && (state?.activeTurn || canStop) ? <div className="agent-chat-controls" role="group" aria-label="Active turn controls">
        {state?.activeTurn && (state.capabilities.steer !== 'unavailable' || state.capabilities.unavailable.steer) ? <Button size="sm" disabled={!!steerReason || empty}
          title={steerReason ?? 'Add input at the next processing step'} aria-describedby={reasonId} onClick={() => submit('steer')}>Steer</Button> : null}
        {state?.activeTurn && (state.capabilities.interruptAndSend || state.capabilities.unavailable.interruptAndSend) ? <Button size="sm" disabled={!!interruptReason || empty}
          title={interruptReason} aria-describedby={reasonId} onClick={() => submit('interrupt_and_send')}>Interrupt and send</Button> : null}
        {canStop ? <ChatPrimaryActions stopReason={stopReason} describedBy={reasonId}
          onStop={() => { chat.stop(); focus() }} /> : null}
      </div> : null}
    </div> : null}
    {commandError?.draftKey === chat.draftKey
      && (!commandCompaction || commandCompaction.status === 'failed')
      ? <p role="alert">{commandCompaction?.message ?? commandError.message}</p> : null}
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
