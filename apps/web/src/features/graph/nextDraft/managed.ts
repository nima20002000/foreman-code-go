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
