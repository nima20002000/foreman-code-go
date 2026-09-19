import type { Message, OperatorActivity } from '@graphql/contracts'
import { MessageBubble } from '../../shared/ui/nocturne'
import { OperatorActivityList } from './OperatorActivityList'
import { OperatorThinking } from './OperatorThinking'

/** Activity belongs to the assistant turn, including before its first text arrives. */
export function OperatorMessages({ messages, activities, activeRequestId, working = false, partialText = '', thinkingText = '', parts, onBrowse }: {
  messages: Message[]; activities: OperatorActivity[]; activeRequestId?: string | null; working?: boolean;
  partialText?: string; thinkingText?: string; parts?: Record<string, string>; onBrowse(): void;
}) {
  const answered = new Set(messages.filter((message) => message.role === 'assistant').map((message) => message.requestId))
  const rows: Array<{ key: string; message?: Message; requestId?: string }> = []
  for (const message of messages) {
    rows.push({ key: message.role === 'assistant' && message.requestId ? `assistant:${message.requestId}` : message.id, message, requestId: message.requestId })
    if (message.role === 'user' && message.requestId && !answered.has(message.requestId)
      && (activities.some((entry) => entry.requestId === message.requestId) || message.requestId === activeRequestId && (working || partialText))) {
      rows.push({ key: `assistant:${message.requestId}`, requestId: message.requestId })
    }
  }
  if ((working || partialText) && !rows.some((row) => row.key === `assistant:${activeRequestId}`)) rows.push({ key: `assistant:${activeRequestId}`, requestId: activeRequestId ?? undefined })
  return <ol className="operator-messages" aria-label="Conversation history">
    {rows.map(({ key, message, requestId }) => {
      const role = message?.role ?? 'assistant'
      const assistant = role === 'assistant'
      const active = assistant && requestId === activeRequestId && !message
      const entries = assistant ? activities.filter((entry) => entry.requestId === requestId) : []
      return <li key={key} data-message-role={role}>
        <div aria-label={active ? 'Assistant response in progress' : undefined}>
          <MessageBubble author={assistant ? 'Assistant' : role === 'user' ? 'You' : role} role={assistant ? 'assistant' : role === 'user' ? 'user' : 'system'}>
            {assistant ? <>
              <OperatorActivityList entries={entries} activeRequestId={activeRequestId} parts={parts} onBrowse={onBrowse} />
              {active && thinkingText && !entries.some((entry) => entry.kind === 'thinking') ? <OperatorThinking text={thinkingText} onBrowse={onBrowse} /> : null}
            </> : null}
            {message?.content || active && (partialText || working) ? <div className={assistant ? 'operator-answer' : undefined}>
              {message?.content || active && partialText ? <p className="conversation-message-content">{message?.content || partialText}</p> : null}
              {active && working && !partialText ? <div className="operator-chat-typing" role="status" aria-label="Operator is typing"><span /><span /><span /><span className="n-sr-only">Operator is typing…</span></div> : null}
            </div> : null}
          </MessageBubble>
        </div>
      </li>
    })}
  </ol>
}
