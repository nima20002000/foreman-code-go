import { RunStartV2InputSchema, type GraphDraftOperationV2, type WorkflowDefinitionV2 } from '@graphql/contracts/wave25'
import { hasAgentEdits, referencedAgentEdits, type DraftAgentEdits } from './agentEdits'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { sessionIsSwitching, SessionChangedError } from '../../../shared/api/sessionBoundary'
import { hasLocalChanges, sameValue, type AuthoringIssue, type NextDraftContext } from './model'

/** Opaque workspace/workflow IDs may contain separators; never concatenate them ambiguously. */
export function nextDraftKey(workspaceId: string, workflowId: string): string {
  return `next-draft:${JSON.stringify([workspaceId, workflowId])}`
}

export type PendingRunStart = ReturnType<typeof RunStartV2InputSchema.parse>
const startJournalId = (key: string) => `next-draft-start:${key}`
const startJournalKey = (key: string) => protectedKey('outbox', startJournalId(key))
const storageError = 'Pending Start storage is unavailable. Start is disabled to avoid duplicating a Run after a lost response.'

function readStoredStart(key: string): PendingRunStart | undefined {
  if (sessionIsSwitching()) throw new SessionChangedError()
  if (typeof window === 'undefined') return undefined
  let raw: string | null
  try { raw = window.localStorage.getItem(startJournalKey(key)) } catch { throw new Error(storageError) }
  if (raw === null) return undefined
  try {
    const request = RunStartV2InputSchema.parse(JSON.parse(raw))
    if (nextDraftKey(request.workspaceId, request.workflowId) !== key) throw new Error('Start scope mismatch')
    return request
  } catch { throw new Error('The pending Start record is invalid. Recover its receipt before starting another Run.') }
}

export function clearNextDraftStartStorage(): void {
  if (typeof window === 'undefined') return
  try {
    const prefix = startJournalKey('')
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i)
      if (key?.startsWith(prefix)) window.localStorage.removeItem(key)
    }
  } catch { /* Identity cleanup also clears protected outbox records. */ }
}

export type DraftFailure = { code: string; message: string; uncertain: boolean; issues?: AuthoringIssue[] }
export type WritePlan = { target: WorkflowDefinitionV2; operations: GraphDraftOperationV2[]; publish: boolean; agentTarget?: DraftAgentEdits }
export type DraftRequest = {
  kind: 'apply' | 'save'
  commandId: string
  workspaceId: string
  workflowId: string
  draftId: string
  expectedRevision: number
  executionSemanticsVersion: 2
  operations?: GraphDraftOperationV2[]
}
export type NextDraftEdit = {
  instanceId: string
  context: NextDraftContext
  graph: WorkflowDefinitionV2
  history: WorkflowDefinitionV2[]
  agentEdits?: DraftAgentEdits
  agentHistory?: DraftAgentEdits[]
  busy: boolean
  plan?: WritePlan
  /** Retained verbatim after an ambiguous response. A retry uses this exact command. */
  pending?: DraftRequest
  error?: DraftFailure
  validation?: { revision: number; valid: boolean; issues: AuthoringIssue[] }
}

export function newNextDraft(context: NextDraftContext, instanceId: string): NextDraftEdit {
  return { instanceId, context, graph: context.draft.graph, history: [], busy: false }
}

export function editNextDraft(current: NextDraftEdit, update: (graph: WorkflowDefinitionV2) => WorkflowDefinitionV2): NextDraftEdit {
  const graph = update(current.graph)
  if (sameValue(graph, current.graph)) return current
  return { ...current, graph, history: [...current.history.slice(-49), current.graph], validation: undefined,
    ...(current.agentHistory ? { agentEdits: referencedAgentEdits(graph, current.agentEdits),
      agentHistory: [...current.agentHistory.slice(-49), current.agentEdits ?? {}] } : {}),
    // Typing cannot clear an unresolved command or an authorization/conflict error.
    error: current.error }
}

export function undoNextDraft(current: NextDraftEdit): NextDraftEdit {
  const previous = current.history.at(-1)
  if (!previous) return current
  // Content only: base revision and acknowledged configuration pins never rewind.
  const base = current.context.draft.graph
  return { ...current, graph: { ...previous, version: base.version, createdAt: base.createdAt, updatedAt: base.updatedAt },
    history: current.history.slice(0, -1), validation: undefined,
    ...(current.agentHistory ? { agentEdits: current.agentHistory.at(-1) ?? {}, agentHistory: current.agentHistory.slice(0, -1) } : {}) }
}

export function nextDraftDirty(edit: NextDraftEdit): boolean {
  return hasLocalChanges(edit.context, edit.graph) || hasAgentEdits(edit) || !!edit.pending
    || edit.context.draft.publishedRevision !== edit.context.draft.revision
}

export type DraftPromotion = { request: DraftRequest; busy: boolean; error?: DraftFailure }

export type NextDraftSlice = {
  nextDraftPromotions: Record<string, DraftPromotion>
  setNextDraftPromotion: (key: string, promotion: DraftPromotion | undefined) => void
  nextDrafts: Record<string, NextDraftEdit>
  pendingRunStarts: Record<string, PendingRunStart>
  loadPendingRunStart: (key: string) => void
  reserveRunStart: (key: string, candidate: PendingRunStart) => PendingRunStart
  acknowledgeRunStart: (key: string, commandId: string) => void
  installNextDraft: (key: string, context: NextDraftContext, replace?: boolean) => void
  changeNextDraft: (key: string, update: (graph: WorkflowDefinitionV2) => WorkflowDefinitionV2) => void
  undoNextDraft: (key: string) => void
  updateNextDraft: (key: string, update: (edit: NextDraftEdit) => NextDraftEdit) => void
  dropNextDraft: (key: string) => void
}

type SetSlice = (update: (state: NextDraftSlice) => Partial<NextDraftSlice>) => void

/** A slice of the existing draft owner, not a second runtime or query-fact store. */
export function createNextDraftSlice(set: SetSlice): NextDraftSlice {
  const update = (key: string, change: (edit: NextDraftEdit) => NextDraftEdit) => set((state) => {
    const current = state.nextDrafts[key]
    if (!current) return state
    const next = change(current)
    return next === current ? state : { nextDrafts: { ...state.nextDrafts, [key]: next } }
  })
  return {
    nextDrafts: {}, nextDraftPromotions: {}, pendingRunStarts: {},
    loadPendingRunStart: (key) => {
      const request = readStoredStart(key)
      set((state) => {
        const pendingRunStarts = { ...state.pendingRunStarts }
        if (request) pendingRunStarts[key] = request
        else delete pendingRunStarts[key]
        return { pendingRunStarts }
      })
    },
    reserveRunStart: (key, candidate) => {
      const existing = readStoredStart(key)
      if (existing) {
        set((state) => ({ pendingRunStarts: { ...state.pendingRunStarts, [key]: existing } }))
        return existing
      }
      if (typeof window === 'undefined') throw new Error(storageError)
      const request = RunStartV2InputSchema.parse(candidate)
      if (nextDraftKey(request.workspaceId, request.workflowId) !== key) throw new Error('Start scope mismatch')
      const saved = JSON.stringify(request)
      try {
        window.localStorage.setItem(startJournalKey(key), saved)
        if (window.localStorage.getItem(startJournalKey(key)) !== saved) throw new Error(storageError)
      } catch { throw new Error(storageError) }
      set((state) => ({ pendingRunStarts: { ...state.pendingRunStarts, [key]: request } }))
      return request
    },
    acknowledgeRunStart: (key, commandId) => {
      const existing = readStoredStart(key)
      if (!existing || existing.commandId !== commandId) throw new Error('The pending Start changed. Reconcile it before starting another Run.')
      try {
        window.localStorage.removeItem(startJournalKey(key))
        if (window.localStorage.getItem(startJournalKey(key)) !== null) throw new Error(storageError)
      } catch { throw new Error(storageError) }
      set((state) => {
        const pendingRunStarts = { ...state.pendingRunStarts }; delete pendingRunStarts[key]
        return { pendingRunStarts }
      })
    },
    setNextDraftPromotion: (key, promotion) => set((state) => {
      const nextDraftPromotions = { ...state.nextDraftPromotions }
      if (promotion) nextDraftPromotions[key] = promotion
      else delete nextDraftPromotions[key]
      return { nextDraftPromotions }
    }),
    installNextDraft: (key, context, replace = false) => set((state) => {
      const current = state.nextDrafts[key]
      if (current && (!replace || current.busy || current.pending)) return state
      return { nextDrafts: { ...state.nextDrafts, [key]: newNextDraft(context, crypto.randomUUID()) } }
    }),
    changeNextDraft: (key, change) => update(key, (edit) => editNextDraft(edit, change)),
    undoNextDraft: (key) => update(key, undoNextDraft),
    updateNextDraft: update,
    dropNextDraft: (key) => set((state) => {
      const current = state.nextDrafts[key]
      if (!current || current.busy || current.pending) return state
      const nextDrafts = { ...state.nextDrafts }; delete nextDrafts[key]
      return { nextDrafts }
    }),
  }
}
