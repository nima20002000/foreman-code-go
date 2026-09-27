import type { Message, OperatorActivity } from '@graphql/contracts'

/** Keep old activity beside its request, not below every later reply. Public sequence
 * boundaries take precedence; completed-message fallback uses the matching last reply. */
export function placeChatActivities(messages: readonly Message[], activities: readonly OperatorActivity[], activeRequestId?: string) {
  const before = new Map<string, OperatorActivity[]>(), after = new Map<string, OperatorActivity[]>()
  const earlier: OperatorActivity[] = [], trailing: OperatorActivity[] = []
  for (const entry of activities) {
    const related = messages.filter((message) => message.requestId === entry.requestId)
    const replies = related.filter((message) => message.role === 'assistant')
    const lastReply = replies.at(-1)
    const target = replies.find((message) => message.afterActivitySequence !== undefined
      && BigInt(message.afterActivitySequence) >= BigInt(entry.sequence))
      ?? (lastReply?.afterActivitySequence === undefined ? lastReply : undefined)
    const anchor = target ?? related.at(-1)
    if (anchor) {
      const placement = target ? before : after
      placement.set(anchor.id, [...(placement.get(anchor.id) ?? []), entry])
    } else if (entry.requestId === activeRequestId) trailing.push(entry)
    else earlier.push(entry)
  }
  return { before, after, earlier, trailing }
}
