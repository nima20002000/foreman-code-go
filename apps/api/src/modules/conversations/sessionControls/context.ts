import type { ContextSnapshot } from '@graphql/contracts'

export function mergeContextSnapshot(previous: ContextSnapshot | null, incoming: ContextSnapshot,
  sessionId: string, model: string | null): ContextSnapshot | null {
  if (incoming.nativeSessionId !== sessionId || model !== null && incoming.model !== model) return previous
  if (!previous || previous.nativeSessionId !== sessionId || previous.model !== incoming.model) return incoming
  if (incoming.generation === previous.generation && incoming.sequence < previous.sequence) return previous
  if (incoming.generation !== previous.generation && incoming.observedAt < previous.observedAt) return previous
  return incoming
}
