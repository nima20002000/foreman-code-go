import type { OperatorConversationState } from '@foreman-code/contracts'
import { activityScopeKey, applyCanonicalActivityItems, reconcileActivitySnapshot, sourceVectorIsStale, sourceVectorHasAdvance } from '../conversations/agentChat/activityMerge'
import { mergeChatMessages } from '../conversations/agentChat/model'
import { mergeOperatorActivity } from '../../shared/api/operatorActivity'

export function newerOperatorConversationState(current: OperatorConversationState | undefined, next: OperatorConversationState, source: 'read' | 'receipt' = 'receipt'): OperatorConversationState {
  if (current?.activitySnapshot && next.activitySnapshot
    && (activityScopeKey(current.activitySnapshot.scope) !== activityScopeKey(next.activitySnapshot.scope) || sourceVectorIsStale(current.activitySnapshot, next.activitySnapshot))) return current
  const currentRevision = current?.activitySnapshot?.revision ?? String(current?.revision ?? 0)
  const nextRevision = next.activitySnapshot?.revision ?? String(next.revision)
  const accepted = current && (current.activitySnapshot && !next.activitySnapshot || BigInt(currentRevision) >= BigInt(nextRevision)) ? current : next
  // A recent server window may move forward while this tab is reading earlier
  // activity. Retain observed records in Query, merging only accepted revisions.
  const activitySnapshot = next.activitySnapshot ? reconcileActivitySnapshot(current?.activitySnapshot, next.activitySnapshot, current?.activitySnapshot?.scope ?? next.activitySnapshot.scope) : current?.activitySnapshot
  const qualification = source === 'read' ? next : current ?? next
  const metadataFresh = source === 'read' || !!current?.activitySnapshot && !!next.activitySnapshot && sourceVectorHasAdvance(current.activitySnapshot, next.activitySnapshot)
  return { ...accepted, ...(activitySnapshot ? { activitySnapshot } : {}), qualificationKey: qualification.qualificationKey, responseAvailability: qualification.responseAvailability, messages: mergeChatMessages(current?.messages ?? [], BigInt(nextRevision) < BigInt(currentRevision) || !metadataFresh && accepted === current ? accepted.messages : next.messages).slice(-100), activities: applyCanonicalActivityItems(mergeOperatorActivity(current?.activities ?? [], next.activities ?? []), activitySnapshot),
    activityNextCursor: current?.activityNextCursor !== undefined ? current.activityNextCursor : next.activityNextCursor }
}
