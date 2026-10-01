import type { NativeResponseAvailability, NativeResponseAvailabilityQuery } from '../responseAvailability.js'

/** Lookup in the actual SDK callback map, not a database interaction/pending-row lookup. */
export interface ClaudeLiveCallbackQuery extends NativeResponseAvailabilityQuery {
  nativeSessionId: string
  nativeMessageId: string
  generation: string
}
export interface ClaudeLiveCallbackReader {
  inspectCallbackAvailability(query: ClaudeLiveCallbackQuery): NativeResponseAvailability | Promise<NativeResponseAvailability>
}
export interface ClaudeNativeCallbackContext {
  nativeSessionId: string
  nativeMessageId: string
  clientCorrelationId: string
  /** Opaque process-local callback lifetime identity; not a native message/turn ID. */
  generation: string
}

/** Captured from the accepted application message before offer; never inferred from latest actor state. */
export interface ClaudeCallbackAuthority {
  ownerPrincipalId: string
  attemptId: string
}
export interface ClaudePendingNotification {
  nativeSessionId: string
  nativeMessageId: string
  clientCorrelationId: string
  generation: string
  nativeRequestId: string
  nativeRequestType: 'can_use_tool'
}
