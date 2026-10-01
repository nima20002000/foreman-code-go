import type { NativeHarnessEvent, NativeSessionReference } from '@graphql/contracts'
import type { ActivityMutationFence } from './operatorActivityRepository.js'

/** Harness sequence numbers are transport-local, never a provider/global watermark. */
export function nativeActivityFence(session: NativeSessionReference, turnId: string, event: NativeHarnessEvent,
  authoritativeReconciliation = false): ActivityMutationFence {
  const item = event.payload.item && typeof event.payload.item === 'object' && !Array.isArray(event.payload.item)
    ? event.payload.item as Record<string, unknown> : {}
  const part = event.payload.part && typeof event.payload.part === 'object' && !Array.isArray(event.payload.part)
    ? event.payload.part as Record<string, unknown> : {}
  const nativeItemId = item.id ?? part.id ?? event.payload.itemId
  return { native: { harness: session.harness, sessionId: session.nativeSessionId, turnId,
    ...(typeof nativeItemId === 'string' ? { itemId: nativeItemId } : {}) }, ...(event.connectionId ? { connectionId: event.connectionId } : {}), nativeSessionId: session.nativeSessionId, nativeTurnId: turnId, authoritativeReconciliation,
    source: { system: `${session.harness}_${authoritativeReconciliation ? 'history' : 'transport'}`, observedAt: event.occurredAt,
      ...(!authoritativeReconciliation && event.connectionId && Number.isSafeInteger(event.sequence)
        ? { transportSequence: event.sequence } : {}) } }
}
