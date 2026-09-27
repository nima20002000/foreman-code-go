import type { AgentChatState } from '@graphql/contracts/agent-chat'
import type { Message } from '@graphql/contracts'
import { Badge, Button, MessageBubble } from '../../../shared/ui/nocturne'
import { OperatorActivityList } from '../../operator-chat/OperatorActivityList'
import { OperatorApprovalCard } from '../../operator-chat/OperatorApprovalCard'
import { ConversationHistory } from '../ConversationHistory'
import { ConversationViewport } from '../ConversationViewport'
import { approvalReplyAvailable, deliveryLabels, intentLabels, mergeChatMessages } from './model'
import { placeChatActivities } from './activityPlacement'
import { commandMayHaveBeenAccepted, type AgentChatCommandRecord, type useAgentChat } from './useAgentChat'

export function AgentChatTranscript({ state, name, commands, history, cancelReason, responseReason, resendReason, onCancel, onRespond, onSendAgain }: {
  state: AgentChatState; name: string; commands: AgentChatCommandRecord[]; history: ReturnType<typeof useAgentChat>['history']
  cancelReason?: string; responseReason?: string; resendReason?: string
  onCancel(requestId: string): void; onRespond(optionId: string): void; onSendAgain(content: string): void
}) {
  const id = state.conversation?.id
  const messages = mergeChatMessages(...[...(history.data?.pages.flatMap((batch) => batch.pages) ?? [])].reverse().map((page) => page.messages), state.messages)
  const receipts = new Map(state.turns.map((turn) => [turn.messageId, turn]))
  // Every nonterminal receipt is in state, but its text can lie outside the bounded message cut.
  const orphaned = state.turns.filter((turn) => !messages.some((message) => message.id === turn.messageId))
  const unresolved = commands.filter((record) => record.command?.kind === 'send'
    && (record.status === 'pending' || record.status === 'error' && commandMayHaveBeenAccepted(record.error))
    && !state.turns.some((turn) => record.command?.kind === 'send' && turn.requestId === record.command.input.requestId))
  const status = (message: Message) => {
    const receipt = receipts.get(message.id)
    if (message.role === 'assistant') return message.nativeMessageComplete === false ? <Badge>Reply in progress</Badge> : null
    if (message.role !== 'user') return null
    return receipt ? <span className="agent-chat-delivery" data-delivery={receipt.delivery}>
      <Badge tone={receipt.delivery === 'unknown' ? 'warning' : receipt.delivery === 'failed' ? 'danger' : 'neutral'}>{deliveryLabels[receipt.delivery]}</Badge>
      <span>{intentLabels[receipt.intent]}</span>
    </span> : <span className="agent-chat-note">Delivery receipt not included in this history page.</span>
  }
  // Only genuine server-provided public activities are shown. No timers, percentages, private
  // reasoning, or synthetic "thinking" strings. Unknown delta payloads only trigger state reads.
  const activities = state.activities.filter((entry) => entry.kind !== 'thinking')
  const placement = placeChatActivities(messages, activities, state.activeTurn?.requestId)
  const revision = JSON.stringify([state.messages, state.turns, activities, state.pendingInteraction, unresolved.map((record) => [record.command, record.status])])
  return <ConversationViewport revision={revision}>{(onBrowse) => <>
    {id && (state.hasEarlierMessages && !history.data || history.hasNextPage) ? <Button size="sm" variant="ghost" disabled={history.isFetching}
      onClick={() => { onBrowse(); void history.fetchNextPage() }}>Load earlier messages</Button> : null}
    {history.isError ? <p role="alert">Earlier messages could not be loaded. <Button size="sm" disabled={history.isFetching}
      onClick={() => { onBrowse(); void history.fetchNextPage() }}>Retry history</Button></p> : null}
    {orphaned.length ? <section className="agent-chat-orphaned-turns" aria-label="Messages outside the current history page">
      {orphaned.map((turn) => {
        const original = commands.find((record) => record.command?.kind === 'send' && record.command.input.requestId === turn.requestId)?.command
        const content = original?.kind === 'send' ? original.input.content : undefined
        return <div key={turn.requestId} className="agent-chat-message-actions" data-delivery={turn.delivery}>
          <p><Badge tone={turn.delivery === 'unknown' ? 'warning' : turn.delivery === 'failed' ? 'danger' : 'neutral'}>{deliveryLabels[turn.delivery]}</Badge> {intentLabels[turn.intent]} · order {turn.sequence}</p>
          <p className="agent-chat-note">{turn.delivery === 'unknown' && content
            ? 'Message text is outside the current history page. Your locally submitted text is shown below.'
            : 'Message text is not included in the current history page. Load earlier messages to read it.'}</p>
          {turn.error ? <p className="agent-chat-note">{turn.error.message}</p> : null}
          {turn.delivery === 'queued' ? <><Button size="sm" disabled={!!cancelReason} title={cancelReason} onClick={() => onCancel(turn.requestId)}>Cancel queued message</Button>
            {cancelReason ? <p className="agent-chat-note">{cancelReason}</p> : null}</> : null}
          {turn.delivery === 'unknown' ? <><p className="agent-chat-note">Delivery is unknown. No automatic resend. Read the original text before explicitly sending it as a new message.</p>
            {content ? <><p className="conversation-message-content">{content}</p>
              <Button size="sm" disabled={!!resendReason} title={resendReason} onClick={() => onSendAgain(content)}>Send again as new message</Button></> : null}
          </> : null}
        </div>
      })}
    </section> : null}
    <OperatorActivityList entries={placement.earlier} onBrowse={onBrowse} />
    <ConversationHistory messages={messages} assistantName={name} renderStatus={status}
      renderBefore={(message) => <OperatorActivityList entries={placement.before.get(message.id) ?? []} activeRequestId={state.activeTurn?.requestId} onBrowse={onBrowse} />}
      renderAfter={(message) => <OperatorActivityList entries={placement.after.get(message.id) ?? []} activeRequestId={state.activeTurn?.requestId} onBrowse={onBrowse} />}
      renderActions={(message) => {
      const turn = receipts.get(message.id)
      if (message.role !== 'user' || !turn) return null
      return <div className="agent-chat-message-actions">
        {turn.delivery === 'accepted' ? <p className="agent-chat-note">Provider acknowledged delivery; consumption is not yet confirmed.</p> : null}
        {turn.error ? <p className="agent-chat-note">{turn.error.message}</p> : null}
        {turn.delivery === 'queued' ? <><Button size="sm" disabled={!!cancelReason} title={cancelReason} onClick={() => onCancel(turn.requestId)}>Cancel queued message</Button>
          {cancelReason ? <p className="agent-chat-note">{cancelReason}</p> : null}</> : null}
        {turn.delivery === 'unknown' ? <><p className="agent-chat-note">The original may have been accepted. It will not be resent automatically.</p>
          <Button size="sm" disabled={!!resendReason} title={resendReason} onClick={() => onSendAgain(message.content)}>Send again as new message</Button></> : null}
      </div>
    }} />
    {unresolved.map((record) => record.command?.kind === 'send' ? <MessageBubble key={record.command.input.requestId} role="user" author="You"
      status={<Badge tone={record.status === 'pending' ? 'neutral' : 'warning'}>{record.status === 'pending' ? 'Sending' : 'Unknown'}</Badge>}>
      <p className="conversation-message-content">{record.command.input.content}</p>
      <p className="agent-chat-note">{record.status === 'pending' ? 'Waiting for the server receipt.' : 'No receipt was confirmed. The original may have been accepted; it will not be resent automatically.'}</p>
      {record.status === 'error' ? <Button size="sm" disabled={!!resendReason} title={resendReason} onClick={() => { if (record.command?.kind === 'send') onSendAgain(record.command.input.content) }}>Send again as new message</Button> : null}
    </MessageBubble> : null)}
    <OperatorActivityList entries={placement.trailing} activeRequestId={state.activeTurn?.requestId} onBrowse={onBrowse} />
    {state.pendingInteraction ? <><p className="agent-chat-note">Use these approval controls to reply. An ordinary chat message is not an approval.</p>
      <OperatorApprovalCard actor="Agent" interaction={state.pendingInteraction} onBrowse={onBrowse}
        disabled={!!responseReason || !approvalReplyAvailable(state)} onSelect={onRespond} />
      {responseReason || !approvalReplyAvailable(state) ? <p role="status">{responseReason ?? 'The original native request is not available. Refresh; do not reply through chat.'}</p> : null}
    </> : null}
  </>}</ConversationViewport>
}
