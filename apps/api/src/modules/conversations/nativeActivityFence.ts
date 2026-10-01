import type { NativeHarnessEvent, NativeSessionReference } from '@graphql/contracts'
import type { NativeMessageSubmission } from '../harnesses/port.js'
import type { ActivityMutationFence } from './operatorActivityRepository.js'

/** Harness sequence numbers are transport-local, never a provider/global watermark. */
export function nativeActivityFence(session: NativeSessionReference, turnId: string | null, event: NativeHarnessEvent,
  authoritativeReconciliation = false, nativeSubmission?: NativeMessageSubmission): ActivityMutationFence {
  const item = event.payload.item && typeof event.payload.item === 'object' && !Array.isArray(event.payload.item)
    ? event.payload.item as Record<string, unknown> : {}
  const part = event.payload.part && typeof event.payload.part === 'object' && !Array.isArray(event.payload.part)
    ? event.payload.part as Record<string, unknown> : {}
  if (nativeSubmission && (nativeSubmission.kind !== 'message' || nativeSubmission.nativeSessionId !== session.nativeSessionId
    || event.payload.nativeSessionId !== session.nativeSessionId || event.payload.clientCorrelationId !== nativeSubmission.clientCorrelationId
    || turnId !== null)) throw new Error('Native message source differs from its observed receipt.')
  const nativeItemId = session.harness === 'claude' ? event.payload.toolUseId ?? event.payload.taskId ?? event.payload.messageUuid
    : item.id ?? part.id ?? event.payload.itemId
  return { native: { harness: session.harness, sessionId: session.nativeSessionId, ...(turnId ? { turnId } : {}),
    ...(typeof nativeItemId === 'string' ? { itemId: nativeItemId } : {}) }, ...(event.connectionId ? { connectionId: event.connectionId } : {}), nativeSessionId: session.nativeSessionId, ...(turnId ? { nativeTurnId: turnId } : {}), ...(nativeSubmission ? { nativeSubmission } : {}), authoritativeReconciliation,
    source: { system: `${session.harness}_${authoritativeReconciliation ? 'history' : 'transport'}`, observedAt: event.occurredAt,
      ...(!authoritativeReconciliation && event.connectionId && Number.isSafeInteger(event.sequence)
        ? { transportSequence: event.sequence } : {}) } }
}
