import type { AgentChatState } from '@foreman-code/contracts/agent-chat'
import { chatBusy } from './model'

export function agentChatStateLabel(state?: AgentChatState, runLabel?: string): string {
  if (!state) return 'Starting'
  if (state.sessionState === 'creating') return 'Starting'
  if (chatBusy(state)) return 'Working'
  if (state.sessionState === 'error' || state.lastResult?.outcome === 'failed') return 'Failed'
  if (!state.conversation && runLabel?.startsWith('Checking')) return runLabel
  if (!state.conversation && state.sourceTranscript) {
    if (state.sourceTranscript.state === 'starting' || state.sourceTranscript.state === 'queued') return 'Starting'
    if (state.sourceTranscript.state !== 'completed') return 'Working'
    return runLabel === 'Failed' ? 'Failed' : 'Completed'
  }
  if (state.turns.at(-1)?.delivery === 'failed') return 'Failed'
  if (state.turns.at(-1)?.delivery === 'completed') return 'Completed'
  return 'Idle'
}

