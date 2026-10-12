import type pg from 'pg'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import {
  AgentChatExecutionActivityPageSchema, type AgentChatExecutionActivityPage, type AgentChatExecutionItem,
  type AgentChatExecutionSummary,
} from '@foreman-code/contracts/agent-chat'
import { z } from 'zod'
import { nativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { operatorActivity } from './operatorActivity.js'

const MAX_EXECUTIONS = 20
const PAGE_BYTES = 256 * 1024
const CACHED_EXECUTIONS = 16
/** Live pages carry previews; an item read returns the full bounded bodies. */
const PREVIEW = { message: 16_384, input: 2_000, output: 4_000 }
const FULL = { message: 65_536, input: 16_000, output: 24_000 }
type Limits = typeof PREVIEW

interface ExecutionRow {
  id: string; attempt: number; tick_index: number | null; occurrence_index: string | null; state: AgentChatExecutionSummary['state']
  native_session_id: string | null; created_at: Date; started_at: string | null; finished_at: string | null; revision: number
}
export interface ExecutionEventRow {
  sequence: number; item_key: string
  record: { type?: unknown; payload?: unknown; occurredAt?: unknown; connectionId?: unknown }
}
type Payload = Record<string, unknown>
export interface ExecutionActivityScope { workspaceId: string; workflowId: string; runId: string; workflowNodeId: string; agentId: string }
export interface ExecutionActivityRequest {
  cursor?: string | undefined; executionId?: string | undefined; before?: string | undefined; itemId?: string | undefined; limit?: number | undefined
}

const executionsSql = `select e.id,e.attempt,e.tick_index,e.record#>>'{input,occurrence,identity,occurrenceIndex}' as occurrence_index,
  e.record->>'state' as state,e.record->>'nativeSessionId' as native_session_id,e.created_at,
  e.record->>'startedAt' as started_at,e.record->>'finishedAt' as finished_at,
  coalesce((select max(n.sequence) from harness_native_events n where n.execution_id=e.id),0) as revision
  from harness_executions e join runs r on r.id=e.run_id
  where e.run_id=$1 and e.workflow_node_id=$2 and e.agent_id=$3 and r.workspace_id=$4 and r.workflow_id=$5
  order by e.created_at desc,e.id desc limit ${MAX_EXECUTIONS + 1}`

// Public events of the execution's own session only, after the folded sequence. Child-agent
// sessions stay behind their subagent rows. Native events of one execution commit in sequence order.
const eventsSql = `select n.sequence,n.record,
    case when n.record#>>'{payload,nativeMethod}'='turn/plan/updated' then 'plan:'||coalesce(n.record#>>'{payload,turnId}','')
      when n.record->>'type'='claude.task' then 'task:'||(n.record#>>'{payload,taskId}')
      when n.record->>'type' in ('session.compaction','session.compacted') then 'compaction:'||coalesce(
        n.record#>>'{payload,nativeOperationId}',n.record#>>'{payload,nativeEventId}',n.sequence::text)
      else coalesce(n.record#>>'{payload,item,id}',n.record#>>'{payload,itemId}') end as item_key
  from harness_native_events n
  where n.execution_id=$1 and n.sequence>$3 and n.record->>'type'<>'native.unlinked_notification'
    and n.record#>>'{payload,subagentNativeId}' is null
    and n.record#>>'{payload,parentToolUseId}' is null
    and coalesce(n.record->>'subagent','false')<>'true'
    and ($2::text is null or coalesce(n.record#>>'{payload,nativeSessionId}',n.record#>>'{payload,threadId}',$2)=$2)
  order by n.sequence`

const CursorSchema = z.record(z.string().min(1), z.string().regex(/^(0|[1-9][0-9]{0,18})$/))
function parseCursor(value: string | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined
  try { return CursorSchema.parse(JSON.parse(value)) } catch { return undefined }
}
const object = (value: unknown): Payload => value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : {}
const text = (value: unknown) => typeof value === 'string' ? value : ''
const STREAMED_METHODS = ['item/commandExecution/outputDelta', 'item/reasoning/summaryTextDelta', 'item/plan/delta']

function label(row: ExecutionRow) {
  const attempt = row.attempt > 1 ? ` · attempt ${row.attempt}` : ''
  if (row.tick_index !== null) return `Interval check ${row.tick_index}${attempt}`
  if (row.occurrence_index !== null) return `Occurrence ${row.occurrence_index}${attempt}`
  return row.attempt > 1 ? `Attempt ${row.attempt}` : 'Execution'
}
function isMessageEvent(type: string, payload: Payload) {
  return ['item.started', 'item.completed'].includes(type) && ['agentMessage', 'userMessage'].includes(text(object(payload.item).type))
    || type === 'assistant.delta' || type === 'claude.text' || payload.nativeMethod === 'item/agentMessage/delta'
}
function messageText(payload: Payload) {
  const item = object(payload.item)
  if (item.type === 'userMessage') return (Array.isArray(item.content) ? item.content : []).map(object)
    .filter((part) => part.type === 'text').map((part) => text(part.text)).join('')
  return text(item.text) || text(payload.text) || text(payload.delta)
}
/** Keeps at most `limit` characters while counting everything that was appended. */
function append(previous: { value: string; length: number }, next: string, limit: number) {
  return { value: previous.value.length >= limit ? previous.value : (previous.value + next).slice(0, limit), length: previous.length + next.length }
}

type Activity = NonNullable<ReturnType<typeof operatorActivity>>
interface Entry {
  key: string; sequence: number; revision: number; occurredAt?: string
  message?: { role: 'user' | 'assistant'; content: { value: string; length: number }; complete: boolean; originalBytes: number }
  activity?: Activity; streamed: { value: string; length: number }
}

/** Incremental public projection of one execution's native events. Exported for behavior tests. */
export class ExecutionActivityFold {
  sequence = -1
  private readonly entries = new Map<string, Entry>()

  apply(rows: readonly ExecutionEventRow[]) {
    for (const row of rows) {
      if (row.sequence <= this.sequence) continue
      this.sequence = row.sequence
      const type = text(row.record.type), payload = object(row.record.payload)
      if (!row.item_key) continue
      const message = isMessageEvent(type, payload)
      const key = message && payload.contentIndex !== undefined ? `${row.item_key}#${String(payload.contentIndex)}` : row.item_key
      let entry = this.entries.get(key)
      if (!entry) {
        entry = { key, sequence: row.sequence, revision: row.sequence, streamed: { value: '', length: 0 },
          ...(typeof row.record.occurredAt === 'string' ? { occurredAt: row.record.occurredAt } : {}) }
        this.entries.set(key, entry)
      }
      if (message) this.foldMessage(entry, type, payload)
      else if (!this.foldActivity(entry, row, type, payload)) continue
      entry.revision = row.sequence
    }
  }

  private foldMessage(entry: Entry, type: string, payload: Payload) {
    const current = entry.message ??= { role: 'assistant', content: { value: '', length: 0 }, complete: false, originalBytes: 0 }
    if (object(payload.item).type === 'userMessage' || payload.role === 'user') current.role = 'user'
    const truncation = object(payload.truncation)
    if (typeof truncation.originalBytes === 'number') current.originalBytes = Math.max(current.originalBytes, truncation.originalBytes)
    if (current.complete) return
    const final = type === 'item.completed' || type === 'claude.text' && payload.final === true
    const replaces = type === 'item.started' || final || payload.operation === 'replace'
    current.content = append(replaces ? { value: '', length: 0 } : current.content, messageText(payload), FULL.message)
    current.complete = final
  }

  private foldActivity(entry: Entry, row: ExecutionEventRow, type: string, payload: Payload): boolean {
    const method = text(payload.nativeMethod)
    if (method === 'turn/plan/updated') {
      const steps = (Array.isArray(payload.plan) ? payload.plan : []).map(object)
        .map((step) => `${step.status === 'completed' ? '[x]' : step.status === 'inProgress' ? '[~]' : '[ ]'} ${text(step.step)}`)
      entry.activity = { id: entry.key, requestId: text(payload.turnId) || 'plan', kind: 'tool', title: 'Update plan', status: 'completed',
        output: [text(payload.explanation), ...steps].filter(Boolean).join('\n') }
      return true
    }
    if (STREAMED_METHODS.includes(method)) { entry.streamed = append(entry.streamed, text(payload.delta), FULL.output); return true }
    const item = object(payload.item)
    if (item.type === 'plan' && ['item.started', 'item.completed'].includes(type)) {
      entry.activity = { id: text(item.id), requestId: text(payload.turnId) || 'plan', kind: 'tool', title: 'Plan',
        status: type === 'item.completed' ? 'completed' : 'running', ...(text(item.text) ? { output: text(item.text) } : {}) }
      return true
    }
    const event: NativeHarnessEvent = { sequence: row.sequence, type, payload,
      occurredAt: typeof row.record.occurredAt === 'string' ? row.record.occurredAt : new Date(0).toISOString(),
      ...(typeof row.record.connectionId === 'string' ? { connectionId: row.record.connectionId } : {}) }
    const next = operatorActivity(event, type.startsWith('claude.') ? 'claude' : 'codex', text(payload.turnId) || 'execution')
    if (!next) return false
    // Show an MCP result's text parts, not its protocol envelope.
    const parts = Array.isArray(object(item.result).content) ? (object(item.result).content as unknown[]).map(object) : []
    const resultText = item.type === 'mcpToolCall' && item.error == null
      ? parts.filter((part) => part.type === 'text').map((part) => text(part.text)).join('\n') : ''
    // A shell row names its command, so the collapsed one-line row says what ran.
    const command = item.type === 'commandExecution' && next.title === 'Run command'
      ? (Array.isArray(item.commandActions) ? item.commandActions.map(object).map((action) => text(action.command)).filter(Boolean).join(' && ') : '')
        || text(item.command) : ''
    entry.activity = { ...next, ...(resultText ? { output: resultText.slice(0, FULL.output) } : {}),
      ...(command ? { title: command.replace(/\s+/g, ' ').slice(0, 240) } : {}) }
    return true
  }

  /** Public items, oldest first. */
  items(executionId: string, terminal: boolean, limits: Limits = PREVIEW): AgentChatExecutionItem[] {
    const redactor = nativePersistenceRedactor([])
    const items: AgentChatExecutionItem[] = []
    for (const entry of this.entries.values()) {
      const base = { executionId, id: entry.key, sequence: String(entry.sequence), revision: String(entry.revision),
        ...(entry.occurredAt ? { occurredAt: entry.occurredAt } : {}) }
      if (entry.message) {
        const { role, content, complete, originalBytes } = entry.message
        const safe = redactor.text(content.value).slice(0, limits.message)
        const total = Math.max(originalBytes, content.length)
        items.push({ ...base, entry: { kind: 'message', message: { id: JSON.stringify([executionId, entry.key]), role, content: safe,
          sequence: base.sequence, revision: base.revision, nativeMessageComplete: complete,
          ...(entry.occurredAt ? { createdAt: entry.occurredAt } : {}),
          ...(total > safe.length ? { truncation: { truncated: true, originalBytes: Math.max(total, Buffer.byteLength(safe)) } } : {}) } } })
        continue
      }
      let activity = entry.activity
      if (!activity) continue
      const live = activity.status !== 'completed' && !activity.output && entry.streamed.length > 0
      if (live) activity = { ...activity, output: entry.streamed.value, ...(entry.streamed.length > entry.streamed.value.length ? { truncated: true } : {}) }
      // Empty reasoning items carry no public summary.
      if (activity.kind === 'thinking' && !activity.output) continue
      const status = terminal && (activity.status === 'running' || activity.status === 'pending') ? 'unknown' : activity.status
      const input = activity.input === undefined ? undefined : redactor.text(activity.input)
      const output = activity.output === undefined ? undefined : redactor.text(activity.output)
      const truncated = activity.truncated || (input?.length ?? 0) > limits.input || (output?.length ?? 0) > limits.output
      items.push({ ...base, entry: { kind: 'activity', activity: { id: activity.id, kind: activity.kind,
        title: redactor.text(activity.title).slice(0, 240), status,
        ...(input !== undefined ? { input: input.slice(0, limits.input) } : {}),
        ...(output !== undefined ? { output: output.slice(0, limits.output) } : {}),
        ...(truncated ? { truncated: true } : {}) } } })
    }
    return items.sort((a, b) => Number(a.sequence) - Number(b.sequence))
  }
}

function byteSize(item: AgentChatExecutionItem) {
  const entry = item.entry
  return entry.kind === 'message' ? entry.message.content.length + 256
    : (entry.activity.input?.length ?? 0) + (entry.activity.output?.length ?? 0) + entry.activity.title.length + 256
}
function takeNewest(items: readonly AgentChatExecutionItem[], limit: number, budget: number) {
  const window: AgentChatExecutionItem[] = []
  for (let index = items.length - 1; index >= 0 && window.length < limit; index -= 1) {
    const size = byteSize(items[index]!)
    if (size > budget && window.length > 0) break
    window.unshift(items[index]!); budget -= size
  }
  return window
}

/** Shared by HTTP and MCP readers. Folds are cached per execution so live reads scan only new events. */
export class ExecutionActivityReader {
  private readonly folds = new Map<string, { sessionId: string | null; fold: ExecutionActivityFold; pending: Promise<void> }>()
  constructor(private readonly sql: Pick<pg.Pool, 'query'>) {}

  private async fold(row: ExecutionRow) {
    let cached = this.folds.get(row.id)
    if (!cached || cached.sessionId !== row.native_session_id) {
      cached = { sessionId: row.native_session_id, fold: new ExecutionActivityFold(), pending: Promise.resolve() }
    }
    this.folds.delete(row.id); this.folds.set(row.id, cached)
    while (this.folds.size > CACHED_EXECUTIONS) this.folds.delete(this.folds.keys().next().value!)
    const entry = cached
    if (entry.fold.sequence < row.revision) {
      entry.pending = entry.pending.catch(() => undefined).then(async () => {
        if (entry.fold.sequence >= row.revision) return
        entry.fold.apply((await this.sql.query<ExecutionEventRow>(eventsSql, [row.id, row.native_session_id, entry.fold.sequence])).rows)
        // Skipped non-public events still advance the fold.
        entry.fold.sequence = Math.max(entry.fold.sequence, row.revision)
      })
    }
    await entry.pending
    return entry.fold
  }

  async read(scope: ExecutionActivityScope, request: ExecutionActivityRequest): Promise<AgentChatExecutionActivityPage> {
    const limit = request.limit ?? 200
    const rows = (await this.sql.query<ExecutionRow>(executionsSql,
      [scope.runId, scope.workflowNodeId, scope.agentId, scope.workspaceId, scope.workflowId])).rows
    const hasEarlierExecutions = rows.length > MAX_EXECUTIONS
    const newest = rows.slice(0, MAX_EXECUTIONS)
    const summaries = new Map<string, AgentChatExecutionSummary>(newest.map((row) => [row.id, {
      executionId: row.id, label: label(row), attempt: row.attempt, ...(row.tick_index !== null ? { tickIndex: row.tick_index } : {}),
      state: row.state, createdAt: row.created_at.toISOString(),
      ...(row.started_at ? { startedAt: row.started_at } : {}), ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      revision: String(row.revision),
    }]))
    const terminal = (row: ExecutionRow) => ['completed', 'failed', 'canceled', 'interrupted'].includes(row.state)
    const items = async (row: ExecutionRow, limits?: Limits) => (await this.fold(row)).items(row.id, terminal(row), limits)
    const page = (mode: AgentChatExecutionActivityPage['mode'], list: AgentChatExecutionItem[], extra: Partial<AgentChatExecutionActivityPage> = {}) =>
      AgentChatExecutionActivityPageSchema.parse({ mode, executions: [...summaries.values()].reverse(), hasEarlierExecutions,
        items: list, hasMoreChanges: false, ...extra })

    if (request.executionId) {
      const row = newest.find((entry) => entry.id === request.executionId)
      if (!row) return page(request.itemId ? 'item' : 'earlier', [])
      if (request.itemId) return page('item', (await items(row, FULL)).filter((item) => item.id === request.itemId))
      const before = request.before === undefined ? Infinity : Number(request.before)
      const all = (await items(row)).filter((item) => Number(item.sequence) < before)
      const window = takeNewest(all, limit, PAGE_BYTES)
      summaries.set(row.id, { ...summaries.get(row.id)!, hasEarlierItems: window.length < all.length })
      return page('earlier', window)
    }

    const cursor = parseCursor(request.cursor)
    const next: Record<string, string> = {}
    const list: AgentChatExecutionItem[] = []
    let budget = PAGE_BYTES, remaining = limit, hasMoreChanges = false
    // Newest execution first, so the live one is never starved by older history.
    for (const row of newest) {
      const known = cursor?.[row.id]
      if (known !== undefined && row.revision <= Number(known)) { next[row.id] = known; continue }
      if (known !== undefined) {
        // Changes, oldest first; the cursor advances only past what this page includes.
        const changed = (await items(row)).filter((item) => Number(item.revision) > Number(known))
          .sort((a, b) => Number(a.revision) - Number(b.revision))
        let advanced = known, partial = false
        for (const item of changed) {
          const size = byteSize(item)
          if (remaining === 0 || size > budget && list.length > 0) { partial = true; break }
          list.push(item); budget -= size; remaining -= 1; advanced = item.revision
        }
        hasMoreChanges ||= partial
        next[row.id] = partial ? advanced : String(row.revision)
        continue
      }
      next[row.id] = String(row.revision)
      if (remaining === 0) { summaries.set(row.id, { ...summaries.get(row.id)!, hasEarlierItems: row.revision > 0 }); continue }
      const all = await items(row)
      const window = takeNewest(all, remaining, budget)
      for (const item of window) { budget -= byteSize(item); remaining -= 1 }
      list.push(...window)
      summaries.set(row.id, { ...summaries.get(row.id)!, hasEarlierItems: window.length < all.length })
    }
    const order = new Map(newest.map((row, index) => [row.id, newest.length - index]))
    list.sort((a, b) => order.get(a.executionId)! - order.get(b.executionId)! || Number(a.sequence) - Number(b.sequence))
    return page(cursor ? 'changes' : 'snapshot', list, { cursor: JSON.stringify(next), hasMoreChanges })
  }
}
