import type { AgentChatState } from '@graphql/contracts/agent-chat'
import { AcceptedChatResponseControlSchema, type AcceptedChatResponseControl } from '@graphql/contracts/interaction-activity'

/** Capture only an offered, exact persisted request choice; receipt replay keeps its original metadata. */
export function acceptedResponseControl(state: AgentChatState, nativeRequestId: string, optionId: string): AcceptedChatResponseControl | undefined {
  const pending = state.pendingInteraction, active = state.activeTurn, conversation = state.conversation, scope = state.activitySnapshot?.scope
  const option = pending?.responseOptions.find((candidate) => candidate.optionId === optionId)
  if (!pending || !active || !conversation || !scope || !option || pending.turn.nativeRequestId !== nativeRequestId
    || conversation.nativeSession?.nativeSessionId !== pending.session.nativeSessionId
    || active.nativeTurnId !== pending.turn.nativeTurnId) return undefined
  return AcceptedChatResponseControlSchema.parse({ schemaVersion: 1, kind: 'respond', conversationId: conversation.id,
    modelRequestId: active.requestId, scope, native: { harness: pending.session.harness, sessionId: pending.session.nativeSessionId,
      turnId: pending.turn.nativeTurnId, requestId: nativeRequestId, requestType: pending.nativeRequestType },
    choice: { optionId: option.optionId, semantic: option.semantic } })
}
