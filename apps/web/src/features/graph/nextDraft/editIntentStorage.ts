import { z } from 'zod'
import { AgentSchema } from '@graphql/contracts'
import { ManagedAgentSchema } from '@graphql/contracts/management'
import { GraphDraftV2Schema, GraphEditStageInputSchema, WorkflowDefinitionV2Schema, sameWorkflowValue,
  type GraphEditStageInput } from '@graphql/contracts/wave25'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { assertSession, sessionGeneration, sessionIsSwitching, SessionChangedError } from '../../../shared/api/sessionBoundary'
import { nextDraftKey, type NextDraftEdit } from './state'

const prefix = 'graph-edit-intent:'
const SnapshotSchema = z.object({
  context: z.object({ draft: GraphDraftV2Schema, agents: z.array(ManagedAgentSchema) }).strict(),
  graph: WorkflowDefinitionV2Schema, agentEdits: z.record(z.string(), AgentSchema).optional(),
}).strict()
const OutboxSchema = z.object({ request: GraphEditStageInputSchema, target: WorkflowDefinitionV2Schema,
  agentTarget: z.record(z.string(), AgentSchema).optional() }).strict()
export type EditIntentOutbox = z.infer<typeof OutboxSchema>
const storageFailure = 'Durable edit storage is unavailable. Edits remain in this tab; no Stop or save will be sent until storage is restored.'
function storage() {
  if (sessionIsSwitching()) throw new SessionChangedError()
  if (typeof window === 'undefined') throw new Error(storageFailure)
  return window.localStorage
}
function key(kind: 'outbox' | 'draft' | 'ui', scope: string) { return protectedKey(kind, `${prefix}${scope}`) }
function read<T>(name: string, schema: z.ZodType<T>): T | undefined {
  let raw: string | null
  try { raw = storage().getItem(name) } catch { throw new Error(storageFailure) }
  if (raw === null) return undefined
  try { return schema.parse(JSON.parse(raw)) }
  catch { throw new Error('The retained edit record is invalid. It has not been deleted or replaced. Reconcile the server intent before editing.') }
}
function write(name: string, value: unknown) {
  const encoded = JSON.stringify(value)
  try {
    const local = storage(); local.setItem(name, encoded)
    if (local.getItem(name) !== encoded) throw new Error(storageFailure)
  } catch { throw new Error(storageFailure) }
}
function assertScope(scope: string, workspaceId: string, workflowId: string) {
  if (scope !== nextDraftKey(workspaceId, workflowId)) throw new Error('The retained edit has a different workspace or workflow.')
}
function tab() {
  // Separate unsent forms in separate tabs. The command outbox, in contrast,
  // is shared and reserved under a cross-tab lock before any HTTP effect.
  const name = key('ui', 'tab')
  let id: string | null
  try {
    id = window.sessionStorage.getItem(name)
    if (!id) { id = crypto.randomUUID(); window.sessionStorage.setItem(name, id) }
  } catch { throw new Error(storageFailure) }
  return id
}
export function readEditSnapshot(scope: string) {
  const own = key('draft', `${scope}:${tab()}`)
  const latest = read(key('ui', `${scope}:latest`), z.string())
  // Reopening in a new tab copies the last form, then owns an independent
  // snapshot. No tab can overwrite another tab's retained unsent payload.
  const value = read(own, SnapshotSchema) ?? (latest ? read(key('draft', `${scope}:${latest}`), SnapshotSchema) : undefined)
  if (value) {
    assertScope(scope, value.context.draft.workspaceId, value.context.draft.workflowId)
    assertScope(scope, value.graph.workspaceId, value.graph.id)
  }
  return value
}
export function storeEditSnapshot(scope: string, edit: Pick<NextDraftEdit, 'context' | 'graph' | 'agentEdits'>) {
  const value = SnapshotSchema.parse({ context: edit.context, graph: edit.graph,
    ...(edit.agentEdits ? { agentEdits: edit.agentEdits } : {}) })
  assertScope(scope, value.graph.workspaceId, value.graph.id)
  assertScope(scope, value.context.draft.workspaceId, value.context.draft.workflowId)
  const id = tab()
  write(key('draft', `${scope}:${id}`), value)
  write(key('ui', `${scope}:latest`), id)
}
export function readEditOutbox(scope: string): EditIntentOutbox | undefined {
  const value = read(key('outbox', scope), OutboxSchema)
  if (value) {
    assertScope(scope, value.request.workspaceId, value.request.workflowId)
    assertScope(scope, value.target.workspaceId, value.target.id)
  }
  return value
}
/** Call only while withEditIntentLock holds the same principal-epoch/scope lock. */
export function reserveEditOutbox(scope: string, candidate: EditIntentOutbox): EditIntentOutbox {
  const existing = readEditOutbox(scope)
  if (existing) return existing // Never replace an uncertain command with newer typing.
  const value = OutboxSchema.parse(candidate)
  assertScope(scope, value.request.workspaceId, value.request.workflowId)
  assertScope(scope, value.target.workspaceId, value.target.id)
  write(key('outbox', scope), value)
  return value
}
/** Acknowledgement must be from authenticated, scope-checked persisted readback. */
export function acknowledgeEditOutbox(scope: string, stageCommandId: string): void {
  const existing = readEditOutbox(scope)
  if (!existing) return
  if (existing.request.commandId !== stageCommandId) throw new Error('Another edit command is retained. Its outbox was not cleared.')
  const local = storage(); local.removeItem(key('outbox', scope))
  if (local.getItem(key('outbox', scope)) !== null) throw new Error(storageFailure)
}
export function sameStageRequest(left: GraphEditStageInput, right: GraphEditStageInput) {
  return sameWorkflowValue({ ...left, commandId: null }, { ...right, commandId: null })
}
export async function withEditIntentLock<T>(scope: string, work: () => Promise<T>): Promise<T> {
  const generation = sessionGeneration(), name = key('outbox', scope)
  storage() // Fail before any request when durable reservation is unavailable.
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('This browser cannot safely reserve a cross-tab edit command. No Stop or save was sent.')
  return navigator.locks.request(name, async () => { assertSession(generation); return work() })
}
export function clearEditIntentStorage() {
  if (typeof window === 'undefined') return
  for (const kind of ['draft', 'outbox', 'ui'] as const) {
    const start = key(kind, '')
    try {
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const name = window.localStorage.key(i)
        if (name?.startsWith(start)) window.localStorage.removeItem(name)
      }
    } catch { /* Session rotation also makes old protected keys inaccessible. */ }
  }
}
