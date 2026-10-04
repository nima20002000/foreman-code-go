import type { ManagedWorkspace } from '@foreman-code/contracts/management'
import { create } from 'zustand'

/** Local edits only. Saved workspace data and request lifecycle stay in Query. */
export interface WorkspaceLocationDraft {
  rootPath: string
  baseRevision: number
  editVersion: number
  dirty: boolean
  notice: string | undefined
  conflictRevision: number | undefined
}

interface DraftState {
  drafts: Record<string, WorkspaceLocationDraft | undefined>
  update(workspaceId: string, apply: (draft: WorkspaceLocationDraft | undefined) => WorkspaceLocationDraft | undefined): void
  reset(): void
}

export const useWorkspaceLocationDraftStore = create<DraftState>((set) => ({
  drafts: {},
  update: (workspaceId, apply) => set((state) => {
    const current = Object.hasOwn(state.drafts, workspaceId) ? state.drafts[workspaceId] : undefined
    const next = apply(current)
    return next === current ? state : { drafts: { ...state.drafts, [workspaceId]: next } }
  }),
  reset: () => set({ drafts: {} }),
}))

export function locationDraftFor(state: DraftState, workspaceId: string): WorkspaceLocationDraft | undefined {
  return Object.hasOwn(state.drafts, workspaceId) ? state.drafts[workspaceId] : undefined
}

export function hydrateLocationDraft(
  draft: WorkspaceLocationDraft | undefined,
  saved: ManagedWorkspace,
): WorkspaceLocationDraft | undefined {
  if (saved.locationValidation.status === 'restricted' || draft?.dirty
    || (draft && saved.locationRevision < draft.baseRevision)) return draft
  const rootPath = saved.executionLocation?.rootPath ?? ''
  if (draft && draft.rootPath === rootPath && draft.baseRevision === saved.locationRevision) return draft
  return {
    rootPath, baseRevision: saved.locationRevision, editVersion: draft?.editVersion ?? 0,
    dirty: false, notice: draft?.notice, conflictRevision: undefined,
  }
}

export function locationDraftConflicts(draft: WorkspaceLocationDraft, savedRevision: number): boolean {
  return draft.dirty && Math.max(savedRevision, draft.conflictRevision ?? 0) > draft.baseRevision
}

export function editLocationDraft(draft: WorkspaceLocationDraft, rootPath: string): WorkspaceLocationDraft {
  return { ...draft, rootPath, dirty: true, editVersion: draft.editVersion + 1, notice: undefined }
}

export function acknowledgeLocationSave(
  draft: WorkspaceLocationDraft,
  submittedVersion: number,
  rootPath: string,
  revision: number,
): WorkspaceLocationDraft {
  if (revision < draft.baseRevision) return draft
  const newerEdit = draft.editVersion !== submittedVersion
  return {
    ...draft,
    rootPath: newerEdit ? draft.rootPath : rootPath,
    baseRevision: revision,
    dirty: newerEdit,
    conflictRevision: draft.conflictRevision && draft.conflictRevision > revision ? draft.conflictRevision : undefined,
    notice: newerEdit
      ? 'Execution location saved. Your newer path remains unsaved.'
      : 'Execution location saved. Future runs use this folder.',
  }
}

export function reloadLocationDraft(
  draft: WorkspaceLocationDraft,
  submittedVersion: number,
  saved: ManagedWorkspace,
): WorkspaceLocationDraft {
  if (saved.locationValidation.status === 'restricted') {
    return { ...draft, notice: 'You no longer have permission to read this location. Your local edit was preserved.' }
  }
  if (saved.locationRevision < Math.max(draft.baseRevision, draft.conflictRevision ?? 0)) {
    return { ...draft, notice: 'The reload returned an older location. Your local edit was preserved; try reloading again.' }
  }
  if (draft.editVersion !== submittedVersion) {
    return { ...draft, notice: 'The saved location was reloaded. Your newer local edit was preserved.' }
  }
  return {
    rootPath: saved.executionLocation?.rootPath ?? '',
    baseRevision: saved.locationRevision,
    editVersion: draft.editVersion + 1,
    dirty: false,
    notice: undefined,
    conflictRevision: undefined,
  }
}
