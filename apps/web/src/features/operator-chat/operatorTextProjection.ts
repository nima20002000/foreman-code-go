export type OperatorTimelineEntry = { kind: 'activity'; id: string } | { kind: 'text'; id: string; partId: string; text: string }
export interface OperatorTextProjection { requestId: string; parts: Record<string, string>; timeline: OperatorTimelineEntry[] }

export function projectOperatorActivity(previous: OperatorTextProjection | undefined, activeRequestId: string | null,
  requestId: string, id: string): OperatorTextProjection | undefined {
  if (!activeRequestId || requestId !== activeRequestId) return previous
  const current = previous?.requestId === requestId ? previous : { requestId, parts: {}, timeline: [] }
  if (current.timeline.some((entry) => entry.kind === 'activity' && entry.id === id)) return current
  return { ...current, timeline: [...current.timeline, { kind: 'activity', id }] }
}
export function projectOperatorText(previous: OperatorTextProjection | undefined, activeRequestId: string | null,
  data: Record<string, unknown>): OperatorTextProjection | undefined {
  if (!activeRequestId || data.requestId !== activeRequestId || typeof data.text !== 'string'
    || typeof data.partId !== 'string' || !['append', 'replace'].includes(String(data.mode))) return previous
  const current = previous?.requestId === activeRequestId ? previous : { requestId: activeRequestId, parts: {}, timeline: [] }
  const before = current.parts[data.partId] ?? ''
  const after = data.mode === 'replace' ? data.text : before + data.text
  let timeline = current.timeline
  if (!data.partId.startsWith('thinking:') && before !== after) {
    if (!after.startsWith(before)) timeline = timeline.filter((entry) => entry.kind !== 'text' || entry.partId !== data.partId)
    const addition = after.startsWith(before) ? after.slice(before.length) : after
    const last = timeline.at(-1)
    timeline = last?.kind === 'text' && last.partId === data.partId
      ? [...timeline.slice(0, -1), { ...last, text: last.text + addition }]
      : [...timeline, { kind: 'text', id: `${data.partId}:${timeline.length}`, partId: data.partId, text: addition }]
  }
  return { requestId: activeRequestId, parts: { ...current.parts, [data.partId]: after }, timeline }
}
