import { createHash } from 'node:crypto'

import type { ExecutionResult, NativeHarnessEvent, OpenCodeHarnessConfiguration } from '@graphql/contracts'

export type JsonObject = Record<string, unknown>
export interface OpenCodeEvent extends JsonObject { id?: string; type: string; properties?: JsonObject; sseId?: string }
export interface OpenCodeMessage extends JsonObject { info: JsonObject; parts: JsonObject[] }
export const OPENCODE_HISTORY_PAGE_SIZE = 64
export const OPENCODE_EVENT_LIMIT = 256
export const OPENCODE_EVENT_BYTES = 512_000
export const OPENCODE_ID_LIMIT = 512
const MAX_FRAME_BYTES = 2_000_000

export function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

export function nativeMessageId(correlation: string): string {
  return `msg_${createHash('sha256').update(correlation).digest('hex').slice(0, 24)}`
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function nativePolicy(configuration: OpenCodeHarnessConfiguration): JsonObject[] {
  return [
    ...(configuration.advanced?.permissionRules ?? []).map((rule) => ({
      permission: rule.permission === 'shell' ? 'bash' : rule.permission === 'subagent' ? 'task' : rule.permission,
      pattern: rule.pattern, action: rule.effect,
    })),
    // This transport exposes approvals, not questions. OpenCode's native LLM request preparation
    // removes tools denied by the final ordered session policy; never auto-answer.
    { permission: 'question', pattern: '*', action: 'deny' },
  ]
}

export function providerSupports(value: unknown, providerID: string, modelID: string, variant: string): boolean {
  const providers = Array.isArray(value) ? value : object(value).all
  if (!Array.isArray(providers)) return false
  const provider = providers.find((item) => object(item).id === providerID)
  const model = object(object(provider).models)[modelID]
  if (!model || typeof model !== 'object') return false
  // Empty string is the explicit Product representation of no named variant.
  return variant === '' || Object.hasOwn(object(object(model).variants), variant)
}

/** JSONC accepts comments and trailing commas, but never executable JavaScript. */
export function parseConfigObject(source: string): JsonObject {
  let clean = ''
  let quoted = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    const next = source[index + 1]
    if (quoted) {
      clean += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') {
      quoted = true
      clean += char
    } else if (char === '/' && next === '/') {
      while (index + 1 < source.length && !'\r\n'.includes(source[index + 1]!)) index += 1
      clean += ' '
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end < 0) throw new Error('Unterminated JSONC comment.')
      clean += ' '
      index = end + 1
    } else clean += char
  }
  let json = ''
  quoted = false
  escaped = false
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index]!
    if (quoted) {
      json += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') {
      quoted = true
      json += char
    } else if (char === ',' && /^[\s]*[}\]]/.test(clean.slice(index + 1))) {
      json += ' '
    } else json += char
  }
  const parsed: unknown = JSON.parse(json.replace(/^\uFEFF/, ''))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a configuration object.')
  return parsed as JsonObject
}

export function configurationPermissionRules(value: unknown): { permission: string; pattern: string; effect: string }[] {
  if (typeof value === 'string') return [{ permission: '*', pattern: '*', effect: value }]
  if (Array.isArray(value)) return value.map((item) => {
    const rule = object(item)
    return { permission: String(rule.permission), pattern: String(rule.pattern), effect: String(rule.action ?? rule.effect) }
  })
  const rules: { permission: string; pattern: string; effect: string }[] = []
  // Object insertion order is meaningful to native last-match-wins permissions.
  for (const [permission, patterns] of Object.entries(object(value))) {
    if (typeof patterns === 'string') rules.push({ permission, pattern: '*', effect: patterns })
    else for (const [pattern, effect] of Object.entries(object(patterns))) {
      if (typeof effect === 'string') rules.push({ permission, pattern, effect })
    }
  }
  return rules
}

/** Only call with unexpanded configuration, never resolved secret header values. */
export function credentialReferences(source: JsonObject): Readonly<Record<string, string>> {
  const references: Record<string, string> = {}
  for (const [name, value] of Object.entries(object(source.mcp))) {
    const matches = Object.values(object(object(value).headers)).flatMap((header) => {
      if (typeof header !== 'string') return []
      return Array.from(header.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g), (match) => match[1]!)
    })
    if (matches.length === 1) references[name] = matches[0]!
  }
  return references
}

export function eventSessionId(event: OpenCodeEvent): string | undefined {
  const props = object(event.properties)
  const id = props.sessionID ?? object(props.info).sessionID ?? object(props.part).sessionID
  return typeof id === 'string' ? id : undefined
}

export function boundedSetAdd(set: Set<string>, value: string, maximum = OPENCODE_ID_LIMIT): void {
  set.delete(value)
  set.add(value)
  while (set.size > maximum) set.delete(set.values().next().value!)
}

export function boundedMapSet<T>(map: Map<string, T>, key: string, value: T, maximum = OPENCODE_ID_LIMIT): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > maximum) map.delete(map.keys().next().value!)
}

/** Unknown deltas after a stream gap are hidden until authoritative part identity is known. */
export function visibleNativeEvent(event: OpenCodeEvent, thinking: boolean, partTypes: Map<string, string>): boolean {
  const props = object(event.properties)
  const part = object(props.part)
  if (typeof part.id === 'string' && typeof part.type === 'string') boundedMapSet(partTypes, part.id, part.type)
  if (thinking) return true
  if (part.type === 'reasoning' || /reasoning|thinking/.test(event.type)) return false
  if (event.type === 'message.part.delta') {
    const type = typeof props.partID === 'string' ? partTypes.get(props.partID) : undefined
    return type !== undefined && type !== 'reasoning'
  }
  return true
}

export function normalizedHistory(messages: OpenCodeMessage[], thinking: boolean): NativeHarnessEvent[] {
  const result: NativeHarnessEvent[] = []
  for (const message of messages) {
    const created = object(message.info.time).created
    const occurredAt = new Date(typeof created === 'number' ? created : 0).toISOString()
    const id = String(message.info.id)
    const messageEventId = `message:${id}:${digest(message.info)}`
    result.push({ connectionId: `history-${digest(messageEventId)}`, sequence: 0, type: 'message.updated', occurredAt,
      payload: { info: message.info, nativeEventId: messageEventId } })
    for (const part of message.parts) {
      if (!thinking && part.type === 'reasoning') continue
      const partEventId = `part:${String(part.id)}:${digest(part)}`
      result.push({ connectionId: `history-${digest(partEventId)}`, sequence: 0, type: 'message.part.updated', occurredAt,
        payload: { part, nativeEventId: partEventId } })
    }
  }
  return result
}

export function failure(code: string, message: string): ExecutionResult {
  return { outcome: 'failed', error: { code, message, retryable: false } }
}

function hasPendingTools(message: OpenCodeMessage): boolean {
  return message.parts.some((part) => part.type === 'tool' && ['pending', 'running'].includes(String(object(part.state).status)))
}

function assistantResult(message: OpenCodeMessage | undefined): ExecutionResult | undefined {
  if (!message) return undefined
  const info = message.info
  if (info.error) {
    const error = object(info.error)
    const data = object(error.data)
    return { outcome: 'failed', error: {
      code: typeof error.name === 'string' ? error.name : 'OPENCODE_TURN_FAILED',
      message: typeof data.message === 'string' ? data.message : 'OpenCode turn failed.',
      retryable: data.isRetryable === true,
    } }
  }
  if (info.summary === true || typeof object(info.time).completed !== 'number'
    || typeof info.finish !== 'string' || ['tool-calls', 'unknown', 'error'].includes(info.finish)) return undefined
  if (hasPendingTools(message)) return undefined
  return { outcome: 'succeeded', output: { text: message.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string' && part.ignored !== true)
    .map((part) => part.text as string).join('') } }
}

function replayParts(message: OpenCodeMessage, stripMedia = false): string {
  return JSON.stringify(message.parts.filter((part) => part.type !== 'compaction').map((part) => {
    const content = { ...part } as Record<string, unknown>
    delete content.id
    delete content.sessionID
    delete content.messageID
    delete content.time
    // Pinned overflow replay replaces image/PDF attachments with a native text marker.
    if (stripMedia && part.type === 'file' && (String(part.mime).startsWith('image/') || part.mime === 'application/pdf')) {
      return { type: 'text', text: `[Attached ${String(part.mime)}: ${String(part.filename ?? 'file')}]` }
    }
    return content
  }))
}

/** Reverse, page-at-a-time reconciliation. Holds only the latest candidate, not turn history. */
export class OpenCodeTurnHistory {
  private latest: OpenCodeMessage | undefined
  private continuation: OpenCodeMessage | undefined
  private haveContinuation = false
  private needsCompaction: 'continue' | 'replay' | undefined
  private invalidChain = false
  private pendingTools = false
  rooted = false
  result: ExecutionResult | undefined
  resultMessageId: string | undefined
  constructor(private readonly root: OpenCodeMessage) {}

  push(message: OpenCodeMessage): boolean {
    const info = message.info
    if (info.role === 'assistant') {
      // The newest assistant matters even if incomplete; never fall back to an older completion.
      this.latest ??= message
      if (hasPendingTools(message)) this.pendingTools = true
      return false
    }
    if (info.role !== 'user') return false
    if (info.id === this.root.info.id) {
      this.rooted = true
      if (this.latest && this.latest.info.parentID !== info.id) this.invalidChain = true
      if (!this.invalidChain && !this.needsCompaction && !this.pendingTools) {
        const answer = this.haveContinuation ? this.continuation : this.latest
        this.result = assistantResult(answer)
        this.resultMessageId = this.result && typeof answer?.info.id === 'string' ? answer.info.id : undefined
      }
      return true
    }
    if (this.latest && this.latest.info.parentID !== info.id) this.invalidChain = true
    const compaction = message.parts.find((part) => part.type === 'compaction' && part.auto === true)
    const synthetic = message.parts.some((part) => part.type === 'text' && part.synthetic === true
      && object(part.metadata).compaction_continue === true)
    const parts = replayParts(message)
    const replay = parts === replayParts(this.root) || parts === replayParts(this.root, true)
    if (compaction) {
      if (this.needsCompaction === 'replay' && compaction.overflow !== true) this.invalidChain = true
      if (!this.haveContinuation) {
        this.continuation = this.latest
        this.haveContinuation = true
      }
      this.needsCompaction = undefined
    } else if (synthetic || replay) {
      if (this.needsCompaction) this.invalidChain = true
      if (!this.haveContinuation) {
        this.continuation = this.latest
        this.haveContinuation = true
      }
      this.needsCompaction = synthetic ? 'continue' : 'replay'
    } else {
      // A different real user turn is not a continuation of the requested turn.
      this.continuation = undefined
      this.haveContinuation = false
      this.needsCompaction = undefined
      this.invalidChain = false
      this.pendingTools = false
    }
    this.latest = undefined
    return false
  }
}

/** Streaming SSE line parser: CR, LF, CRLF and UTF-8 may all cross read boundaries. */
export async function* parseOpenCodeSse(
  stream: ReadableStream<Uint8Array>, signal?: AbortSignal, heartbeatMs = 90_000,
): AsyncIterable<OpenCodeEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let data: string[] = []
  let eventId: string | undefined
  let frameBytes = 0
  let swallowLf = false
  const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined) }
  signal?.addEventListener('abort', abort, { once: true })
  const frame = (line: string): OpenCodeEvent | undefined => {
    if (line === '') {
      const payload = data.join('\n')
      data = []
      frameBytes = 0
      if (!payload) return undefined
      try {
        const value = object(JSON.parse(payload))
        if (typeof value.type !== 'string') return undefined
        return { ...value, type: value.type, ...(eventId === undefined ? {} : { sseId: eventId }) } as OpenCodeEvent
      } catch { return undefined }
    }
    if (line.startsWith(':')) return undefined
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    if (field === 'id' && !value.includes('\0')) eventId = value
    return undefined
  }
  try {
    while (true) {
      signal?.throwIfAborted()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('OpenCode event heartbeat timed out.')); void reader.cancel().catch(() => undefined) }, heartbeatMs)
      })
      let chunk: ReadableStreamReadResult<Uint8Array>
      try { chunk = await Promise.race([reader.read(), timeout]) } finally { clearTimeout(timer) }
      signal?.throwIfAborted()
      if (chunk.done) return
      const text = decoder.decode(chunk.value, { stream: true })
      for (const char of text) {
        if (swallowLf) { swallowLf = false; if (char === '\n') continue }
        if (char === '\r' || char === '\n') {
          const event = frame(pending)
          pending = ''
          swallowLf = char === '\r'
          if (event) yield event
        } else {
          pending += char
          frameBytes += char.length
          if (frameBytes > MAX_FRAME_BYTES) throw new Error('OpenCode SSE frame exceeds the bounded transport buffer.')
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
