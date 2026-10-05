import type { NativeSessionReference, PendingNativeInteraction } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from './port.js'

/** Read-only exact-request inquiry. Inspection must not attach, start, auto-reply or reconcile a response. */
export interface NativeResponseAvailabilityQuery {
  nativeRequestId: string
  nativeRequestType: string
  expectedNativeTurnId?: string
  expectedNativeMessageId?: string
  expectedGeneration?: string
}
export interface NativeResponseAvailability {
  nativeSessionId: string
  nativeRequestId: string
  nativeRequestType: string
  nativeTurnId?: string
  nativeMessageId?: string
  /** Current owned provider runtime/callback generation; never an arrival counter. */
  generation?: string
  qualified: boolean
  state: 'available' | 'recovery_required' | 'unavailable'
  path: 'live_callback' | 'qualified_recovery' | null
  reason: 'live_callback' | 'qualified_recovery' | 'request_consumed' | 'callback_lost' | 'session_closed'
    | 'unqualified' | 'identity_mismatch' | 'response_in_flight' | 'unsupported'
}
export interface ResponseAvailabilityInspector {
  inspectResponseAvailability?(session: NativeSessionReference, query: NativeResponseAvailabilityQuery,
    signal?: AbortSignal): Promise<NativeResponseAvailability>
}

export function unavailableNativeResponse(session: NativeSessionReference, query: NativeResponseAvailabilityQuery,
  reason: NativeResponseAvailability['reason'] = 'callback_lost'): NativeResponseAvailability {
  return { nativeSessionId: session.nativeSessionId, nativeRequestId: query.nativeRequestId,
    nativeRequestType: query.nativeRequestType, ...(query.expectedNativeTurnId ? { nativeTurnId: query.expectedNativeTurnId } : {}),
    qualified: false, state: 'unavailable', path: null, reason }
}

/** A persistence row is provenance, not proof of an available callback. Missing inspectors fail closed. */
export async function inspectNativeResponse(manager: NativeHarnessSessionManager & ResponseAvailabilityInspector,
  session: NativeSessionReference, query: NativeResponseAvailabilityQuery, input: { signal?: AbortSignal; isCurrent(): boolean }): Promise<NativeResponseAvailability> {
  if (!input.isCurrent() || input.signal?.aborted) return unavailableNativeResponse(session, query, 'session_closed')
  if (!manager.inspectResponseAvailability) return unavailableNativeResponse(session, query, 'unsupported')
  let result: NativeResponseAvailability
  try { result = await manager.inspectResponseAvailability(session, query, input.signal) }
  catch { return unavailableNativeResponse(session, query, 'callback_lost') }
  if (!input.isCurrent() || input.signal?.aborted) return unavailableNativeResponse(session, query, 'session_closed')
  return normalizeResponseAvailability(session, query, result)
}

export function normalizeResponseAvailability(session: NativeSessionReference, query: NativeResponseAvailabilityQuery,
  result: NativeResponseAvailability): NativeResponseAvailability {
  if (result.nativeSessionId !== session.nativeSessionId || result.nativeRequestId !== query.nativeRequestId
    || result.nativeRequestType !== query.nativeRequestType
    || query.expectedNativeTurnId !== undefined && result.nativeTurnId !== query.expectedNativeTurnId
    || query.expectedNativeMessageId !== undefined && result.nativeMessageId !== query.expectedNativeMessageId
    || query.expectedGeneration !== undefined && result.generation !== query.expectedGeneration) {
    return unavailableNativeResponse(session, query, 'identity_mismatch')
  }
  if (result.state === 'available' && (!result.qualified || !result.generation || !result.path
    || result.reason !== result.path)) {
    return unavailableNativeResponse(session, query, 'unqualified')
  }
  return result
}

export function pendingResponseQuery(pending: PendingNativeInteraction): NativeResponseAvailabilityQuery | undefined {
  if (!pending.turn.nativeRequestId) return undefined
  const generation = pending.session.harness === 'claude' && pending.request && typeof pending.request === 'object'
    && !Array.isArray(pending.request) && typeof pending.request.generation === 'string' && pending.request.generation.length
    ? pending.request.generation : undefined
  return { nativeRequestId: pending.turn.nativeRequestId, nativeRequestType: pending.nativeRequestType,
    ...(pending.turn.nativeTurnId ? { expectedNativeTurnId: pending.turn.nativeTurnId } : {}),
    ...(pending.turn.nativeMessageId ? { expectedNativeMessageId: pending.turn.nativeMessageId } : {}),
    ...(generation ? { expectedGeneration: generation } : {}) }
}
