import type { SessionControlBinding } from './store.js'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { HarnessExecutionError } from '../../harnesses/errors.js'

export function isNativeSessionUnloaded(error: unknown, session: NativeSessionReference) {
  const unavailableCode = {
    codex: 'CODEX_SESSION_UNAVAILABLE',
    claude: 'CLAUDE_SESSION_UNAVAILABLE',
    opencode: 'OPENCODE_SESSION_CONTEXT_MISSING',
  }[session.harness]
  return error instanceof HarnessExecutionError && error.result.error?.code === unavailableCode
}

export async function readNativeCapabilities(binding: SessionControlBinding) {
  const { manager, session } = binding
  if (!manager || !session) return null
  try {
    return { capabilities: await manager.sessionControlCapabilities?.(session) }
  } catch (error) {
    if (isNativeSessionUnloaded(error, session)) return null
    throw error
  }
}

export function readNativeSnapshot(binding: SessionControlBinding) {
  const { manager, session } = binding
  if (!manager || !session) return null
  try {
    return {
      applied: manager.appliedSessionPreferences?.(session) ?? null,
      context: manager.contextSnapshot?.(session) ?? null,
    }
  } catch (error) {
    if (isNativeSessionUnloaded(error, session)) return null
    throw error
  }
}
