import { chatStoragePrefix, identityChangedEvent, identityEpochKey, rotateProtectedSession } from './protectedChatStorage'

/** A document-lifetime boundary. Old requests cannot enter a new Operator session. */
let generation = 0
let controller = new AbortController()
let switching = false

export class SessionChangedError extends Error {
  constructor() {
    super('Operator access changed. Reload this view before continuing.')
    this.name = 'AbortError'
  }
}

export function sessionGeneration(): number { return generation }
export function assertSession(expected: number): void {
  if (expected !== generation) throw new SessionChangedError()
}
export function sessionSignal(): AbortSignal { return controller.signal }
export function sessionIsSwitching(): boolean { return switching }

export function beginSessionChange(): number {
  switching = true
  rotateProtectedSession()
  controller.abort(new SessionChangedError())
  controller = new AbortController()
  return ++generation
}

export function finishSessionChange(): void {
  controller.abort(new SessionChangedError())
  controller = new AbortController()
  ++generation
  switching = false
}

/** Only these app-owned persisted records contain protected agent snapshots. */
export function clearProtectedStorage(storage: Pick<Storage, 'length' | 'key' | 'removeItem'>): void {
  const keys: string[] = []
  for (let i = 0; i < storage.length; ++i) {
    const key = storage.key(i)
    if (key?.startsWith('graphql-local-agents:') || key?.startsWith('graphql-deleted-agents:')
      || key?.startsWith(chatStoragePrefix) || key === 'graphql.conversation-drafts' || key === 'graphql.operator-chat.ui') keys.push(key)
  }
  for (const key of keys) storage.removeItem(key)
}

if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key !== identityEpochKey || event.oldValue === event.newValue) return
  switching = true
  controller.abort(new SessionChangedError())
  ++generation
  window.dispatchEvent(new Event(identityChangedEvent))
  // Cookies are shared by tabs. Old closures and cached data must not survive enrollment elsewhere.
  window.location.reload()
})
