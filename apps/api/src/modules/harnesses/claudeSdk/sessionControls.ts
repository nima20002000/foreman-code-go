import type { ContextSnapshot, SessionPreferences } from '@graphql/contracts'
import { SessionPreferencesSchema } from '@graphql/contracts'
import { HarnessExecutionError } from '../errors.js'

export function claudeSessionEnvironment(source: NodeJS.ProcessEnv, raw: SessionPreferences): NodeJS.ProcessEnv {
  const preferences = SessionPreferencesSchema.parse(raw)
  const env = { ...source }
  delete env.DISABLE_AUTO_COMPACT
  delete env.DISABLE_COMPACT
  delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (preferences.autoCompact === 'off') env.DISABLE_AUTO_COMPACT = '1'
  if (preferences.autoCompactTokens !== null) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(preferences.autoCompactTokens)
  if (preferences.contextBudget !== null || preferences.contextProfile !== null) {
    throw new HarnessExecutionError('CLAUDE_CONTEXT_UNSUPPORTED', 'This installation has no qualified context-profile override.')
  }
  return env
}

export function claudeContextSnapshot(frame: Record<string, unknown>, sessionId: string, model: string,
  sequence: number): ContextSnapshot | null {
  if (frame.session_id !== sessionId || frame.type !== 'assistant') return null
  const message = frame.message as { usage?: Record<string, unknown> } | undefined
  const usage = message?.usage
  if (!usage || typeof usage.input_tokens !== 'number') return null
  const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
  const cacheCreated = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0
  return { nativeSessionId: sessionId, model, sequence, observedAt: new Date().toISOString(), source: 'claude',
    accuracy: 'estimated', usedTokens: usage.input_tokens + cacheRead + cacheCreated,
    capacityTokens: null, lifetimeTokens: null, cost: null, stale: false }
}
