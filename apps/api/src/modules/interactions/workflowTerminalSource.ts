import type { HarnessExecution, NativeSessionReference } from '@foreman-code/contracts'
import type { NativeHistory } from '../harnesses/port.js'
import { matchesOpenCodeHistorySource, readOpenCodeReconciliation } from '../harnesses/opencodeReconciliation.js'
import { DomainError } from '../errors.js'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function outcome(status: unknown): 'succeeded' | 'failed' | 'canceled' | undefined {
  return status === 'completed' ? 'succeeded' : status === 'failed' ? 'failed' : status === 'interrupted' ? 'canceled' : undefined
}

/** Claude identifies its turn by the exact submitted message; Codex/OpenCode by the provider turn. */
export function pinnedWorkflowTurn(session: NativeSessionReference, history: NativeHistory): string | undefined {
  if (session.harness !== 'claude') return history.nativeTurnId
  return history.nativeSubmission?.kind === 'message' ? history.nativeSubmission.nativeMessageId : undefined
}

/** Used only AFTER private original-source capture verification. Convenience
 * NativeHistory terminal fields and abort ACKs are not positive provider proof.
 * Require the matching original terminal frame or the rooted OpenCode history
 * marker AND its referenced raw assistant, without rewriting either source. */
export function assertOriginalWorkflowTerminal(execution: Pick<HarnessExecution, 'id' | 'agentId'>,
  session: NativeSessionReference, history: NativeHistory): void {
  const command = `execution:${execution.id}`, terminal = history.terminalTurn
  const fail = (reason: string): never => { throw new DomainError('NATIVE_TERMINAL_SOURCE_REQUIRED',
    'The exact original native terminal frame and pinned turn are required.', 409, { reason }) }
  if (!terminal) return fail('terminal_missing')
  if (terminal.correlationId !== command || history.correlationId !== command) return fail('correlation_mismatch')
  if (!terminal.providerId || terminal.providerId !== pinnedWorkflowTurn(session, history)) return fail('turn_mismatch')
  if (history.pendingInteraction || history.pendingInteractions.length) return fail('interaction_pending')
  if (session.harness === 'opencode') {
    for (const event of history.events) {
      const proof = readOpenCodeReconciliation(event, { ownerAgentId: execution.agentId,
        nativeSessionId: session.nativeSessionId, providerVersion: session.providerVersion,
        correlationId: command, nativeTurnId: terminal.providerId })
      if (proof && proof.outcome === terminal.result.outcome && history.events.some((source) => matchesOpenCodeHistorySource(proof, source))) return
    }
    return fail('opencode_frame_missing')
  }
  if (session.harness === 'claude') {
    // Claude's owned SDK query records its result frame as turn.completed for the exact submitted message.
    if (history.events.some(event => event.type === 'turn.completed'
      && object(event.payload).nativeSessionId === session.nativeSessionId
      && object(event.payload).nativeMessageId === terminal.providerId
      && object(event.payload).clientCorrelationId === command
      && object(object(event.payload).result).outcome === terminal.result.outcome)) return
    return fail('claude_frame_missing')
  }
  if (session.harness !== 'codex') return fail('unsupported_harness')
  for (const event of history.events) {
    const payload = object(event.payload), turn = object(payload.turn)
    if ((event.type === 'turn.completed' || event.type === 'turn/completed')
      && payload.threadId === session.nativeSessionId
      && (payload.turnId ?? turn.id) === terminal.providerId
      && (payload.clientCorrelationId === undefined || payload.clientCorrelationId === command)
      && outcome(payload.status ?? turn.status) === terminal.result.outcome) return
    if (event.type !== 'thread.reconciled' && event.type !== 'thread.attached') continue
    const thread = object(payload.thread)
    if (thread.id !== session.nativeSessionId || !Array.isArray(thread.turns)) continue
    for (const raw of thread.turns) {
      const current = object(raw)
      if (current.id === terminal.providerId && outcome(current.status) === terminal.result.outcome
        && (current.clientUserMessageId === undefined || current.clientUserMessageId === command)) return
    }
  }
  return fail('codex_frame_missing')
}
