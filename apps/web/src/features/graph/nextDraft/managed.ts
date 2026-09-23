import { useGraphDraftStore } from '../store'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import { assertDraftSubmission, nextDraftApi } from './transport'
import { createNextDraftWriter } from './writer'

export const nextDraftWriter = createNextDraftWriter(nextDraftApi, {
  get: (key) => useGraphDraftStore.getState().nextDrafts[key],
  update: (key, change) => useGraphDraftStore.getState().updateNextDraft(key, change),
}, assertDraftSubmission, () => `authoring-${crypto.randomUUID()}`, () => {
  const generation = sessionGeneration()
  return () => assertSession(generation)
})

/** Explicit draft-only migration; S2 derives entry from the saved immutable version. */
export async function promoteNextDraft(key: string, context: import('./transport').AuthoringContext) {
  const generation = sessionGeneration()
  const state = useGraphDraftStore.getState()
  const existing = state.nextDraftPromotions[key]
  if (existing?.busy) throw new Error('The draft conversion is already in progress.')
  const { draft } = context
  const request = existing?.request ?? {
    kind: 'apply' as const, executionSemanticsVersion: 2 as const,
    workspaceId: draft.workspaceId, workflowId: draft.workflowId, draftId: draft.id,
    expectedRevision: draft.revision, commandId: `authoring-upgrade-${crypto.randomUUID()}`,
    operations: [{ type: 'nodes.reorder' as const, nodeIds: draft.graph.nodes.map((node) => node.id) }],
  }
  state.setNextDraftPromotion(key, { request, busy: true })
  try {
    await nextDraftApi.write(request)
    assertSession(generation)
    const latest = await nextDraftApi.context(draft.workspaceId, draft.workflowId)
    assertSession(generation)
    const { GraphDraftV2Schema } = await import('@graphql/contracts/wave25')
    const accepted = GraphDraftV2Schema.parse(latest.draft)
    useGraphDraftStore.getState().installNextDraft(key, { draft: accepted, agents: latest.agents })
    useGraphDraftStore.getState().setNextDraftPromotion(key, undefined)
  } catch (error) {
    assertSession(generation)
    const { draftFailure } = await import('./writer')
    const failure = draftFailure(error, true)
    useGraphDraftStore.getState().setNextDraftPromotion(key, failure.uncertain
      ? { request, busy: false, error: failure } : undefined)
    throw error
  }
}
