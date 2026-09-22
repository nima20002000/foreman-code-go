import type { GraphDraftOperationV2, WorkflowDefinitionV2 } from '@graphql/contracts/wave25'
import { hasLocalChanges, sameValue, type AuthoringIssue, type NextDraftContext } from './model'

/** Opaque workspace/workflow IDs may contain separators; never concatenate them ambiguously. */
export function nextDraftKey(workspaceId: string, workflowId: string): string {
  return `next-draft:${JSON.stringify([workspaceId, workflowId])}`
}

export type DraftFailure = { code: string; message: string; uncertain: boolean; issues?: AuthoringIssue[] }
export type WritePlan = { target: WorkflowDefinitionV2; operations: GraphDraftOperationV2[]; publish: boolean }
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
    // Typing cannot clear an unresolved command or an authorization/conflict error.
    error: current.error }
}

export function undoNextDraft(current: NextDraftEdit): NextDraftEdit {
  const previous = current.history.at(-1)
  if (!previous) return current
  // Content only: base revision and acknowledged configuration pins never rewind.
  const base = current.context.draft.graph
  return { ...current, graph: { ...previous, version: base.version, createdAt: base.createdAt, updatedAt: base.updatedAt },
    history: current.history.slice(0, -1), validation: undefined }
}

export function nextDraftDirty(edit: NextDraftEdit): boolean {
  return hasLocalChanges(edit.context, edit.graph) || !!edit.pending
    || edit.context.draft.publishedRevision !== edit.context.draft.revision
}

export type DraftPromotion = { request: DraftRequest; busy: boolean; error?: DraftFailure }

export type NextDraftSlice = {
  nextDraftPromotions: Record<string, DraftPromotion>
  setNextDraftPromotion: (key: string, promotion: DraftPromotion | undefined) => void
  nextDrafts: Record<string, NextDraftEdit>
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
    nextDrafts: {}, nextDraftPromotions: {},
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
