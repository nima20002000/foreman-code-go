import { SendOperatorMessageRequestSchema, type SendOperatorMessageRequest } from '@graphql/contracts'
import { protectedKey } from '../../shared/api/protectedChatStorage'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'

export function readPendingOperatorMessage(id: string): { command?: SendOperatorMessageRequest; error?: string } {
  try {
    const value = window.localStorage.getItem(protectedKey('outbox', id))
    if (value === null) return {}
    const result = SendOperatorMessageRequestSchema.safeParse(JSON.parse(value))
    return result.success ? { command: result.data } : { error: 'The saved pending command is invalid. Recover its receipt before sending another command.' }
  } catch { return { error: 'Durable message storage is unavailable. Sending is disabled to avoid repeating a command after a lost response.' } }
}

/** Reservation happens before a mutation, not on each network delivery attempt. */
export function reserveOperatorMessage(id: string, content: string, route: string): SendOperatorMessageRequest {
  if (sessionIsSwitching()) throw new Error('Operator access is changing.')
  const pending = readPendingOperatorMessage(id)
  if (pending.error) throw new Error(pending.error)
  if (pending.command) {
    if (pending.command.content !== content) throw new Error('Retry the previous pending message before sending a different command. Your new draft is preserved.')
    return pending.command // Includes the originally accepted route context.
  }
  const command = SendOperatorMessageRequestSchema.parse({ requestId: crypto.randomUUID(), content, context: { route } })
  const key = protectedKey('outbox', id)
  window.localStorage.setItem(key, JSON.stringify(command))
  if (readPendingOperatorMessage(id).command?.requestId !== command.requestId) throw new Error('The pending command could not be saved. No message was sent.')
  return command
}
export function acknowledgeOperatorMessage(id: string, requestId: string): void {
  const pending = readPendingOperatorMessage(id)
  if (pending.command?.requestId === requestId) window.localStorage.removeItem(protectedKey('outbox', id))
}
