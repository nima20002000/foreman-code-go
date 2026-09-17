import type { NativeSessionReference, PendingNativeInteraction, ReviewJob } from '@graphql/contracts'

import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { NativePersistenceRedactor } from './nativePersistence.js'
import type { InteractionNativeRuntime } from './runtimePorts.js'

export interface ReviewCredentialMaintenance {
  signal: AbortSignal
  principalId?: string
  stop(): Promise<void>
  /** Revoke only the captured process principal, never a replacement execution owner. */
  invalidate(): Promise<void>
}

/** Cleanup attachment must never start a process, issue credentials, or replay native work. */
export interface ReviewCleanupSession {
  manager: NativeHarnessSessionManager
  resident: boolean
  closed: boolean
  confirmClosed?(signal: AbortSignal): Promise<boolean>
}

/** Reviewer-only hooks; the shared workflow/Operator runtime port is unchanged. */
export interface ReviewerNativeRuntime extends InteractionNativeRuntime {
  reviewCredentialIdentity?(executionId: string, session: NativeSessionReference): { required: boolean; principalId?: string }
  revokeReviewCredential?(principalId: string): Promise<void>
  recoverReviewCleanup?(executionId: string, session: NativeSessionReference, job: ReviewJob,
    signal: AbortSignal): Promise<ReviewCleanupSession>
  reviewPersistence?(executionId: string): NativePersistenceRedactor
  maintainReviewCredential?(executionId: string, session: NativeSessionReference, signal: AbortSignal,
    assertOwned: () => Promise<void>): Promise<ReviewCredentialMaintenance>
  recordReviewFailure?(executionId: string, job: ReviewJob, error: NonNullable<ReviewJob['error']>,
    pending?: PendingNativeInteraction, pendingRequests?: readonly PendingNativeInteraction[]): Promise<void>
}
