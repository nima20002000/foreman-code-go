export const identityEpochKey = 'graphql.identity-epoch'
export const identityChangedEvent = 'graphql:identity-changed'
export const chatStoragePrefix = 'graphql.chat:'
let volatileEpoch: string | undefined

function freshEpoch(): string {
  return globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
export function identityEpoch(): string {
  try {
    const stored = window.localStorage.getItem(identityEpochKey)
    if (stored && /^[A-Za-z0-9-]{1,100}$/.test(stored)) { volatileEpoch = stored; return stored }
    const next = volatileEpoch ??= freshEpoch()
    window.localStorage.setItem(identityEpochKey, next)
    return next
  } catch { return volatileEpoch ??= freshEpoch() }
}
export function protectedKey(kind: 'draft' | 'ui' | 'outbox', id = ''): string {
  return `${chatStoragePrefix}${identityEpoch()}:${kind}:${encodeURIComponent(id)}`
}
export function rotateProtectedSession(): void {
  const epoch = freshEpoch()
  volatileEpoch = epoch
  try { window.localStorage.setItem(identityEpochKey, epoch) } catch { /* Inaccessible storage cannot leak a saved draft. */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(identityChangedEvent))
}
export interface ChatPreferences { open: boolean; historyOpen: boolean; selectedConversationId?: string }
export function parseChatPreferences(value: unknown): Partial<ChatPreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const data = value as Record<string, unknown>
  if ((data.open !== undefined && typeof data.open !== 'boolean')
    || (data.historyOpen !== undefined && typeof data.historyOpen !== 'boolean')
    || (data.selectedConversationId !== undefined && (typeof data.selectedConversationId !== 'string' || !data.selectedConversationId.trim()))) return {}
  return { ...(typeof data.open === 'boolean' ? { open: data.open } : {}),
    ...(typeof data.historyOpen === 'boolean' ? { historyOpen: data.historyOpen } : {}),
    ...(typeof data.selectedConversationId === 'string' ? { selectedConversationId: data.selectedConversationId } : {}) }
}
