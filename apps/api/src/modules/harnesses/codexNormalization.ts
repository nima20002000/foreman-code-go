import { isObject, text, type JsonObject } from './codexStdioTransport.js'

/** Input has passed the installation's qualified protocol schema. Native IDs
 * remain optional when the provider did not supply them. Ordinal is arrival
 * order within this connection, not a durable activity revision. */
export interface CodexNotificationEnvelope {
  providerVersion: string
  schemaIdentity: string
  connectionId: string
  runtimeGeneration: number
  arrivalOrdinal: number
  method: string
  params: JsonObject
}
export interface CodexNotificationOwner {
  threadId: string
  turnId?: string
  runtimeGeneration: number
  terminal: boolean
}

/** Pure classification, with no state store or synthesized parent/root IDs.
 * Foreign thread evidence is retained separately and can never mutate the root
 * turn. W05 owns later child linkage and durable projection. */
export function normalizeCodexNotification(owner: CodexNotificationOwner, envelope: CodexNotificationEnvelope) {
  const { method, params } = envelope
  if (envelope.runtimeGeneration !== owner.runtimeGeneration) return { kind: 'ignored' as const, reason: 'stale_generation' }
  const threadId = text(params.threadId) ?? (method === 'thread/started' && isObject(params.thread) ? text(params.thread.id) : undefined)
  const turn = isObject(params.turn) ? params.turn : undefined
  const turnId = text(params.turnId) ?? text(turn?.id)
  const item = isObject(params.item) ? params.item : undefined
  const itemId = text(params.itemId) ?? text(item?.id)
  const evidence = { ...envelope, ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}), ...(itemId ? { itemId } : {}) }
  if (threadId && threadId !== owner.threadId) return { kind: 'unlinked' as const, evidence }
  const exactThread = ['serverRequest/resolved', 'turn/started', 'turn/completed', 'item/started', 'item/completed'].includes(method)
  if (exactThread && threadId !== owner.threadId) return { kind: 'ignored' as const, reason: 'missing_thread' }
  if (turnId !== undefined && (turnId !== owner.turnId || owner.terminal)) return { kind: 'ignored' as const, reason: 'inactive_turn' }
  if (method === 'turn/started' || method === 'turn/completed') {
    if (!turnId || !turn || !Array.isArray(turn.items) || !['inProgress', 'completed', 'failed', 'interrupted'].includes(String(turn.status))
      || (method === 'turn/completed' && turn.status === 'inProgress')) return { kind: 'ignored' as const, reason: 'invalid_turn' }
    return { kind: 'turn' as const, evidence, turn, terminal: turn.status !== 'inProgress' }
  }
  if (method === 'item/started' || method === 'item/completed') {
    if (!turnId || !item || !itemId || !text(item.type)) return { kind: 'ignored' as const, reason: 'invalid_item' }
    return { kind: 'item' as const, evidence, item, completed: method === 'item/completed' }
  }
  if (method === 'item/agentMessage/delta') {
    if (!turnId || !itemId || typeof params.delta !== 'string') return { kind: 'ignored' as const, reason: 'invalid_delta' }
    return { kind: 'delta' as const, evidence, delta: params.delta }
  }
  // Resolution observes answered OR cleared; it is not a response-delivery receipt.
  if (method === 'serverRequest/resolved') return { kind: 'resolved' as const, evidence, responseDelivery: 'unknown' as const }
  return { kind: 'notification' as const, evidence }
}
