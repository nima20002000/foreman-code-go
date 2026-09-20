import type { Message, OperatorActivity } from '@graphql/contracts'
import { MessageBubble } from '../../shared/ui/nocturne'
import { OperatorActivityList } from './OperatorActivityList'
import { OperatorThinking } from './OperatorThinking'
import type { OperatorTextProjection } from './operatorTextProjection'

/** Activity belongs to the assistant turn, including before its first text arrives. */
export function OperatorMessages({ messages, activities, activeRequestId, working = false, partialText = '', thinkingText = '', parts, timeline, onBrowse }: {
  messages: Message[]; activities: OperatorActivity[]; activeRequestId?: string | null; working?: boolean;
  partialText?: string; thinkingText?: string; parts?: Record<string, string>; timeline?: OperatorTextProjection; onBrowse(): void;
}) {
  const rows: Array<{ key: string; message?: Message; requestId?: string; live?: boolean }> = []
  const assistantCounts = new Map<string, number>()
  const answered = new Set(messages.filter((message) => message.role === 'assistant').map((message) => message.requestId))
  for (const message of messages) {
    const prior = message.requestId ? assistantCounts.get(message.requestId) ?? 0 : 0
    rows.push({ key: message.role === 'assistant' && message.requestId
      ? prior === 0 ? `assistant:${message.requestId}` : `assistant:${message.requestId}:${message.id}` : message.id,
      message, requestId: message.requestId })
    if (message.role === 'assistant' && message.requestId) assistantCounts.set(message.requestId, prior + 1)
    if (message.role === 'user' && message.requestId && !answered.has(message.requestId)
      && (activities.some((entry) => entry.requestId === message.requestId)
        || message.requestId === activeRequestId && (working || partialText)))
      rows.push({ key: `assistant:${message.requestId}`, requestId: message.requestId,
        live: message.requestId === activeRequestId })
  }
  const lastSavedBoundary = messages.filter((message) => message.role === 'assistant' && message.requestId === activeRequestId).at(-1)?.afterActivitySequence
  if (activeRequestId && (working || partialText || activities.some((entry) => entry.requestId === activeRequestId
    && (lastSavedBoundary === undefined ? !assistantCounts.has(activeRequestId) : BigInt(entry.sequence) > BigInt(lastSavedBoundary))))
    && !rows.some((row) => row.live && row.requestId === activeRequestId))
    rows.push({ key: assistantCounts.has(activeRequestId) ? `assistant:${activeRequestId}:live` : `assistant:${activeRequestId}`,
      requestId: activeRequestId, live: true })
  const lastActivity = new Map<string, bigint>()
  return <ol className="operator-messages" aria-label="Conversation history">
    {rows.map(({ key, message, requestId, live }) => {
      const role = message?.role ?? 'assistant'
      const assistant = role === 'assistant'
      const active = Boolean(live && requestId === activeRequestId)
      const priorActivity = requestId ? lastActivity.get(requestId) ?? -1n : -1n
      const boundary = message?.afterActivitySequence === undefined ? undefined : BigInt(message.afterActivitySequence)
      const entries = assistant ? activities.filter((entry) => entry.requestId === requestId
        && BigInt(entry.sequence) > priorActivity && (live || boundary === undefined || BigInt(entry.sequence) <= boundary)) : []
      if (assistant && requestId && message) lastActivity.set(requestId,
        boundary ?? activities.filter((entry) => entry.requestId === requestId).reduce((max, entry) => BigInt(entry.sequence) > max ? BigInt(entry.sequence) : max, priorActivity))
      const savedIds = new Set(messages.filter((entry) => entry.requestId === requestId && entry.nativeMessageId).map((entry) => entry.nativeMessageId))
      const orderedTimeline = assistant && timeline && requestId && timeline.requestId === requestId && timeline.timeline.length > 0
        ? active ? timeline.timeline.filter((item) => item.kind === 'activity'
          ? entries.some((entry) => entry.id === item.id) : !savedIds.has(item.partId))
          : !message?.nativeMessageId && message?.content
            && timeline.timeline.filter((item) => item.kind === 'text').map((item) => item.text).join('') === message.content ? timeline.timeline : undefined
        : undefined
      const placed = orderedTimeline ? new Set(orderedTimeline.filter((entry) => entry.kind === 'activity').map((entry) => entry.id)) : undefined
      return <li key={key} data-message-role={role}>
        <div aria-label={active ? 'Assistant response in progress' : undefined}>
          <MessageBubble author={assistant ? 'Assistant' : role === 'user' ? 'You' : role} role={assistant ? 'assistant' : role === 'user' ? 'user' : 'system'}>
            {assistant ? <>
              <OperatorActivityList entries={placed ? entries.filter((entry) => !placed.has(entry.id)) : entries} activeRequestId={activeRequestId} parts={parts} onBrowse={onBrowse} />
              {active && thinkingText && !entries.some((entry) => entry.kind === 'thinking') ? <OperatorThinking text={thinkingText} onBrowse={onBrowse} /> : null}
              {orderedTimeline ? orderedTimeline.map((item) => item.kind === 'activity'
                ? <OperatorActivityList key={item.id} entries={entries.filter((entry) => entry.id === item.id)} activeRequestId={activeRequestId} parts={parts} onBrowse={onBrowse} />
                : <div className="operator-answer" key={item.id}><p className="conversation-message-content">{item.text}</p></div>) : null}
            </> : null}
            {!orderedTimeline && (message?.content || active && (partialText || working)) ? <div className={assistant ? 'operator-answer' : undefined}>
              {message?.content || active && partialText ? <p className="conversation-message-content">{message?.content || partialText}</p> : null}
              {active && working && !partialText ? <div className="operator-chat-typing" role="status" aria-label="Operator is typing"><span /><span /><span /><span className="n-sr-only">Operator is typing…</span></div> : null}
            </div> : null}
            {orderedTimeline && active && working && !partialText ? <div className="operator-chat-typing" role="status" aria-label="Operator is typing"><span /><span /><span /><span className="n-sr-only">Operator is typing…</span></div> : null}
          </MessageBubble>
        </div>
      </li>
    })}
  </ol>
}
