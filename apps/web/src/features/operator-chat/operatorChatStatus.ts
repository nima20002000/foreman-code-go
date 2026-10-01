import type { OperatorConversationState, OperatorConversationSummary } from '@graphql/contracts'
import { chatBackgroundWork } from '../conversations/chatWorkStatus'
import type { OperatorChatConnection } from '../../shared/api/operatorChatStream'

export function operatorNeedsAttention(state: OperatorConversationState): boolean {
  return Boolean(state.activeRequestId && state.pendingInteraction && state.responseDelivery === 'offered'
    && state.turnState !== 'canceling')
}

export function summarizeOperatorConversation(state: OperatorConversationState): OperatorConversationSummary {
  return { conversationId: state.conversation.id, title: state.conversation.title,
    revision: state.revision, activeRequestId: state.activeRequestId, turnState: state.turnState,
    needsAttention: operatorNeedsAttention(state), ...(state.activitySnapshot ? { backgroundActivity: chatBackgroundWork(state.activitySnapshot)?.evidence ?? null } : {}) }
}

export function operatorNavigationStatus(summary: OperatorConversationSummary): string {
  if (summary.turnState === 'canceling') return 'Cancellation requested'
  if (summary.needsAttention) return 'Needs your decision'
  if (summary.turnState === 'uncertain') return 'State uncertain'
  if (summary.activeRequestId || ['active', 'starting'].includes(summary.turnState)) return 'Running'
  if (summary.turnState === 'error') return 'Turn failed'
  if (summary.backgroundActivity) return summary.backgroundActivity === 'unknown' ? 'Unfinished work unconfirmed' : 'Background work continues'
  return 'Ready'
}

export function operatorTurnStatus(state: OperatorConversationState, connection: OperatorChatConnection): string {
  const background = !state.activeRequestId && !['active', 'starting'].includes(state.turnState) ? chatBackgroundWork(state.activitySnapshot) : undefined
  const status = state.turnState === 'canceling' ? 'Cancellation requested. Waiting for confirmation.'
    : operatorNeedsAttention(state) ? 'Waiting for your decision.'
      : state.pendingInteraction && state.responseDelivery !== 'offered' ? 'Checking delivery of your decision. It will not be sent twice.'
        : state.turnState === 'uncertain' ? 'The previous turn may still be running.'
          : state.activeRequestId || ['active', 'starting'].includes(state.turnState) ? 'Operator is working…'
            : state.turnState === 'error' ? 'The turn failed.'
              : background ? `${background.label}. ${background.message}` : state.lastResult ? '' : 'Ready for your message.'
  return connection === 'connected' ? status
    : `${connection === 'unavailable' ? 'Live updates unavailable. Polling for changes.' : 'Reconnecting to live updates.'} Information may be stale.${status ? ` ${status}` : ''}`
}

/** Late summary polls cannot undo a decision already acknowledged by a newer revision. */
export function newerOperatorSummaries(
  current: readonly OperatorConversationSummary[] | undefined,
  next: readonly OperatorConversationSummary[],
): OperatorConversationSummary[] {
  const existing = new Map(current?.map((item) => [item.conversationId, item]))
  return next.map((item) => {
    const previous = existing.get(item.conversationId)
    return previous && previous.revision > item.revision ? previous : item
  })
}
