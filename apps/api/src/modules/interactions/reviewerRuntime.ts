import type { NativeSessionReference, PendingNativeInteraction, ReviewJob } from '@graphql/contracts'

import type { NativePersistenceRedactor } from './nativePersistence.js'
import type { InteractionNativeRuntime } from './runtimePorts.js'

export interface ReviewCredentialMaintenance {
  signal: AbortSignal
  stop(): Promise<void>
  /** Revoke only the captured process principal, never a replacement execution owner. */
  invalidate(): Promise<void>
}

/** Reviewer-only hooks; the shared workflow/Operator runtime port is unchanged. */
export interface ReviewerNativeRuntime extends InteractionNativeRuntime {
  reviewPersistence?(executionId: string): NativePersistenceRedactor
  maintainReviewCredential?(executionId: string, session: NativeSessionReference, signal: AbortSignal,
    assertOwned: () => Promise<void>): Promise<ReviewCredentialMaintenance>
  recordReviewFailure?(executionId: string, job: ReviewJob, error: NonNullable<ReviewJob['error']>,
    pending?: PendingNativeInteraction, pendingRequests?: readonly PendingNativeInteraction[]): Promise<void>
}
