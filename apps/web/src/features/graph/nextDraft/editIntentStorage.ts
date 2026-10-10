import { AgentFormSchema } from './agentForm'
import { LocalWorkflowFormSchema } from './localGraph'
import { z } from 'zod'
import { AgentSchema } from '@foreman-code/contracts'
import { ManagedAgentSchema } from '@foreman-code/contracts/management'
import { GraphDraftV3Schema, GraphEditStageInputV3Schema, WorkflowDefinitionV3Schema, sameAuthoredWorkflow, sameWorkflowValue,
  type GraphEditIntentV3, type GraphEditStageInputV3 } from '@foreman-code/contracts/wave25'
import { ApiError } from '../../../shared/api/client'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { assertSession, sessionGeneration, sessionIsSwitching, SessionChangedError } from '../../../shared/api/sessionBoundary'
import { nextDraftKey, type NextDraftEdit } from './state'

const prefix = 'graph-edit-intent:'
const SnapshotSchema = z.object({
  context: z.object({ draft: GraphDraftV3Schema, savedDraft: GraphDraftV3Schema.optional(), agents: z.array(ManagedAgentSchema) }).strict(),
  graph: LocalWorkflowFormSchema, agentEdits: z.record(z.string(), AgentSchema).optional(),
  agentForms: z.record(z.string(), AgentFormSchema).optional(),
  remoteEditIntent: z.object({ id: z.string().min(1), ownerPrincipalId: z.string().min(1),
    stageCommandId: z.string().min(1), stageInputHash: z.string().min(1) }).strict().optional(),
  acknowledgedStageCommands: z.array(z.string()).optional(), submittedStageCommands: z.array(z.string()).optional(),
}).strict()
const OutboxSchema = z.object({ request: GraphEditStageInputV3Schema, target: WorkflowDefinitionV3Schema,
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
  const existing = read(own, SnapshotSchema)
  const value = existing ?? (latest ? read(key('draft', `${scope}:${latest}`), SnapshotSchema) : undefined)
  if (value) {
    assertScope(scope, value.context.draft.workspaceId, value.context.draft.workflowId)
    assertScope(scope, value.graph.workspaceId, value.graph.id)
    // Copy the acknowledgement metadata with the form. A new tab must not
    // replay an old Discard against edits made after this snapshot settled.
    if (!existing) write(own, value)
    return { context: value.context, graph: value.graph, agentEdits: value.agentEdits, agentForms: value.agentForms,
      ...(value.remoteEditIntent ? { remoteEditIntent: value.remoteEditIntent } : {}) }
  }
  return undefined
}
function sameDraftBase(left: NextDraftEdit['context']['draft'], right: NextDraftEdit['context']['draft']) {
  return left.workspaceId === right.workspaceId && left.workflowId === right.workflowId && left.id === right.id
    && left.revision === right.revision && left.baseWorkflowVersionId === right.baseWorkflowVersionId
}
function sameSnapshotForm(left: z.infer<typeof SnapshotSchema>, right: z.infer<typeof SnapshotSchema>) {
  return sameDraftBase(left.context.draft, right.context.draft) && sameWorkflowValue(left.context, right.context)
    && sameWorkflowValue(left.graph, right.graph) && sameWorkflowValue(left.agentEdits ?? {}, right.agentEdits ?? {})
    && sameWorkflowValue(left.remoteEditIntent, right.remoteEditIntent)
}
/** Local consumption only, not server state. Scoped to this tab and form base. */
export function editSnapshotAcknowledged(scope: string, edit: NextDraftEdit, stageCommandId: string): boolean {
  const snapshot = read(key('draft', `${scope}:${tab()}`), SnapshotSchema)
  return !!snapshot && sameDraftBase(snapshot.context.draft, edit.context.draft)
    && !!snapshot.acknowledgedStageCommands?.includes(stageCommandId)
}
/** Local lineage only. It never authorizes a server command or proves publication. */
export function editSnapshotSubmitted(scope: string, edit: NextDraftEdit, stageCommandId: string): boolean {
  const snapshot = read(key('draft', `${scope}:${tab()}`), SnapshotSchema)
  return !!snapshot && sameDraftBase(snapshot.context.draft, edit.context.draft)
    && !!snapshot.submittedStageCommands?.includes(stageCommandId)
}
export function storeEditSnapshot(scope: string, edit: Pick<NextDraftEdit, 'context' | 'graph' | 'agentEdits' | 'agentForms' | 'remoteEditIntent'>, acknowledgedStageCommandId?: string) {
  const value = SnapshotSchema.parse({ context: edit.context, graph: edit.graph,
    ...(edit.agentForms ? { agentForms: edit.agentForms } : {}),
    ...(edit.agentEdits ? { agentEdits: edit.agentEdits } : {}),
    ...(edit.remoteEditIntent ? { remoteEditIntent: edit.remoteEditIntent } : {}) })
  assertScope(scope, value.graph.workspaceId, value.graph.id)
  assertScope(scope, value.context.draft.workspaceId, value.context.draft.workflowId)
  const id = tab(), name = key('draft', `${scope}:${id}`), previous = read(name, SnapshotSchema)
  const latestId = !previous ? read(key('ui', `${scope}:latest`), z.string()) : undefined
  const latest = latestId && latestId !== id ? read(key('draft', `${scope}:${latestId}`), SnapshotSchema) : undefined
  // A genuinely new recovery tab may continue the exact last form lineage. An
  // already-independent tab always keeps its own metadata and cannot inherit it.
  const lineage = previous ?? (latest && sameSnapshotForm(latest, value) ? latest : undefined)
  const acknowledgedStageCommands = new Set(lineage && sameDraftBase(lineage.context.draft, value.context.draft)
    ? lineage.acknowledgedStageCommands : [])
  const submittedStageCommands = new Set(lineage && sameDraftBase(lineage.context.draft, value.context.draft)
    ? lineage.submittedStageCommands : [])
  if (acknowledgedStageCommandId) acknowledgedStageCommands.add(acknowledgedStageCommandId)
  // Form plus local command-lineage/consumption markers share one storage write.
  // These markers are local safety evidence only, never publication authority.
  write(key('ui', `${scope}:latest`), id)
  write(name, { ...value,
    ...(acknowledgedStageCommands.size ? { acknowledgedStageCommands: [...acknowledgedStageCommands] } : {}),
    ...(submittedStageCommands.size ? { submittedStageCommands: [...submittedStageCommands] } : {}) })
}
export function readEditOutbox(scope: string): EditIntentOutbox | undefined {
  const value = read(key('outbox', scope), OutboxSchema)
  if (value) {
    assertScope(scope, value.request.workspaceId, value.request.workflowId)
    assertScope(scope, value.target.workspaceId, value.target.id)
  }
  return value
}
/** Submission evidence is immutable and command-keyed, unlike the shared active
 * outbox. Keep it until session cleanup so a suspended tab can still reconcile
 * after another tab consumes the outbox. It never authorizes or sends a command. */
function submissionKey(scope: string, commandId: string) { return key('ui', `submission:${JSON.stringify([scope, commandId])}`) }
function retainEditSubmission(scope: string, candidate: EditIntentOutbox): EditIntentOutbox {
  const value = OutboxSchema.parse(candidate)
  assertScope(scope, value.request.workspaceId, value.request.workflowId)
  assertScope(scope, value.target.workspaceId, value.target.id)
  const name = submissionKey(scope, value.request.commandId), previous = read(name, OutboxSchema)
  if (previous && !sameWorkflowValue(previous, value)) throw new Error('The retained submission conflicts with this exact command. No evidence was replaced.')
  if (!previous) write(name, value)
  return previous ?? value
}
function snapshotMatchesSubmission(snapshot: z.infer<typeof SnapshotSchema>, value: EditIntentOutbox): boolean {
  const request = value.request, draft = snapshot.context.draft
  return draft.workspaceId === request.workspaceId && draft.workflowId === request.workflowId && draft.id === request.draftId
    && draft.publishedRevision === request.expectedRevision && draft.baseWorkflowVersionId === request.expectedWorkflowVersionId
    && sameAuthoredWorkflow(snapshot.graph, value.target)
    && sameWorkflowValue(snapshot.agentEdits ?? {}, value.agentTarget ?? {})
}
/** Capture only tabs whose local form still matches this Stage at reservation time.
 * Later typing keeps that lineage; already-divergent tabs remain pinned to their
 * own revision and must hit the server conflict/reload path explicitly. */
function markSubmittedSnapshots(scope: string, value: EditIntentOutbox): void {
  const local = storage(), ownName = key('draft', `${scope}:${tab()}`)
  const mark = (name: string, snapshot: z.infer<typeof SnapshotSchema>) => {
    if (!snapshotMatchesSubmission(snapshot, value)) return
    const submittedStageCommands = new Set(snapshot.submittedStageCommands)
    submittedStageCommands.add(value.request.commandId)
    write(name, { ...snapshot, submittedStageCommands: [...submittedStageCommands] })
  }
  const own = read(ownName, SnapshotSchema)
  if (own) mark(ownName, own)
  const start = key('draft', `${scope}:`)
  for (let i = 0; i < local.length; i++) {
    const name = local.key(i)
    if (!name?.startsWith(start) || name === ownName) continue
    // A corrupt sibling snapshot is never trusted or repaired here. It simply
    // receives no lineage marker and therefore cannot advance another form.
    try { const snapshot = read(name, SnapshotSchema); if (snapshot) mark(name, snapshot) } catch { /* fail closed for that sibling */ }
  }
}
export function matchesEditIntent(value: EditIntentOutbox, intent: GraphEditIntentV3): boolean {
  const request = value.request
  return request.workspaceId === intent.workspaceId && request.workflowId === intent.workflowId
    && value.target.workspaceId === intent.workspaceId && value.target.id === intent.workflowId
    && request.commandId === intent.stageCommandId && request.draftId === intent.draftId
    && request.expectedRevision === intent.expectedRevision && request.expectedWorkflowVersionId === intent.expectedWorkflowVersionId
}
/** Call only with authenticated, scope-checked readback. Local evidence supplies
 * the submitted form, never the terminal state, result, or authority. */
export function readEditSubmission(scope: string, intent: GraphEditIntentV3): EditIntentOutbox | undefined {
  assertScope(scope, intent.workspaceId, intent.workflowId)
  const value = read(submissionKey(scope, intent.stageCommandId), OutboxSchema)
  if (value) {
    if (!matchesEditIntent(value, intent)) throw new Error('The retained submission does not match the acknowledged command and draft base.')
    return value
  }
  const outbox = readEditOutbox(scope)
  // Upgrade older reservations before ANY tab can consume the sole copy.
  return outbox && matchesEditIntent(outbox, intent) ? retainEditSubmission(scope, outbox) : undefined
}
/** Call only while withEditIntentLock holds the same principal-epoch/scope lock. */
export function reserveEditOutbox(scope: string, candidate: EditIntentOutbox): EditIntentOutbox {
  const existing = readEditOutbox(scope)
  if (existing) return retainEditSubmission(scope, existing) // Never replace an uncertain command with newer typing.
  const value = retainEditSubmission(scope, candidate)
  markSubmittedSnapshots(scope, value)
  write(key('outbox', scope), value)
  return value
}
function removeEditOutbox(scope: string, stageCommandId: string): void {
  const existing = readEditOutbox(scope)
  if (!existing) return
  if (existing.request.commandId !== stageCommandId) throw new Error('Another edit command is retained. Its outbox was not cleared.')
  const local = storage(); local.removeItem(key('outbox', scope))
  if (local.getItem(key('outbox', scope)) !== null) throw new Error(storageFailure)
}
/** Acknowledgement must be from authenticated, scope-checked persisted readback. */
export function acknowledgeEditOutbox(scope: string, stageCommandId: string): void {
  const existing = readEditOutbox(scope)
  if (existing?.request.commandId === stageCommandId) retainEditSubmission(scope, existing)
  removeEditOutbox(scope, stageCommandId)
}
/** These Stage errors originate only before intent insertion (prepare/perform),
 * not in the post-commit readback. Do NOT generalize to all 4xx: authorization,
 * receipt conflicts and unavailable readback can follow a committed Stage. */
export function isDefinitiveStageRejection(error: unknown): boolean {
  if (!ApiError.is(error)) return false
  if (error.status === 404) return error.code === 'GRAPH_DRAFT_NOT_FOUND'
  return error.status === 409 && ['REVISION_CONFLICT', 'WORKFLOW_BASE_CONFLICT', 'GRAPH_INVALID',
    'AGENT_ID_CONFLICT', 'AGENT_REVISION_CONFLICT', 'AGENT_SOURCE_CONFLICT', 'GRAPH_EDIT_INTENT_EXISTS',
    'PRESENTATION_REVISION_CONFLICT', 'PRESENTATION_BASE_REQUIRED', 'WORKTREE_BINDING_REQUIRED',
    'APPROVAL_CODEX_REVIEW_CONFIGURATION_REQUIRED'].includes(error.code)
}
/** Call only for the exact editStage failure, under the same session/scope lock.
 * Releasing a rejected reservation never discards or rewrites the local form. */
export function rejectEditOutbox(scope: string, request: GraphEditStageInputV3, error: unknown): boolean {
  if (!isDefinitiveStageRejection(error)) return false
  const existing = readEditOutbox(scope)
  if (!existing) return false
  if (!sameWorkflowValue(existing.request, request)) throw new Error('Another edit command is retained. Its outbox was not cleared.')
  removeEditOutbox(scope, request.commandId)
  return true
}
export function sameStageRequest(left: GraphEditStageInputV3, right: GraphEditStageInputV3) {
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
