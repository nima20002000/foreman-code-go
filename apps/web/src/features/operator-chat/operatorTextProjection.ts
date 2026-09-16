export interface OperatorTextProjection { requestId: string; parts: Record<string, string> }
export function projectOperatorText(previous: OperatorTextProjection | undefined, activeRequestId: string | null,
  data: Record<string, unknown>): OperatorTextProjection | undefined {
  if (!activeRequestId || data.requestId !== activeRequestId || typeof data.text !== 'string'
    || typeof data.partId !== 'string' || !['append', 'replace'].includes(String(data.mode))) return previous
  const parts = previous?.requestId === activeRequestId ? previous.parts : {}
  return { requestId: activeRequestId, parts: { ...parts,
    [data.partId]: data.mode === 'replace' ? data.text : (parts[data.partId] ?? '') + data.text } }
}
