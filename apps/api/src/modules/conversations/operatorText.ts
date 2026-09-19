import type { NativeHarnessEvent } from '@graphql/contracts'

type ObjectValue = Record<string, unknown>
function object(value: unknown): ObjectValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {} }
/** Presentation-only. These events never become authoritative persisted assistant messages. */
export function nativeAssistantText(event: NativeHarnessEvent, partKinds = new Map<string, string>()): Array<{ partId: string; text: string; mode: 'append' | 'replace' }> {
  const payload = event.payload
  const method = typeof payload.nativeMethod === 'string' ? payload.nativeMethod : event.type
  if (method === 'item/reasoning/summaryTextDelta' && typeof payload.delta === 'string') {
    return [{ partId: `thinking:${String(payload.itemId ?? 'reasoning')}`, text: payload.delta, mode: 'append' }]
  }
  if (method === 'item/agentMessage/delta' && typeof payload.delta === 'string') {
    return [{ partId: String(payload.itemId ?? 'assistant'), text: payload.delta, mode: 'append' }]
  }
  if (event.type === 'assistant.delta' && typeof payload.text === 'string') {
    return [{ partId: String(payload.itemId ?? 'assistant'), text: payload.text, mode: 'append' }]
  }
  const item = object(payload.item)
  if (event.type === 'item.completed' && item.type === 'agentMessage' && typeof item.text === 'string') {
    return [{ partId: String(item.id ?? 'assistant'), text: item.text, mode: 'replace' }]
  }
  if (event.type === 'message.part.delta' && payload.field === 'text' && typeof payload.delta === 'string') {
    const id = String(payload.partID ?? 'assistant')
    return [{ partId: `${partKinds.get(id) === 'reasoning' ? 'thinking:' : ''}${id}`, text: payload.delta, mode: 'append' }]
  }
  const part = object(payload.part)
  if (typeof part.id === 'string' && typeof part.type === 'string') partKinds.set(part.id, part.type)
  if (event.type === 'message.part.updated' && part.type === 'reasoning' && typeof part.text === 'string') {
    return [{ partId: `thinking:${String(part.id ?? 'reasoning')}`, text: part.text, mode: 'replace' }]
  }
  if (event.type === 'message.part.updated' && part.type === 'text' && typeof part.text === 'string' && !part.ignored) {
    return [{ partId: String(part.id ?? 'assistant'), text: part.text, mode: 'replace' }]
  }
  return []
}
