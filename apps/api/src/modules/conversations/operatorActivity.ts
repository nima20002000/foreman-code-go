import { claudeConversationActivity } from '../harnesses/claudeSdk/conversationActivity.js'
import type { AgentHarness, NativeHarnessEvent, OperatorActivity } from '@foreman-code/contracts'
import type { NativeHistory } from '../harnesses/port.js'

type RecordValue = Record<string, unknown>
export type OperatorActivityChange = Omit<OperatorActivity, 'sequence' | 'revision'>
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const string = (value: unknown) => typeof value === 'string' ? value : ''
const pretty = (value: unknown): string => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2)
function status(value: unknown, completed: boolean): OperatorActivity['status'] {
  if (['failed', 'error', 'declined'].includes(String(value))) return 'failed'
  if (['canceled', 'cancelled', 'interrupted'].includes(String(value))) return 'canceled'
  if (['completed', 'success'].includes(String(value))) return 'completed'
  if (value === 'pending') return 'pending'
  if (['inProgress', 'running'].includes(String(value))) return 'running'
  return completed ? 'completed' : 'running'
}
function bounded(value: OperatorActivityChange): OperatorActivityChange {
  const truncated = (value.input?.length ?? 0) > 16000 || (value.output?.length ?? 0) > 24000
  return { ...value, title: value.title.slice(0, 240),
    ...(value.input !== undefined ? { input: value.input.slice(0, 16000) } : {}),
    ...(value.output !== undefined ? { output: value.output.slice(0, 24000) } : {}),
    ...(truncated ? { truncated: true } : {}) }
}
const collabNames: Record<string, string> = {
  spawnAgent: 'Start subagent', sendInput: 'Message subagent', sendMessage: 'Message subagent',
  resumeAgent: 'Resume subagent', followupTask: 'Give subagent a task', wait: 'Wait for subagent',
  closeAgent: 'Close subagent', interruptAgent: 'Stop subagent', listAgents: 'List subagents',
}

/** Replayed history and child-session output must not become this turn's answer or activity. */
export function openCodeTurnEvents(sessionId: string, turnId: () => string | null) {
  const messages = new Map<string, boolean>()
  const pending = new Map<string, { event: NativeHarnessEvent; message: string; order: number; bytes: number }[]>()
  let parent = turnId(), count = 0, bytes = 0, order = 0
  const discard = (message: string): NativeHarnessEvent[] => {
    const entries = []
    for (const [key, parts] of pending) {
      if (parts[0]?.message !== message) continue
      pending.delete(key)
      for (const part of parts) { count--; bytes -= part.bytes; entries.push(part) }
    }
    return entries.sort((a, b) => a.order - b.order).map(entry => entry.event)
  }
  return (event: NativeHarnessEvent): NativeHarnessEvent[] => {
    if (turnId() !== parent) { messages.clear(); pending.clear(); count = 0; bytes = 0; parent = turnId() }
    if (!event.type.startsWith('message.')) return [event]
    const info = object(event.payload.info)
    if (event.type === 'message.updated') {
      if (info.sessionID !== sessionId || typeof info.id !== 'string') return []
      const message = JSON.stringify([sessionId, info.id])
      const owned = parent !== null && info.role === 'assistant' && info.summary !== true && info.parentID === parent
      messages.set(message, owned)
      if (messages.size > 256) messages.delete(messages.keys().next().value!)
      const parts = discard(message)
      return owned ? parts : []
    }
    const part = object(event.payload.part)
    const nativeSessionId = string(part.sessionID ?? event.payload.sessionID)
    const messageId = string(part.messageID ?? event.payload.messageID)
    const partId = string(part.id ?? event.payload.partID)
    if (nativeSessionId !== sessionId || !messageId || !partId
      || !['message.part.updated', 'message.part.delta'].includes(event.type)) return []
    const message = JSON.stringify([nativeSessionId, messageId])
    if (messages.has(message)) return messages.get(message) ? [event] : []
    const size = Buffer.byteLength(JSON.stringify(event))
    if (size > 256 * 1024) return []
    while (count >= 256 || bytes + size > 256 * 1024) {
      // Evict an entire pending part, preserving the order of every retained part.
      const first = pending.keys().next().value
      if (!first) break
      for (const value of pending.get(first)!) { count--; bytes -= value.bytes }
      pending.delete(first)
    }
    const key = JSON.stringify([nativeSessionId, messageId, partId])
    const parts = pending.get(key) ?? []
    parts.push({ event: structuredClone(event), message, order: order++, bytes: size })
    pending.set(key, parts); count++; bytes += size
    return []
  }
}

/** Classify only structured native evidence. Opaque shell scripts remain commands. */
export function operatorActivity(event: NativeHarnessEvent, harness: AgentHarness, requestId: string): OperatorActivityChange | undefined {
  if (harness === 'claude') return claudeConversationActivity(event, requestId)
  const payload = event.payload
  if (harness === 'codex' && ['item.started', 'item.completed', 'item.snapshot'].includes(event.type)) {
    const item = object(payload.item)
    const id = string(item.id)
    if (!id) return
    const base = { id, requestId, status: status(item.status, event.type === 'item.completed' || payload.nativeTurnStatus === 'completed') }
    switch (item.type) {
      case 'reasoning': {
        // Only the provider's public summary, never encrypted or raw reasoning content.
        const summary = Array.isArray(item.summary) ? item.summary.filter((value): value is string => typeof value === 'string').join('\n\n') : ''
        return bounded({ ...base, kind: 'thinking', title: 'Thinking', ...(summary ? { output: summary } : {}) })
      }
      case 'commandExecution': {
        const actions = Array.isArray(item.commandActions) ? item.commandActions.map(object) : []
        const read = actions.find((action) => ['read', 'listFiles', 'search'].includes(String(action.type)))
        const title = read?.type === 'read' ? `Read ${string(read.name) || string(read.path) || 'file'}`
          : read?.type === 'search' ? 'Search files' : read?.type === 'listFiles' ? 'List files' : 'Run command'
        return bounded({ ...base, kind: read ? 'file_read' : 'tool', title,
          input: pretty({ command: item.command, cwd: item.cwd }),
          ...(typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput } : {}) })
      }
      case 'fileChange': return bounded({ ...base, kind: 'file_write', title: 'Change files', input: pretty(item.changes) })
      case 'mcpToolCall': return bounded({ ...base, kind: 'mcp', title: `${string(item.server)} · ${string(item.tool)}`,
        status: item.error ? 'failed' : base.status, input: pretty(item.arguments), ...(item.error != null || item.result != null ? { output: pretty(item.error ?? item.result) } : {}) })
      case 'webSearch': {
        const action = object(item.action)
        return bounded({ ...base, kind: 'web_search', title: action.type === 'openPage' ? 'Open webpage' : action.type === 'findInPage' ? 'Find in webpage' : 'Search the web',
          input: pretty(item.action ?? item.query), ...(item.results != null ? { output: pretty(item.results) } : {}) })
      }
      case 'collabAgentToolCall': return bounded({ ...base, kind: 'subagent', title: collabNames[string(item.tool)] ?? 'Subagent activity',
        input: pretty({ prompt: item.prompt, model: item.model, effort: item.reasoningEffort, agents: item.receiverThreadIds }), output: pretty(item.agentsStates) })
      case 'dynamicToolCall': return bounded({ ...base, kind: 'tool', title: string(item.tool) || 'Use tool',
        status: item.success === false ? 'failed' : base.status, input: pretty(item.arguments), ...(item.contentItems != null ? { output: pretty(item.contentItems) } : {}) })
      default: return
    }
  }
  if (harness === 'opencode' && event.type === 'message.part.updated') {
    const part = object(payload.part)
    const id = string(part.id)
    if (!id) return
    if (part.type === 'reasoning') return bounded({ id, requestId, kind: 'thinking', title: 'Thinking',
      status: typeof object(part.time).end === 'number' ? 'completed' : 'running',
      ...(typeof part.text === 'string' ? { output: part.text } : {}) })
    if (part.type !== 'tool') return
    const state = object(part.state)
    const tool = string(part.tool)
    let kind: OperatorActivity['kind'] = 'tool'
    let title = string(state.title) || tool || 'Use tool'
    if (['read', 'glob', 'grep', 'list'].includes(tool)) { kind = 'file_read'; title = tool === 'read' ? 'Read file' : tool === 'grep' ? 'Search files' : 'List files' }
    else if (['write', 'edit', 'apply_patch', 'multiedit'].includes(tool)) { kind = 'file_write'; title = tool === 'write' ? 'Write file' : 'Edit files' }
    else if (['websearch', 'webfetch', 'codesearch'].includes(tool)) { kind = 'web_search'; title = tool === 'webfetch' ? 'Read webpage' : 'Search the web' }
    else if (tool === 'task') { kind = 'subagent'; title = string(object(state.input).description) || 'Run subagent' }
    else if (tool === 'bash') title = 'Run command'
    else if (/^(graphql[-_]operator|graphql[-_]app)[_]/.test(tool)) { kind = 'mcp'; title = tool }
    return bounded({ id, requestId, kind, title, status: status(state.status, false), input: pretty(state.input),
      ...(state.output != null || state.error != null ? { output: pretty(state.error ?? state.output) } : {}) })
  }
  return undefined
}

/** A resumed session can contain older turns. Never relabel their activity as this request. */
export function currentOperatorHistory(history: NativeHistory, harness: AgentHarness): NativeHarnessEvent[] {
  if (!history.nativeTurnId) return []
  if (harness === 'codex') return history.events.filter((event) => event.payload.turnId === history.nativeTurnId)
  const messages = new Map<string, boolean>()
  for (const event of history.events) {
    const info = object(event.payload.info)
    if (info.role === 'assistant' && info.summary !== true && info.parentID === history.nativeTurnId && typeof info.id === 'string') {
      messages.set(info.id, typeof object(info.time).completed === 'number' || Boolean(history.terminalResult))
    }
  }
  const parts = new Map<string, NativeHarnessEvent>()
  for (const event of history.events.filter((entry) => messages.has(string(object(entry.payload.part).messageID)))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    const part = object(event.payload.part)
    if (typeof part.id !== 'string') continue
    const prior = parts.get(part.id)
    // Keep first insertion order while replacing a partial snapshot by the
    // newest full snapshot. A completed text part cannot be downgraded.
    const priorPart = object(prior?.payload.part)
    if (typeof object(priorPart.time).end === 'number' && typeof object(part.time).end !== 'number') continue
    parts.set(part.id, event)
  }
  return [...parts.values()].map((event) => ({ ...event, payload: { ...event.payload,
    nativeMessageCompleted: messages.get(string(object(event.payload.part).messageID)) === true } }))
}
