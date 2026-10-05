import { identityChangedEvent, identityEpochKey, rotateProtectedSession } from './protectedChatStorage'
import { rotateSessionController, sessionControllerSignal } from './sessionController'

/** A document-lifetime boundary. Old requests cannot enter a different app instance. */
let generation = 0
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
export function sessionSignal(): AbortSignal { return sessionControllerSignal() }
export function sessionIsSwitching(): boolean { return switching }

export function beginSessionChange(): number {
  switching = true
  rotateProtectedSession()
  rotateSessionController(new SessionChangedError())
  return ++generation
}

export function finishSessionChange(): void {
  rotateSessionController(new SessionChangedError())
  ++generation
  switching = false
}

if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key !== identityEpochKey || event.oldValue === event.newValue) return
  switching = true
  rotateSessionController(new SessionChangedError())
  ++generation
  window.dispatchEvent(new Event(identityChangedEvent))
  // A different app instance must not receive drafts or requests from this document.
  window.location.reload()
})
