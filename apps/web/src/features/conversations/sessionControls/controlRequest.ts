import { z } from 'zod'
import { SessionControlRequestSchema, compactionBlocksSend, type SessionControlState } from '@graphql/contracts'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { useConversationDraftStore } from '../conversationDraftStore'

const PendingControlSchema = z.object({
  request: SessionControlRequestSchema,
  draft: z.object({ key: z.string(), content: z.string() }).optional(),
}).strict()
export type PendingControl = z.infer<typeof PendingControlSchema>

function storageKey(scope: string) { return protectedKey('outbox', `session-control:${scope}`) }
export function pendingControl(scope: string): PendingControl | null {
  const raw = localStorage.getItem(storageKey(scope))
  return raw === null ? null : PendingControlSchema.parse(JSON.parse(raw))
}
export function savePendingControl(scope: string, control: PendingControl) {
  // Sending requires a saved identity so a reload cannot issue the effect twice.
  localStorage.setItem(storageKey(scope), JSON.stringify(PendingControlSchema.parse(control)))
}
export function clearPendingControl(scope: string, requestId: string) {
  if (pendingControl(scope)?.request.requestId === requestId) localStorage.removeItem(storageKey(scope))
}
export function recoverPendingControl(scope: string, state: SessionControlState) {
  const pending = pendingControl(scope)
  if (!pending) return
  const { request, draft } = pending
  const compact = state.compaction?.requestId === request.requestId ? state.compaction
    : state.compactions.find(entry => entry.requestId === request.requestId)
  if (request.kind === 'compact') {
    if (!compact || compactionBlocksSend(compact)) return
    if (compact.status !== 'failed' && draft) {
      useConversationDraftStore.getState().clearDraft(draft.key, draft.content)
    }
  } else {
    if (state.lastRequestId !== request.requestId) return
    if (draft) useConversationDraftStore.getState().clearDraft(draft.key, draft.content)
  }
  clearPendingControl(scope, request.requestId)
}
