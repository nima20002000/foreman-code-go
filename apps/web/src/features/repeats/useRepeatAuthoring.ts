import { useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import {
  RepeatEditReadResultSchema,
  RepeatWorkflowReadbackSchema,
  type RepeatEditIntent,
  type RepeatEditStageInput,
  type RepeatPlanV1,
  type RepeatSaveInput,
  type WorkflowDefinitionV2,
} from '@graphql/contracts/wave25'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { protectedKey } from '../../shared/api/protectedChatStorage'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { ApiError } from '../../shared/api/client'
import { repeatClient, type RepeatClient } from './client'
import {
  emptyRepeatDraft,
  localDraftFromPlan,
  repeatDraftEqual,
  repeatPlanFromLocalDraft,
  validateRepeatDraft,
  type RepeatLocalDraft,
} from './repeatModel'

export type RepeatRuntimeGuard = {
  checking: boolean
  hasSavedRepeat: boolean
  runtimeAdmission: boolean
  meaningfulEdit: boolean
  reason?: string
}

type SourcePin = { agentId: string; configurationVersionId: string }
type Base = {
  plan: RepeatPlanV1 | null
  revision: number
  workflowVersionId: string | null
  agentConfigurationVersionIds: Record<string, string>
  locationRevision: number
  savedSemantics: 2 | 3
}
type Stored = {
  v: 1
  draftId: string
  intentId?: string
  base: Base
  value: RepeatLocalDraft
  direct?: RepeatSaveInput
  stage?: RepeatEditStageInput
}
type LocalDraft = Stored & { busy?: boolean; uncertain?: boolean; error?: string }
type LocalState = {
  drafts: Record<string, LocalDraft>
  set(key: string, value: LocalDraft): void
  change(key: string, update: (draft: RepeatLocalDraft) => RepeatLocalDraft): void
  patch(key: string, value: Partial<LocalDraft>): void
}

const useRepeatDraftStore = create<LocalState>((set) => ({
  drafts: {},
  set: (key, value) => set((state) => ({ drafts: { ...state.drafts, [key]: value } })),
  change: (key, update) => set((state) => {
    const current = state.drafts[key]
    if (!current || current.busy || current.uncertain || current.stage || current.direct) return state
    return { drafts: { ...state.drafts, [key]: { ...current, value: update(current.value), error: undefined } } }
  }),
  patch: (key, value) => set((state) => {
    const current = state.drafts[key]
    return current ? { drafts: { ...state.drafts, [key]: { ...current, ...value } } } : state
  }),
}))

const localKey = (workspaceId: string, workflowId: string) => protectedKey('outbox', `repeat-editor:${JSON.stringify([workspaceId, workflowId])}`)
const storeKey = (workspaceId: string, workflowId: string) => `${workspaceId}::${workflowId}`
const currentDraft = (value: LocalDraft): Stored => ({
  v: 1, draftId: value.draftId, ...(value.intentId ? { intentId: value.intentId } : {}), base: value.base,
  value: value.value, ...(value.direct ? { direct: value.direct } : {}), ...(value.stage ? { stage: value.stage } : {}),
})
function persist(workspaceId: string, workflowId: string, value: LocalDraft) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(localKey(workspaceId, workflowId), JSON.stringify(currentDraft(value)))
}
function restore(workspaceId: string, workflowId: string): Stored | undefined {
  if (typeof window === 'undefined') return undefined
  const raw = window.localStorage.getItem(localKey(workspaceId, workflowId))
  if (!raw) return undefined
  const value = JSON.parse(raw) as Partial<Stored>
  if (value.v !== 1 || !value.draftId || !value.base || !value.value) throw new Error('The retained repeat edit record is invalid. Do not submit a replacement command.')
  return value as Stored
}

export const repeatAuthoringKey = (workspaceId: string, workflowId: string) =>
  ['workbench', 'repeat-authoring', sessionGeneration(), workspaceId, workflowId] as const
export const repeatCapabilitiesKey = (workspaceId: string, workflowId: string) =>
  ['workbench', 'repeat-capabilities', sessionGeneration(), workspaceId, workflowId] as const

const pinMap = (pins: SourcePin[] | undefined) => Object.fromEntries((pins ?? []).map((pin) => [pin.agentId, pin.configurationVersionId]))
const activeIntent = (intent: RepeatEditIntent | null | undefined) => !!intent && !['saved', 'discarded'].includes(intent.state)
const reason = (codes: readonly string[]) => codes.length ? codes.join(', ') : undefined

function safeRelease(error: unknown): boolean {
  return ApiError.is(error) && [400, 403, 404, 409].includes(error.status ?? 0)
    && !['NETWORK_ERROR', 'HTTP_ERROR'].includes(error.code)
}

export function useRepeatAuthoring({ workspaceId, workflowId, graph, activeRuns, sourceAgentPins, client = repeatClient,
  onRuntimeGuardChange }: {
  workspaceId: string
  workflowId: string
  graph: WorkflowDefinitionV2
  activeRuns: number
  sourceAgentPins?: SourcePin[]
  client?: RepeatClient
  onRuntimeGuardChange?(guard: RepeatRuntimeGuard): void
}) {
  const key = storeKey(workspaceId, workflowId)
  const reconciledOnMount = useRef<string | undefined>(undefined)
  const queryClient = useQueryClient()
  const capabilities = useQuery({
    queryKey: repeatCapabilitiesKey(workspaceId, workflowId),
    queryFn: ({ signal }) => client.capabilities(workspaceId, workflowId, { signal }), retry: false, staleTime: 5_000,
  })
  const query = useQuery({
    queryKey: repeatAuthoringKey(workspaceId, workflowId), retry: false, staleTime: 2_000, refetchOnWindowFocus: true,
    queryFn: async ({ signal }) => {
      const [managed, workspace] = await Promise.all([
        client.workflowMeta(workspaceId, workflowId, { signal }), client.workspaceMeta(workspaceId, { signal }),
      ])
      let repeat: ReturnType<typeof RepeatWorkflowReadbackSchema.parse> | undefined
      try {
        const value = await client.get({ workspaceId, workflowId }, { signal })
        repeat = RepeatWorkflowReadbackSchema.parse(value)
      } catch (error) {
        if (!ApiError.is(error) || error.code !== 'WORKFLOW_VERSION_UNSUPPORTED'
          || !('executionSemanticsVersion' in managed.workflow) || managed.workflow.executionSemanticsVersion !== 2) throw error
      }
      const base: Base = repeat ? {
        plan: repeat.version.definition.repeat, revision: repeat.revision, workflowVersionId: repeat.currentVersionId,
        agentConfigurationVersionIds: repeat.version.agentConfigurationVersionIds, locationRevision: workspace.locationRevision, savedSemantics: 3,
      } : {
        plan: null, revision: managed.revision, workflowVersionId: managed.currentVersionId,
        agentConfigurationVersionIds: pinMap(sourceAgentPins), locationRevision: workspace.locationRevision, savedSemantics: 2,
      }
      return base
    },
  })
  const local = useRepeatDraftStore((state) => state.drafts[key])

  useEffect(() => {
    if (!query.data) return
    const state = useRepeatDraftStore.getState()
    if (state.drafts[key]) return
    try {
      const saved = restore(workspaceId, workflowId)
      if (saved) {
        state.set(key, { ...saved })
        return
      }
    } catch (error) {
      state.set(key, { v: 1, draftId: crypto.randomUUID(), base: query.data, value: localDraftFromPlan(query.data.plan),
        error: error instanceof Error ? error.message : 'The retained repeat edit could not be restored.' })
      return
    }
    state.set(key, { v: 1, draftId: crypto.randomUUID(), base: query.data, value: localDraftFromPlan(query.data.plan) })
  }, [key, query.data, workspaceId, workflowId])

  useEffect(() => {
    if (!local) return
    try { persist(workspaceId, workflowId, local) }
    catch {
      const message = 'Repeat edits cannot be retained in this browser. Do not submit until storage is available.'
      if (local.error !== message) useRepeatDraftStore.getState().patch(key, { error: message })
    }
  }, [key, local, workspaceId, workflowId])

  const savedRepeat = !!query.data?.plan || local?.base.savedSemantics === 3
  const guard = useMemo<RepeatRuntimeGuard>(() => ({
    checking: capabilities.isPending || !query.data,
    hasSavedRepeat: savedRepeat,
    runtimeAdmission: capabilities.data?.availability.runtimeAdmission ?? false,
    meaningfulEdit: capabilities.data?.availability.meaningfulEdit ?? false,
    reason: query.isError ? 'Saved repeat settings could not be verified.'
      : capabilities.data ? reason(capabilities.data.availability.reasons) : 'Repeat capability status is unavailable.',
  }), [capabilities.data, capabilities.isPending, query.data, query.isError, savedRepeat])
  useEffect(() => { onRuntimeGuardChange?.(guard) }, [guard, onRuntimeGuardChange])

  const value = local?.value ?? emptyRepeatDraft()
  const dirty = !!local && !repeatDraftEqual(local.value, localDraftFromPlan(local.base.plan))
  const stale = !!local && !!query.data && (query.data.revision !== local.base.revision || query.data.workflowVersionId !== local.base.workflowVersionId)
  const issues = useMemo(() => validateRepeatDraft(value, graph), [value, graph])
  const plan = useMemo(() => repeatPlanFromLocalDraft(value, graph), [value, graph])
  const shapeValid = value.blocks.length > 0 && !!plan && !issues.length
  const canDirectSave = dirty && shapeValid && activeRuns === 0 && !local?.busy && !local?.uncertain && !stale && !!local?.base.workflowVersionId
  const canStopAndSave = dirty && shapeValid && activeRuns > 0 && !!capabilities.data?.availability.meaningfulEdit
    && !local?.busy && !local?.uncertain && !stale && !!local?.base.workflowVersionId

  const change = (update: (draft: RepeatLocalDraft) => RepeatLocalDraft) => {
    const current = useRepeatDraftStore.getState().drafts[key]
    if (!current && query.data) useRepeatDraftStore.getState().set(key, { v: 1, draftId: crypto.randomUUID(), base: query.data, value: localDraftFromPlan(query.data.plan) })
    useRepeatDraftStore.getState().change(key, update)
  }
  const reload = async () => {
    if (local?.stage || local?.direct || local?.uncertain) throw new Error('Reconcile the retained repeat command before reloading.')
    const fresh = await query.refetch()
    if (fresh.data) {
      const next: LocalDraft = { v: 1, draftId: local?.draftId ?? crypto.randomUUID(), base: fresh.data, value: localDraftFromPlan(fresh.data.plan) }
      useRepeatDraftStore.getState().set(key, next); persist(workspaceId, workflowId, next)
    }
  }
  const localDiscard = async () => {
    const current = useRepeatDraftStore.getState().drafts[key]
    if (!current || current.busy || current.uncertain || current.stage || current.direct) throw new Error('Reconcile the retained repeat command before discarding local edits.')
    const next = { ...current, value: localDraftFromPlan(current.base.plan), error: undefined }
    useRepeatDraftStore.getState().set(key, next); persist(workspaceId, workflowId, next)
  }

  const acceptIntent = (raw: unknown) => {
    const result = RepeatEditReadResultSchema.parse(raw)
    const intent = result.intent
    if (!intent) return result
    const current = useRepeatDraftStore.getState().drafts[key]
    if (!current || intent.draftId !== current.draftId || intent.workspaceId !== workspaceId || intent.workflowId !== workflowId) {
      throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Repeat edit readback returned a different private editor identity.' })
    }
    const patch: Partial<LocalDraft> = { intentId: intent.id, busy: false, uncertain: intent.state === 'uncertain', error: intent.error?.message }
    if (intent.state === 'saved' && intent.result) {
      const base: Base = { plan: intent.result.version.definition.repeat, revision: intent.result.revision,
        workflowVersionId: intent.result.currentVersionId, agentConfigurationVersionIds: intent.result.version.agentConfigurationVersionIds,
        locationRevision: current.base.locationRevision, savedSemantics: 3 }
      Object.assign(patch, { base, value: localDraftFromPlan(base.plan), stage: undefined, direct: undefined, uncertain: false, error: undefined })
      void queryClient.invalidateQueries({ queryKey: repeatAuthoringKey(workspaceId, workflowId) })
    } else if (intent.state === 'discarded') Object.assign(patch, { value: localDraftFromPlan(current.base.plan), stage: undefined, direct: undefined, uncertain: false, error: undefined })
    useRepeatDraftStore.getState().patch(key, patch)
    return result
  }

  const reconcile = async () => {
    const current = useRepeatDraftStore.getState().drafts[key]
    if (!current) throw new Error('Repeat editor is not ready.')
    if (current.direct) {
      try {
        const result = await client.mutate(current.direct)
        if (!('value' in result)) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Direct repeat save did not return a publication receipt.' })
        const base: Base = { plan: result.value.version.definition.repeat, revision: result.value.revision,
          workflowVersionId: result.value.currentVersionId, agentConfigurationVersionIds: result.value.version.agentConfigurationVersionIds,
          locationRevision: current.base.locationRevision, savedSemantics: 3 }
        const next: LocalDraft = { ...current, base, value: localDraftFromPlan(base.plan), direct: undefined, busy: false, uncertain: false, error: undefined }
        useRepeatDraftStore.getState().set(key, next); persist(workspaceId, workflowId, next)
        void queryClient.invalidateQueries({ queryKey: repeatAuthoringKey(workspaceId, workflowId) })
        return
      } catch (error) {
        useRepeatDraftStore.getState().patch(key, { busy: false, uncertain: !safeRelease(error), ...(safeRelease(error) ? { direct: undefined } : {}), error: error instanceof Error ? error.message : 'Repeat save failed.' })
        throw error
      }
    }
    const result = await client.get({ action: 'read_edits', workspaceId, workflowId, draftId: current.draftId, ...(current.intentId ? { intentId: current.intentId } : {}) })
    acceptIntent(result)
  }

  const directSave = async () => {
    const current = useRepeatDraftStore.getState().drafts[key]
    const currentPlan = current && repeatPlanFromLocalDraft(current.value, graph)
    if (!current || !currentPlan || !canDirectSave || !current.base.workflowVersionId) throw new Error('Fix the repeat definition and reload the current saved revision before saving.')
    const request: RepeatSaveInput = { workspaceId, workflowId, commandId: current.direct?.commandId ?? crypto.randomUUID(),
      expectedRevision: current.base.revision, expectedWorkflowVersionId: current.base.workflowVersionId,
      executionSemanticsVersion: 3, repeat: currentPlan }
    reconciledOnMount.current = request.commandId
    const next = { ...current, direct: request, busy: true, error: undefined }
    useRepeatDraftStore.getState().set(key, next); persist(workspaceId, workflowId, next)
    return reconcile()
  }

  const stage = async () => {
    const current = useRepeatDraftStore.getState().drafts[key]
    const currentPlan = current && repeatPlanFromLocalDraft(current.value, graph)
    if (!current || !currentPlan || !canStopAndSave || !current.base.workflowVersionId) throw new Error('Stop-and-save is unavailable for this repeat edit.')
    const request: RepeatEditStageInput = current.stage ?? {
      action: 'stage_edits', workspaceId, workflowId, draftId: current.draftId, commandId: crypto.randomUUID(),
      expectedRevision: current.base.revision, expectedWorkflowVersionId: current.base.workflowVersionId,
      expectedAgentConfigurationVersionIds: current.base.agentConfigurationVersionIds,
      expectedLocationRevision: current.base.locationRevision, executionSemanticsVersion: 3, repeat: currentPlan,
    }
    reconciledOnMount.current = request.commandId
    const staged = { ...current, stage: request, busy: true, error: undefined }
    useRepeatDraftStore.getState().set(key, staged); persist(workspaceId, workflowId, staged)
    try {
      const result = acceptIntent(await client.mutate(request))
      const intent = result.intent
      if (!intent) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Repeat Stage did not return its private edit intent.' })
      if (!result.canStop) throw new Error('Stop permission is missing for one or more affected Runs. The exact Stage remains retained.')
      if (result.affectedSetChanged) throw new Error('The affected Run set changed. The retained command will not Stop newly discovered Runs.')
      const advanced = await client.mutate({ action: 'stop_and_save', workspaceId, workflowId, draftId: intent.draftId, intentId: intent.id, commandId: intent.advanceCommandId })
      return acceptIntent(advanced)
    } catch (error) {
      const release = safeRelease(error)
      useRepeatDraftStore.getState().patch(key, { busy: false, uncertain: !release, ...(release ? { stage: undefined } : {}), error: error instanceof Error ? error.message : 'Repeat Stage/Stop-and-save failed.' })
      throw error
    }
  }

  const discard = async () => {
    const current = useRepeatDraftStore.getState().drafts[key]
    if (!current) return
    if (!current.intentId && !current.stage) return localDiscard()
    if (current.uncertain && !current.intentId) throw new Error('Reconcile the possible Stage before discarding. Discard never Stops.')
    const read = await client.get({ action: 'read_edits', workspaceId, workflowId, draftId: current.draftId, ...(current.intentId ? { intentId: current.intentId } : {}) })
    const result = acceptIntent(read)
    const intent = result.intent
    if (!intent || !activeIntent(intent)) return localDiscard()
    const discarded = await client.mutate({ action: 'discard_edits', workspaceId, workflowId, draftId: intent.draftId, intentId: intent.id, commandId: intent.discardCommandId })
    acceptIntent(discarded)
  }

  useUnsavedChanges({
    label: 'repeat definition', dirty: dirty || !!local?.stage || !!local?.direct || !!local?.uncertain,
    busy: local?.busy, uncertain: local?.uncertain, error: local?.error,
    saveDisabled: activeRuns > 0 ? !canStopAndSave : !canDirectSave,
    save: activeRuns > 0 ? stage : directSave, discard,
  })

  const reconcileRef = useRef(reconcile)
  reconcileRef.current = reconcile
  useEffect(() => {
    if (!local || (!local.stage && !local.direct && !local.intentId)) return
    const identity = local.intentId ?? local.stage?.commandId ?? local.direct?.commandId
    if (!identity || reconciledOnMount.current === identity) return
    reconciledOnMount.current = identity
    void reconcileRef.current().catch(() => undefined)
  }, [local])

  return {
    query, capabilities, value, dirty, stale, issues, plan, guard,
    canDirectSave, canStopAndSave, busy: !!local?.busy, uncertain: !!local?.uncertain,
    error: local?.error, retained: !!local?.stage || !!local?.direct || !!local?.intentId,
    change, reload, discard, reconcile, save: directSave, stopAndSave: stage,
  }
}
