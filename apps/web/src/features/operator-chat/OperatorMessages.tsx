import type { Message, OperatorActivity } from '@graphql/contracts'
import { ChatMessageFiles } from '../conversations/ChatMessageFiles'
import { MessageBubble } from '../../shared/ui/nocturne'
import { OperatorActivityList } from './OperatorActivityList'
import { OperatorThinking } from './OperatorThinking'
import { operatorTextPartKey, type OperatorTextProjection } from './operatorTextProjection'

/** Allocate activity once over the complete loaded message sequence. */
export function OperatorMessages({ messages, activities, activeRequestId, working = false, partialText = '', thinkingText = '', parts, timeline, onBrowse }: {
  messages: Message[]; activities: OperatorActivity[]; activeRequestId?: string | null; working?: boolean;
  partialText?: string; thinkingText?: string; parts?: Record<string, string>; timeline?: OperatorTextProjection; onBrowse(): void;
}) {
  const reasoning = messages.filter((message) => message.activityChannel === 'reasoning')
  messages = messages.filter((message) => message.activityChannel !== 'reasoning')
  const partKey = (message: Message) => message.activityNative ? operatorTextPartKey(message.activityNative, message.activityChannel) : message.nativeMessageId
  const rows: Array<{ key: string; message?: Message; requestId?: string; live?: boolean }> = []
  const lastAssistant = new Map<string, Message>()
  const assistantCounts = new Map<string, number>()
  for (const message of messages) if (message.role === 'assistant' && message.requestId) lastAssistant.set(message.requestId, message)
  for (const message of messages) {
    const requestId = message.requestId
    const prior = requestId ? assistantCounts.get(requestId) ?? 0 : 0
    rows.push({ key: message.role === 'assistant' && requestId
      ? prior === 0 ? `assistant:${requestId}` : `assistant:${requestId}:${message.id}` : message.id,
      message, requestId })
    if (message.role === 'assistant' && requestId) {
      assistantCounts.set(requestId, prior + 1)
      // Failed/canceled turns have no final assistant reply. Their unassigned
      // activity remains beside this turn, not hidden or moved to a later one.
      if (requestId !== activeRequestId && lastAssistant.get(requestId) === message
        && message.afterActivitySequence !== undefined
        && activities.some((entry) => entry.requestId === requestId && BigInt(entry.sequence) > BigInt(message.afterActivitySequence!))) {
        rows.push({ key: `assistant:${requestId}:tail`, requestId })
      }
    }
    if (message.role === 'user' && requestId && !lastAssistant.has(requestId)
      && (activities.some((entry) => entry.requestId === requestId)
        || requestId === activeRequestId && (working || partialText))) {
      rows.push({ key: `assistant:${requestId}`, requestId, live: requestId === activeRequestId })
    }
  }
  const lastSavedBoundary = activeRequestId ? lastAssistant.get(activeRequestId)?.afterActivitySequence : undefined
  if (activeRequestId && (working || partialText || activities.some((entry) => entry.requestId === activeRequestId
    && (lastSavedBoundary === undefined ? !assistantCounts.has(activeRequestId) : BigInt(entry.sequence) > BigInt(lastSavedBoundary))))
    && !rows.some((row) => row.live && row.requestId === activeRequestId)) {
    rows.push({ key: assistantCounts.has(activeRequestId) ? `assistant:${activeRequestId}:live` : `assistant:${activeRequestId}`,
      requestId: activeRequestId, live: true })
  }
  const lastActivity = new Map<string, bigint>()
  return <ol className="operator-messages" aria-label="Conversation history">
    {reasoning.map((message) => <li key={message.id}><OperatorThinking text={message.content} onBrowse={onBrowse} /></li>)}
    {rows.map(({ key, message, requestId, live }) => {
      const role = message?.role ?? 'assistant'
      const assistant = role === 'assistant'
      const active = Boolean(requestId === activeRequestId && (live || message?.nativeMessageComplete === false))
      const priorActivity = requestId ? lastActivity.get(requestId) ?? -1n : -1n
      const boundary = message?.afterActivitySequence === undefined ? undefined : BigInt(message.afterActivitySequence)
      const entries = assistant ? activities.filter((entry) => entry.requestId === requestId
        && BigInt(entry.sequence) > priorActivity && (live || boundary === undefined || BigInt(entry.sequence) <= boundary)) : []
      if (assistant && requestId) lastActivity.set(requestId,
        boundary ?? entries.reduce((max, entry) => BigInt(entry.sequence) > max ? BigInt(entry.sequence) : max, priorActivity))
      const savedIds = new Set(messages.filter((entry) => entry.requestId === requestId && entry.nativeMessageId).map(partKey))
      const nativePartKey = message ? partKey(message) : undefined
      const streamed = nativePartKey && message?.nativeMessageComplete === false && active ? parts?.[nativePartKey] : undefined
      const content = streamed !== undefined && (timeline?.finalParts?.[nativePartKey ?? ''] || streamed.startsWith(message?.content ?? '')) ? streamed : message?.content
      let orderedTimeline: OperatorTextProjection['timeline'] | undefined
      if (assistant && timeline && timeline.requestId === requestId && timeline.timeline.length) {
        if (live) orderedTimeline = timeline.timeline.filter((item) => item.kind === 'activity'
          ? entries.some((entry) => entry.id === item.id) : !savedIds.has(item.partId))
        else if (content) {
          const nativePart = nativePartKey
          const hasPart = timeline.timeline.some((item) => item.kind === 'text' && item.partId === nativePart)
          const candidate = timeline.timeline.filter((item) => item.kind === 'activity'
            ? entries.some((entry) => entry.id === item.id)
            : hasPart ? item.partId === nativePart : assistantCounts.get(requestId ?? '') === 1)
          if (candidate.filter((item) => item.kind === 'text').map((item) => item.text).join('') === content) orderedTimeline = candidate
        }
      }
      const placed = orderedTimeline ? new Set(orderedTimeline.filter((entry) => entry.kind === 'activity').map((entry) => entry.id)) : undefined
      if (!content && !entries.length && !active && !orderedTimeline?.length && !message?.attachments?.length) return null
      return <li key={key} data-message-role={role}>
        <div aria-label={active ? 'Assistant response in progress' : undefined}>
          <MessageBubble author={assistant ? 'Assistant' : role === 'user' ? 'You' : role} role={assistant ? 'assistant' : role === 'user' ? 'user' : 'system'}>
            {assistant ? <>
              <OperatorActivityList entries={placed ? entries.filter((entry) => !placed.has(entry.id)) : entries} activeRequestId={activeRequestId} parts={parts} onBrowse={onBrowse} />
              {live && thinkingText && !entries.some((entry) => entry.kind === 'thinking') ? <OperatorThinking text={thinkingText} onBrowse={onBrowse} /> : null}
              {orderedTimeline ? orderedTimeline.map((item) => item.kind === 'activity'
                ? <OperatorActivityList key={item.id} entries={entries.filter((entry) => entry.id === item.id)} activeRequestId={activeRequestId} parts={parts} onBrowse={onBrowse} />
                : <div className="operator-answer" key={item.id}><p className="conversation-message-content">{item.text}</p></div>) : null}
            </> : null}
            {!orderedTimeline && (content || live && (partialText || working)) ? <div className={assistant ? 'operator-answer' : undefined}>
              {content || live && partialText ? <p className="conversation-message-content">{content || partialText}</p> : null}
              {live && working && !partialText ? <div className="operator-chat-typing" role="status" aria-label="Operator is typing"><span /><span /><span /><span className="n-sr-only">Operator is typing…</span></div> : null}
            </div> : null}
            {orderedTimeline && live && working && !partialText ? <div className="operator-chat-typing" role="status" aria-label="Operator is typing"><span /><span /><span /><span className="n-sr-only">Operator is typing…</span></div> : null}
            {message?.attachments?.length ? <ChatMessageFiles message={message} /> : null}
          </MessageBubble>
        </div>
      </li>
    })}
  </ol>
}
