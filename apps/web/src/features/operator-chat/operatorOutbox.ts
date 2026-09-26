import { SendOperatorMessageRequestSchema, type SendOperatorMessageRequest } from '@graphql/contracts'
import { protectedKey } from '../../shared/api/protectedChatStorage'
import { assertSession, sessionGeneration, sessionIsSwitching, sessionSignal, SessionChangedError } from '../../shared/api/sessionBoundary'

const outboxLock = 'graphql.operator-outbox.v1'
const storageError = 'Durable message storage is unavailable. Sending is disabled to avoid repeating a command after a lost response.'

type PendingMessage = { command?: SendOperatorMessageRequest; error?: string; sendFailure?: string }

function readKey(key: string): PendingMessage {
  try {
    const value = window.localStorage.getItem(key)
    if (value === null) return {}
    const saved = JSON.parse(value)
    const command = SendOperatorMessageRequestSchema.safeParse(saved?.command ?? saved)
    if (command.success && (saved?.command === undefined || typeof saved?.sendFailure === 'string')) {
      return { command: command.data, ...(typeof saved?.sendFailure === 'string' ? { sendFailure: saved.sendFailure } : {}) }
    }
    return { error: 'The saved pending command is invalid. Recover its receipt before sending another command.' }
  } catch { return { error: storageError } }
}

export function readPendingOperatorMessage(id: string): PendingMessage {
  try { return readKey(protectedKey('outbox', id)) } catch { return { error: storageError } }
}

/** Keep a failed delivery reason with the exact pending command across reloads. */
export function recordOperatorMessageFailure(id: string, requestId: string, message: string): Promise<void> {
  return exclusive(id, (key) => {
    const pending = readKey(key)
    if (pending.error || pending.command?.requestId !== requestId) return
    window.localStorage.setItem(key, JSON.stringify({ command: pending.command, sendFailure: message }))
  })
}

/** Cross-document exclusion, not a same-tab mutex or a read/write/read storage guess. */
async function exclusive<T>(id: string, work: (key: string) => T): Promise<T> {
  if (sessionIsSwitching()) throw new SessionChangedError()
  const generation = sessionGeneration()
  const key = protectedKey('outbox', id)
  const locks = globalThis.navigator?.locks
  if (!locks) throw new Error('This browser cannot safely coordinate Operator messages across tabs. Use a browser with Web Locks enabled in a secure context.')
  return locks.request(outboxLock, { mode: 'exclusive', signal: sessionSignal() }, () => {
    const check = () => {
      assertSession(generation)
      // Storage events may not have reached this tab yet. Compare the durable
      // identity epoch directly, both after waiting for the lock and after work.
      if (sessionIsSwitching() || key !== protectedKey('outbox', id)) throw new SessionChangedError()
    }
    check()
    const value = work(key) // Synchronous, bounded storage work only; no HTTP under this lock.
    check()
    return value
  })
}

/** Reserve once before submission. Every tab and every lost-response retry reuses that identity. */
export function reserveOperatorMessage(id: string, content: string, route: string): Promise<SendOperatorMessageRequest> {
  return exclusive(id, (key) => {
    const pending = readKey(key)
    if (pending.error) throw new Error(pending.error)
    if (pending.command) {
      if (pending.command.content !== content) throw new Error('Retry the previous pending message before sending a different command. Your new draft is preserved.')
      return pending.command // Includes the originally accepted route context.
    }
    const command = SendOperatorMessageRequestSchema.parse({ requestId: crypto.randomUUID(), content, context: { route } })
    window.localStorage.setItem(key, JSON.stringify(command))
    if (readKey(key).command?.requestId !== command.requestId) throw new Error('The pending command could not be saved. No message was sent.')
    return command
  })
}

/** Guard the actual network boundary as well as initial reservation, including a stale retry button. */
export function assertOperatorMessageReserved(id: string, command: SendOperatorMessageRequest): void {
  if (sessionIsSwitching()) throw new SessionChangedError()
  const pending = readPendingOperatorMessage(id)
  if (pending.error) throw new Error(pending.error)
  if (!pending.command || JSON.stringify(pending.command) !== JSON.stringify(SendOperatorMessageRequestSchema.parse(command))) {
    throw new Error('The pending message changed or was acknowledged in another tab. Reload its receipt; no new request identity was generated.')
  }
}

/** Compare-and-remove shares the reservation lock, so a late ACK cannot erase a newer request. */
export function acknowledgeOperatorMessage(id: string, requestId: string): Promise<boolean> {
  return exclusive(id, (key) => {
    const pending = readKey(key)
    if (pending.error) throw new Error(pending.error)
    if (pending.command?.requestId !== requestId) return false
    window.localStorage.removeItem(key)
    return true
  })
}
