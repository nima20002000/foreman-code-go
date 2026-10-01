import type { NativeHarnessEvent, NativeSessionReference } from '@graphql/contracts'
import type { ActivityMutationFence } from './operatorActivityRepository.js'

/** Harness sequence numbers are transport-local, never a provider/global watermark. */
export function nativeActivityFence(session: NativeSessionReference, turnId: string, event: NativeHarnessEvent,
  authoritativeReconciliation = false): ActivityMutationFence {
  return { nativeSessionId: session.nativeSessionId, nativeTurnId: turnId, authoritativeReconciliation,
    source: { system: `${session.harness}_${authoritativeReconciliation ? 'history' : 'transport'}`, observedAt: event.occurredAt,
      ...(!authoritativeReconciliation && event.connectionId && Number.isSafeInteger(event.sequence)
        ? { connectionId: event.connectionId, sequence: String(event.sequence) } : {}) } }
}
