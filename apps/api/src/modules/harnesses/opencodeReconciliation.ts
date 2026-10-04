import type { NativeHarnessEvent, NativeSessionReference } from '@foreman-code/contracts'

/** Adapter-owned observation, NOT an OpenCode wire event or a Codex turn event.
 * Raw message/part history keeps its content-addressed source identities. */
export const OPENCODE_RECONCILIATION_EVENT = 'graphql.opencode.turn.reconciled'

export interface OpenCodeReconciliation {
  version: 1
  provider: 'opencode'
  providerVersion: string
  ownerAgentId: string
  correlationId: string
  nativeSessionId: string
  nativeTurnId: string
  terminalMessageId: string
  outcome: 'succeeded' | 'failed'
  historyComplete: true
  statusBefore: 'idle'
  statusAfter: 'idle'
  pendingInteractions: 0
  historySource: { connectionId: string; sequence: number; nativeEventId: string }
}
export interface OpenCodeReconciliationIdentity {
  ownerAgentId: string
  correlationId: string
  nativeSessionId: string
  nativeTurnId: string
  providerVersion?: string
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
}

/** Only the manager's rooted, complete, idle-before/after scan calls this. It
 * references the selected raw assistant; it never rewrites that assistant's ID.
 * No result text, receipt, permission response or keepalive is terminal proof. */
export function openCodeReconciliationPayload(session: NativeSessionReference, ownerAgentId: string,
  correlationId: string, nativeTurnId: string, source: NativeHarnessEvent,
  outcome: 'succeeded' | 'failed'): Record<string, unknown> | undefined {
  const info = object(source.payload.info)
  const proof: OpenCodeReconciliation = { version: 1, provider: 'opencode', providerVersion: session.providerVersion,
    ownerAgentId, correlationId, nativeSessionId: session.nativeSessionId, nativeTurnId,
    terminalMessageId: typeof info.id === 'string' ? info.id : '', outcome,
    historyComplete: true, statusBefore: 'idle', statusAfter: 'idle', pendingInteractions: 0,
    historySource: { connectionId: source.connectionId ?? '', sequence: source.sequence,
      nativeEventId: typeof source.payload.nativeEventId === 'string' ? source.payload.nativeEventId : '' } }
  if (session.harness !== 'opencode' || !matchesOpenCodeHistorySource(proof, source)) return undefined
  return { sessionID: session.nativeSessionId, reconciliation: proof }
}

/** Decode only the reserved adapter observation, never an arbitrary finished
 * assistant in a page. Selection/compaction authority belongs to the full scan. */
export function readOpenCodeReconciliation(event: NativeHarnessEvent,
  expected: OpenCodeReconciliationIdentity): OpenCodeReconciliation | undefined {
  if (event.type !== OPENCODE_RECONCILIATION_EVENT) return undefined
  const value = object(event.payload.reconciliation), source = object(value.historySource)
  if (value.version !== 1 || value.provider !== 'opencode' || !text(value.providerVersion)
    || !text(value.ownerAgentId) || !text(value.correlationId) || !text(value.nativeSessionId)
    || !text(value.nativeTurnId) || !text(value.terminalMessageId)
    || !['succeeded', 'failed'].includes(String(value.outcome)) || value.historyComplete !== true
    || value.statusBefore !== 'idle' || value.statusAfter !== 'idle' || value.pendingInteractions !== 0
    || !text(source.connectionId) || !source.connectionId.startsWith('history-')
    || source.sequence !== 0 || !text(source.nativeEventId)
    || !source.nativeEventId.startsWith(`message:${value.terminalMessageId}:`)
    || !text(event.connectionId) || event.connectionId === source.connectionId
    || !Number.isSafeInteger(event.sequence) || event.sequence < 0
    || event.payload.sessionID !== expected.nativeSessionId
    || value.nativeSessionId !== expected.nativeSessionId || value.ownerAgentId !== expected.ownerAgentId
    || value.correlationId !== expected.correlationId || value.nativeTurnId !== expected.nativeTurnId
    || expected.providerVersion !== undefined && value.providerVersion !== expected.providerVersion) return undefined
  return value as unknown as OpenCodeReconciliation
}

/** A rejected, omitted or absent raw source cannot be promoted by an otherwise
 * well-shaped adapter receipt. Callers also check the durable normalization. */
export function matchesOpenCodeHistorySource(proof: OpenCodeReconciliation, source: NativeHarnessEvent): boolean {
  const info = object(source.payload.info), time = object(info.time)
  if (source.type !== 'message.updated' || source.payload.payloadOmitted === true
    || source.connectionId !== proof.historySource.connectionId || source.sequence !== proof.historySource.sequence
    || source.payload.nativeEventId !== proof.historySource.nativeEventId
    || !source.connectionId?.startsWith('history-') || source.sequence !== 0
    || info.id !== proof.terminalMessageId || info.sessionID !== proof.nativeSessionId || info.role !== 'assistant') return false
  if (proof.outcome === 'failed') return !!info.error
  return !info.error && info.summary !== true && typeof time.completed === 'number' && Number.isFinite(time.completed)
    && typeof info.finish === 'string' && !['tool-calls', 'unknown', 'error'].includes(info.finish)
}
