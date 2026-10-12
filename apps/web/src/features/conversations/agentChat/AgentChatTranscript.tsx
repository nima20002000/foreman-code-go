import type { ReactNode } from 'react'
import type { AgentChatState } from '@foreman-code/contracts/agent-chat'
import type { MessageAttachmentRef } from '@foreman-code/contracts/files'
import { ChatMessageFiles } from '../ChatMessageFiles'
import { ChatDecisionReceipts } from '../ChatDecisionReceipts'
import { parseSessionCommand, type Message } from '@foreman-code/contracts'
import { Badge, Button, MessageBubble } from '../../../shared/ui/nocturne'
import { OperatorActivityList } from '../../operator-chat/OperatorActivityList'
import { OperatorApprovalCard } from '../../operator-chat/OperatorApprovalCard'
import type { InteractionResponseValue, SessionMode } from '@foreman-code/contracts'
import { ConversationHistory } from '../ConversationHistory'
import { ConversationViewport } from '../ConversationViewport'
import { RunTranscript } from './RunTranscript'
import { approvalReplyAvailable, deliveryLabels, intentLabels, mergeChatMessages } from './model'
import { confirmedCommandReceipt } from './commandRecords'
import { applyCanonicalActivityItems } from './activityMerge'
import { placeChatActivities } from './activityPlacement'
import { commandMayHaveBeenAccepted, type AgentChatCommandRecord, type useAgentChat } from './useAgentChat'

export function AgentChatTranscript({
  state, name, commands, history, notices, readOnly = false, cancelReason, responseReason, resendReason, controlResendReason,
  onRefresh, refreshing, onCancel, onRespond, onSendAgain,
}: {
  state: AgentChatState; name: string; commands: AgentChatCommandRecord[]; history: ReturnType<typeof useAgentChat>['history']
  readOnly?: boolean; notices?: ReactNode; cancelReason?: string; responseReason?: string; resendReason?: string
  controlResendReason?: string
  onRefresh?(): void; refreshing?: boolean
  onCancel(requestId: string): void; onRespond(optionId: string, response?: InteractionResponseValue): void;
  onSendAgain(content: string, attachments?: MessageAttachmentRef[], mode?: SessionMode): void
}) {
  const id = state.conversation?.id
  const resendUnavailable = (content: string) => {
    const command = parseSessionCommand(content)
    return command.kind === 'compact' || command.kind === 'mode' ? controlResendReason : resendReason
  }
  const messages = mergeChatMessages(...[...(history.data?.pages.flatMap((batch) => batch.pages) ?? [])].reverse().map((page) => page.messages), state.messages).filter((message) => message.activityChannel !== 'reasoning')
  const receipts = new Map(state.turns.map((turn) => [turn.messageId, turn]))
  // Every nonterminal receipt is in state, but its text can lie outside the bounded message cut.
  const orphaned = state.turns.filter((turn) => !messages.some((message) => message.id === turn.messageId))
  const unresolved = commands.filter((record) => record.command?.kind === 'send'
    && (record.status === 'pending' || record.status === 'error' && commandMayHaveBeenAccepted(record.error))
    && !confirmedCommandReceipt(record, state)
    && !state.turns.some((turn) => record.command?.kind === 'send' && turn.requestId === record.command.input.requestId))
  const status = (message: Message) => {
    const receipt = receipts.get(message.id)
    if (message.role === 'assistant') return message.nativeMessageComplete === false
      ? <Badge>{message.requestId === state.activeTurn?.requestId ? 'Reply in progress' : 'Partial reply'}</Badge> : null
    if (message.role !== 'user') return null
    return receipt ? <span className="agent-chat-delivery" data-delivery={receipt.delivery}>
      <Badge tone={receipt.delivery === 'unknown' ? 'warning' : receipt.delivery === 'failed' ? 'danger' : 'neutral'}>{deliveryLabels[receipt.delivery]}</Badge>
      <span>{intentLabels[receipt.intent]}</span>
    </span> : <span className="agent-chat-note">Delivery receipt not included in this history page.</span>
  }
  // Only genuine server-provided public activities are shown. No timers, percentages, private
  // reasoning, or synthetic "thinking" strings. Unknown delta payloads only trigger state reads.
  const activities = applyCanonicalActivityItems(state.activities, state.activitySnapshot).filter((entry) => entry.kind !== 'thinking')
  const placement = placeChatActivities(messages, activities, state.activeTurn?.requestId)
  const revision = JSON.stringify([state.sourceTranscript, messages, state.turns, activities,
    state.pendingInteraction, unresolved.map((record) => [record.command, record.status])])
  return <ConversationViewport revision={revision}>{(onBrowse) => <>
    {notices}
    {state.sourceTranscript ? <RunTranscript transcript={state.sourceTranscript} name={name} /> : null}
    {onRefresh ? <ChatDecisionReceipts snapshot={state.activitySnapshot} onRefresh={onRefresh} pending={refreshing} /> : null}
    {id && (state.hasEarlierMessages && !history.data || history.hasNextPage) ? <Button size="sm" variant="ghost" disabled={history.isFetching}
      onClick={() => { onBrowse(); void history.fetchNextPage() }}>Load earlier messages</Button> : null}
    {history.isError ? <p role="alert">Earlier messages could not be loaded. <Button size="sm" disabled={history.isFetching}
      onClick={() => { onBrowse(); void history.fetchNextPage() }}>Retry history</Button></p> : null}
    {orphaned.length ? <section className="agent-chat-orphaned-turns" aria-label="Messages outside the current history page">
      {orphaned.map((turn) => {
        const original = commands.find((record) => record.command?.kind === 'send' && record.command.input.requestId === turn.requestId)?.command
        const content = original?.kind === 'send' ? original.input.content : undefined
        return <div key={turn.requestId} className="agent-chat-message-actions" data-delivery={turn.delivery}>
          <p><Badge tone={!readOnly && turn.delivery === 'unknown' ? 'warning' : turn.delivery === 'failed' ? 'danger' : 'neutral'}>{deliveryLabels[turn.delivery]}</Badge> {intentLabels[turn.intent]} · order {turn.sequence}</p>
          <p className="agent-chat-note">{turn.delivery === 'unknown' && content
            ? 'Message text is outside the current history page. Your locally submitted text is shown below.'
            : 'Message text is not included in the current history page. Load earlier messages to read it.'}</p>
          {turn.error ? <p className="agent-chat-note">{turn.error.message}</p> : null}
          {!readOnly && turn.delivery === 'queued' ? <><Button size="sm" disabled={!!cancelReason} title={cancelReason} onClick={() => onCancel(turn.requestId)}>Cancel queued message</Button>
            {cancelReason ? <p className="agent-chat-note">{cancelReason}</p> : null}</> : null}
          {turn.delivery === 'unknown' ? <>
            {!readOnly ? <p className="agent-chat-note">Delivery is unknown. No automatic resend. Read the original text before explicitly sending it as a new message.</p> : null}
            {content !== undefined ? <><p className="conversation-message-content">{content}</p>
              {!readOnly ? <Button size="sm" disabled={!!resendUnavailable(content)} title={resendUnavailable(content)}
                onClick={() => onSendAgain(content,
                  original?.kind === 'send' ? original.input.attachments : undefined,
                  original?.kind === 'send' ? original.input.sessionMode : undefined)}>Send again as new message</Button> : null}</> : null}
          </> : null}
        </div>
      })}
    </section> : null}
    {(!state.sourceTranscript || state.conversation) && <ConversationHistory messages={messages} assistantName={name} renderStatus={status}
      renderAfter={(message) => message.attachments?.length ? <ChatMessageFiles message={message} workspaceId={state.context.workspaceId} /> : null}
      interleaved={placement.rows.map(({ entry, beforeMessageId }) => ({
        key: JSON.stringify([id, entry.requestId, entry.id]), beforeMessageId,
        content: <OperatorActivityList entries={[entry]} activeRequestId={state.activeTurn?.requestId} onBrowse={onBrowse} />,
      }))}
      renderActions={(message) => {
      const turn = receipts.get(message.id)
      if (message.role !== 'user' || !turn) return null
      const original = commands.find(record => record.command?.kind === 'send'
        && record.command.input.requestId === turn.requestId)?.command
      return <div className="agent-chat-message-actions">
        {turn.delivery === 'accepted' ? <p className="agent-chat-note">Provider acknowledged delivery; consumption is not yet confirmed.</p> : null}
        {turn.error ? <p className="agent-chat-note">{turn.error.message}</p> : null}
        {!readOnly && turn.delivery === 'queued' ? <><Button size="sm" disabled={!!cancelReason} title={cancelReason} onClick={() => onCancel(turn.requestId)}>Cancel queued message</Button>
          {cancelReason ? <p className="agent-chat-note">{cancelReason}</p> : null}</> : null}
        {!readOnly && turn.delivery === 'unknown' ? <><p className="agent-chat-note">The original may have been accepted. It will not be resent automatically.</p>
          {message.originalInput?.requestId === turn.requestId
            ? <Button size="sm" disabled={!!resendUnavailable(message.originalInput.content)}
              title={resendUnavailable(message.originalInput.content)} onClick={() => onSendAgain(
              message.originalInput!.content, message.originalInput!.attachments,
              original?.kind === 'send' ? original.input.sessionMode : undefined)}>Send again as new message</Button>
            : <><p className="agent-chat-note">Original send inputs are unavailable in this view. Do not use displayed outputs as new inputs.</p>
              {onRefresh ? <Button size="sm" disabled={refreshing} onClick={onRefresh}>Read original send inputs</Button> : null}</>}</> : null}
      </div>
    }} />}
    {unresolved.map((record) => record.command?.kind === 'send' ? <MessageBubble key={record.command.input.requestId} role="user" author="You"
      status={<Badge tone={record.status === 'pending' ? 'neutral' : 'warning'}>{record.status === 'pending' ? 'Sending' : 'Unknown'}</Badge>}>
      <p className="conversation-message-content">{record.command.input.content}</p>
      <p className="agent-chat-note">{record.status === 'pending' ? 'Waiting for the server receipt.' : 'No receipt was confirmed. The original may have been accepted; it will not be resent automatically.'}</p>
      {!readOnly && record.status === 'error' ? <Button size="sm" disabled={!!resendUnavailable(record.command.input.content)}
        title={resendUnavailable(record.command.input.content)} onClick={() => {
        if (record.command?.kind === 'send') {
          onSendAgain(record.command.input.content, record.command.input.attachments, record.command.input.sessionMode)
        }
      }}>Send again as new message</Button> : null}
    </MessageBubble> : null)}
    {!readOnly && state.pendingInteraction ? <><p className="agent-chat-note">Use these approval controls to reply. An ordinary chat message is not an approval.</p>
      <OperatorApprovalCard actor="Agent" interaction={state.pendingInteraction} onBrowse={onBrowse}
        disabled={!!responseReason || !approvalReplyAvailable(state)} onSelect={onRespond} />
      {responseReason || !approvalReplyAvailable(state) ? <p role="status">{responseReason ?? 'The original native request is not available. Refresh; do not reply through chat.'}</p> : null}
    </> : null}
  </>}</ConversationViewport>
}
