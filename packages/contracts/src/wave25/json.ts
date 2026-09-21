/** Canonical, bounded COMPLETE JSON. Never evaluates text or emits a truncated prefix. */
export function canonicalGraphJson(value: unknown, maxBytes = 8 * 1024 * 1024): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('GRAPH_JSON_LIMIT')
  const seen = new Set<object>(), pieces: string[] = []
  const encoder = new TextEncoder()
  let visited = 0, bytes = 0
  const push = (text: string) => {
    bytes += encoder.encode(text).byteLength
    if (bytes > maxBytes) throw new Error('GRAPH_JSON_LIMIT')
    pieces.push(text)
  }
  const string = (text: string) => {
    // Each UTF-16 code unit needs at least one byte in its JSON representation.
    if (text.length > maxBytes - bytes) throw new Error('GRAPH_JSON_LIMIT')
    push(JSON.stringify(text))
  }
  const visit = (item: unknown, depth: number): void => {
    if (depth > 32 || ++visited > 100_000) throw new Error('GRAPH_JSON_LIMIT')
    if (item === null) { push('null'); return }
    if (typeof item === 'string') { string(item); return }
    if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) { push(JSON.stringify(item)); return }
    if (typeof item !== 'object' || !item || seen.has(item)) throw new Error('GRAPH_JSON_INVALID')
    if (Object.getOwnPropertySymbols(item).length) throw new Error('GRAPH_JSON_INVALID')
    seen.add(item)
    if (Array.isArray(item)) {
      if (item.length > 100_000 - visited) throw new Error('GRAPH_JSON_LIMIT')
      // No holes, getters, hidden values or non-index fields silently omitted.
      if (Object.keys(item).length !== item.length || Object.getOwnPropertyNames(item).length !== item.length + 1) throw new Error('GRAPH_JSON_INVALID')
      push('[')
      for (let i = 0; i < item.length; i++) {
        if (i) push(',')
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i))
        if (!descriptor || !('value' in descriptor)) throw new Error('GRAPH_JSON_INVALID')
        visit(descriptor.value, depth + 1)
      }
      push(']')
    } else {
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) throw new Error('GRAPH_JSON_INVALID')
      const keys = Object.keys(item).sort()
      if (keys.length > 100_000 - visited) throw new Error('GRAPH_JSON_LIMIT')
      if (Object.getOwnPropertyNames(item).length !== keys.length) throw new Error('GRAPH_JSON_INVALID')
      push('{')
      keys.forEach((key, index) => {
        if (index) push(',')
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor || !('value' in descriptor)) throw new Error('GRAPH_JSON_INVALID')
        string(key); push(':'); visit(descriptor.value, depth + 1)
      })
      push('}')
    }
    seen.delete(item)
  }
  visit(value, 0)
  return pieces.join('')
}

export function graphJsonBytes(value: unknown): number {
  try { return new TextEncoder().encode(canonicalGraphJson(value)).byteLength } catch { return Infinity }
}
