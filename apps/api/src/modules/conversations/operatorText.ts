import type { NativeHarnessEvent } from '@graphql/contracts'

type ObjectValue = Record<string, unknown>
function object(value: unknown): ObjectValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {} }
/** Presentation-only. These events never become authoritative persisted assistant messages. */
export function nativeAssistantText(event: NativeHarnessEvent): Array<{ partId: string; text: string; mode: 'append' | 'replace' }> {
  const payload = event.payload
  const method = typeof payload.nativeMethod === 'string' ? payload.nativeMethod : event.type
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
    return [{ partId: String(payload.partID ?? 'assistant'), text: payload.delta, mode: 'append' }]
  }
  const part = object(payload.part)
  if (event.type === 'message.part.updated' && part.type === 'text' && typeof part.text === 'string' && !part.ignored) {
    return [{ partId: String(part.id ?? 'assistant'), text: part.text, mode: 'replace' }]
  }
  return []
}
