import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import type { WorkflowDefinitionV2 } from '@graphql/contracts/wave25'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { RepeatClientError, repeatClient, type RepeatAuthoringSnapshot, type RepeatClient } from './client'
import {
  emptyRepeatDraft,
  localDraftFromPlan,
  repeatDraftEqual,
  repeatPlanFromLocalDraft,
  validateRepeatDraft,
  type RepeatLocalDraft,
} from './repeatModel'

type LocalState = {
  drafts: Record<string, { base: RepeatAuthoringSnapshot; value: RepeatLocalDraft; busy?: boolean; uncertain?: boolean; error?: string }>
  install(key: string, base: RepeatAuthoringSnapshot, force?: boolean): void
  change(key: string, update: (draft: RepeatLocalDraft) => RepeatLocalDraft): void
  mark(key: string, patch: { busy?: boolean; uncertain?: boolean; error?: string }): void
  clear(key: string): void
}

const useRepeatDraftStore = create<LocalState>((set) => ({
  drafts: {},
  install: (key, base, force = false) => set((state) => {
    const current = state.drafts[key]
    if (current && !force) return state
    return { drafts: { ...state.drafts, [key]: { base, value: localDraftFromPlan(base.plan) } } }
  }),
  change: (key, update) => set((state) => {
    const current = state.drafts[key]
    if (!current || current.busy || current.uncertain) return state
    return { drafts: { ...state.drafts, [key]: { ...current, value: update(current.value), error: undefined } } }
  }),
  mark: (key, patch) => set((state) => {
    const current = state.drafts[key]
    return current ? { drafts: { ...state.drafts, [key]: { ...current, ...patch } } } : state
  }),
  clear: (key) => set((state) => { const drafts = { ...state.drafts }; delete drafts[key]; return { drafts } }),
}))

export const repeatAuthoringKey = (workspaceId: string, workflowId: string) =>
  ['workbench', 'repeat-authoring', sessionGeneration(), workspaceId, workflowId] as const

export function useRepeatAuthoring({ workspaceId, workflowId, graph, activeRuns, client = repeatClient }: {
  workspaceId: string
  workflowId: string
  graph: WorkflowDefinitionV2
  activeRuns: number
  client?: RepeatClient
}) {
  const key = `${workspaceId}::${workflowId}`
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: repeatAuthoringKey(workspaceId, workflowId),
    queryFn: ({ signal }) => client.authoring(workspaceId, workflowId, { signal }),
    staleTime: 3_000,
    refetchInterval: 3_000,
    refetchOnWindowFocus: true,
    retry: false,
  })
  const local = useRepeatDraftStore((state) => state.drafts[key])
  useEffect(() => {
    if (!query.data) return
    const current = useRepeatDraftStore.getState().drafts[key]
    if (!current) useRepeatDraftStore.getState().install(key, query.data)
    else if (!current.busy && !current.uncertain && repeatDraftEqual(current.value, localDraftFromPlan(current.base.plan))
      && query.data.revision !== current.base.revision) useRepeatDraftStore.getState().install(key, query.data, true)
  }, [key, query.data])

  const value = local?.value ?? emptyRepeatDraft()
  const dirty = !!local && !repeatDraftEqual(local.value, localDraftFromPlan(local.base.plan))
  const stale = !!local && !!query.data && query.data.revision !== local.base.revision
  const issues = useMemo(() => validateRepeatDraft(value, graph), [value, graph])
  const plan = useMemo(() => repeatPlanFromLocalDraft(value, graph), [value, graph])
  const canSubmit = dirty && !issues.length && (value.blocks.length === 0 || !!plan) && !local?.busy && !local?.uncertain && !stale

  const change = (update: (draft: RepeatLocalDraft) => RepeatLocalDraft) => {
    if (!local) {
      const base = query.data ?? { plan: null, revision: 0, workflowVersionId: null }
      useRepeatDraftStore.getState().install(key, base)
    }
    useRepeatDraftStore.getState().change(key, update)
  }
  const reload = () => {
    if (!query.data) return
    useRepeatDraftStore.getState().install(key, query.data, true)
  }
  const discard = async () => {
    const current = useRepeatDraftStore.getState().drafts[key]
    if (!current || current.busy || current.uncertain) throw new Error('Reconcile the repeat save before discarding it.')
    useRepeatDraftStore.getState().install(key, current.base, true)
  }
  const submit = async (mode: 'save' | 'stop_and_save') => {
    const current = useRepeatDraftStore.getState().drafts[key]
    const currentPlan = current && repeatPlanFromLocalDraft(current.value, graph)
    if (!current || (current.value.blocks.length > 0 && !currentPlan) || !canSubmit) throw new Error('Fix the repeat definition or reload the newer saved version before saving.')
    if (mode === 'save' && activeRuns > 0) throw new Error('Use “Stop current Run and save edits” while a Run is active.')
    useRepeatDraftStore.getState().mark(key, { busy: true, uncertain: false, error: undefined })
    try {
      const saved = await client.save({ workspaceId, workflowId, expectedRevision: current.base.revision,
        commandId: crypto.randomUUID(), mode, plan: currentPlan ?? null })
      useRepeatDraftStore.getState().install(key, saved, true)
      queryClient.setQueryData(repeatAuthoringKey(workspaceId, workflowId), saved)
      return saved
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The repeat definition was not saved.'
      useRepeatDraftStore.getState().mark(key, { busy: false, uncertain: error instanceof RepeatClientError && error.uncertain, error: message })
      throw error
    }
  }

  useUnsavedChanges({
    label: 'repeat definition', dirty: dirty || !!local?.busy || !!local?.uncertain,
    busy: local?.busy, uncertain: local?.uncertain, error: local?.error,
    saveDisabled: activeRuns > 0 || !canSubmit,
    save: () => submit('save'), discard,
  })

  return { query, value, dirty, stale, issues, plan, canSubmit, busy: !!local?.busy, uncertain: !!local?.uncertain,
    error: local?.error, change, reload, discard, save: () => submit('save'), stopAndSave: () => submit('stop_and_save') }
}
