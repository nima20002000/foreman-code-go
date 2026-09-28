import { readCurrentExecutions } from './wave25Agent3.js'
import { vi } from 'vitest'
import type { NativeGraphObservation } from '@graphql/contracts/wave25'
import { nativeMessageId, object, type OpenCodeMessage } from '../../src/modules/harnesses/opencodeProtocol.js'
import { OPENCODE_RECONCILIATION_EVENT } from '../../src/modules/harnesses/opencodeReconciliation.js'
import type { FixtureServer } from '../opencode-fixtures.js'
import { deferred } from './wave25Agent3.js'
import type { Br1002Runtime } from './wave25Br1002Cuts.js'

export interface Br3002Case {
  name: string
  finish: string
  completed?: false
  missingFinish?: true
  error?: true
  pendingTool?: true
  marker: boolean
  reviewOutcome?: 'succeeded' | 'failed'
  ordinaryOutcome?: 'succeeded' | 'failed'
}
export const br3002Cases: readonly Br3002Case[] = [
  { name: 'stop', finish: 'stop', marker: true, reviewOutcome: 'succeeded', ordinaryOutcome: 'succeeded' },
  { name: 'length', finish: 'length', marker: true, reviewOutcome: 'failed', ordinaryOutcome: 'succeeded' },
  { name: 'content-filter', finish: 'content-filter', marker: true, reviewOutcome: 'failed', ordinaryOutcome: 'succeeded' },
  { name: 'assistant-error', finish: 'stop', error: true, marker: true, reviewOutcome: 'failed', ordinaryOutcome: 'failed' },
  { name: 'tool-calls', finish: 'tool-calls', marker: false },
  { name: 'missing-completed', finish: 'stop', completed: false, marker: false },
  { name: 'missing-finish', finish: 'stop', missingFinish: true, marker: false },
  { name: 'pending-tool', finish: 'stop', pendingTool: true, marker: false },
  // The ordinary result extractor accepts an explicit error without a completed
  // timestamp. The stricter review policy must still withhold settlement.
  { name: 'incomplete-error', finish: 'stop', error: true, completed: false, marker: true, ordinaryOutcome: 'failed' },
]

/** Mutate only the external provider's stored message, BEFORE any live event or
 * history read. No NativeHistory, graph observation or terminal receipt is mocked. */
export function br3002Assistant(server: FixtureServer, correlationId: string, sessionID: string, variant: Br3002Case): OpenCodeMessage {
  const message = server.assistant(nativeMessageId(correlationId), 'review finished', variant.finish, variant.completed !== false, sessionID)
  if (variant.missingFinish) delete message.info.finish
  if (variant.error) message.info.error = { name: 'APIError', data: { message: 'fixture assistant error', isRetryable: false } }
  if (variant.pendingTool) message.parts.push({ id: `prt_pending_${String(message.info.id)}`, type: 'tool',
    sessionID, messageID: message.info.id, callID: 'call_still_running', tool: 'graphql_interaction_get',
    state: { status: 'running', input: {} } })
  server.statuses.delete(sessionID)
  return message
}
export function br3002Notify(server: FixtureServer, message: OpenCodeMessage, live: boolean): void {
  if (live) {
    server.emit('message.updated', { info: message.info })
    for (const part of message.parts) server.emit('message.part.updated', { part })
  }
  // Only the assistant terminal notification is lost; both paths observe the
  // same idle hint, which must trigger a real scan, not grant settlement itself.
  server.emit('session.idle', { sessionID: message.info.sessionID })
}

export type Br3002ReviewArgs = Parameters<Br1002Runtime['repository']['coordination']['appendReviewNativeEvent']>
export function br3002Cuts(f: Br1002Runtime, deferAssistant = false) {
  const started = deferred<Br3002ReviewArgs>(), assistant = deferred<Br3002ReviewArgs>()
  const beforeMarker = deferred<Br3002ReviewArgs>(), afterMarker = deferred<Br3002ReviewArgs>()
  const continueStart = deferred(), continueAssistant = deferred(), enterMarker = deferred(), finishMarker = deferred()
  const original = f.repository.coordination.appendReviewNativeEvent.bind(f.repository.coordination)
  let sawStart = false, sawAssistant = false, sawMarker = false
  const spy = vi.spyOn(f.repository.coordination, 'appendReviewNativeEvent').mockImplementation(async (...args) => {
    const [job, event, projection] = args
    const info = object(event.payload.info)
    if (deferAssistant && !sawAssistant && projection?.live && !event.connectionId?.startsWith('history-')
      && event.type === 'message.updated' && info.role === 'assistant' && info.parentID === job.providerTurnOrMessageId) {
      // Reorder the actual adapter frame, not a synthesized NativeHarnessEvent.
      sawAssistant = true; assistant.resolve(args); await continueAssistant.promise
      return
    }
    if (!sawMarker && event.type === OPENCODE_RECONCILIATION_EVENT && projection?.live === false && projection.nativeCapture) {
      sawMarker = true; beforeMarker.resolve(args); await enterMarker.promise
      await original(...args)
      afterMarker.resolve(args); await finishMarker.promise
      return
    }
    await original(...args)
    // Raw history has a history-* source, even when yielded by startTurn.
    if (!projection?.live || event.connectionId?.startsWith('history-') || event.type !== 'message.updated') return
    if (!sawStart && info.role === 'user' && info.id === job.providerTurnOrMessageId) {
      sawStart = true; started.resolve(args); await continueStart.promise
    } else if (!sawAssistant && info.role === 'assistant' && info.parentID === job.providerTurnOrMessageId) {
      sawAssistant = true; assistant.resolve(args); await continueAssistant.promise
    }
  })
  return { started, assistant, beforeMarker, afterMarker, continueStart, continueAssistant, enterMarker, finishMarker, original,
    release() { continueStart.resolve(); continueAssistant.resolve(); enterMarker.resolve(); finishMarker.resolve() },
    restore() { spy.mockRestore() } }
}
export async function br3002Evidence(f: Br1002Runtime, jobId: string) {
  return (await f.db.pool.query<{ state: string; revision: string; generation: string;
    approval_native_evidence: NativeGraphObservation | null }>(
    'select state,revision::text,approval_connection_generation::text as generation,approval_native_evidence from review_jobs where id=$1', [jobId])).rows[0]!
}
export async function br3002Decision(f: Br1002Runtime, args: Br3002ReviewArgs) {
  const job = args[0], interaction = (await f.repository.get(job.interactionId))!
  const host = (await readCurrentExecutions(f.runs, f.f.run.id)).find((execution) => execution.agentId === job.reviewerAgentId)!
  const credential = await f.credentials.issueForReviewer(host.id)
  try {
    const principal = await f.access.authenticate(credential.environment.variables.GRAPHQL_MCP_TOKEN, 'worker')
    const option = interaction.responseOptions.find((item) => item.semantic === 'approve_once')
    if (!option) throw new Error('Expected the actual OpenCode approve-once option')
    // Real issued/scoped principal and decision transaction; NOT an authenticated
    // MCP transport or a real provider tool call. No authority bypass is installed.
    return await f.repository.decide({ id: interaction.id, optionId: option.optionId,
      expectedRevision: interaction.revision, principal,
      nativeResponse: { optionId: option.optionId, semantic: option.semantic } })
  } finally { await f.credentials.revoke({ principalId: credential.principalId }) }
}
export async function br3002Effects(f: Br1002Runtime, jobId: string) {
  return (await f.db.pool.query<{ effect_kind: string; entity_id: string; effect_digest: string; first_sequence: string }>(
    `select effect_kind,entity_id,effect_digest,first_sequence::text from run_graph_effects
      where run_id=$1 and (entity_id=$2 or effect_kind in ('approval.deliver','graph.resume'))
      order by effect_kind,entity_id`, [f.f.run.id, jobId])).rows
}

export function br3002ApprovalReplies(f: Br1002Runtime): number {
  return [...f.servers.values()].flatMap((server) => server.calls)
    .filter((call) => /^\/permission\/[^/]+\/reply/.test(call.path) && call.body?.reply === 'once').length
}
