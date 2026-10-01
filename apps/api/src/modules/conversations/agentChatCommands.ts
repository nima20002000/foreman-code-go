import { AcceptedChatResponseControlSchema, ChatResponseAcknowledgmentSchema, type ChatResponseAcknowledgment, type AcceptedChatResponseControl } from '@graphql/contracts/interaction-activity'
import type pg from 'pg'
import { AgentChatStateSchema, type AgentChatState } from '@graphql/contracts/agent-chat'
import type { ManagementPrincipal } from '@graphql/contracts/management'

import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'

type Outcome = { acceptedControl?: AcceptedChatResponseControl; providerAcknowledgment?: ChatResponseAcknowledgment } & (
  | { status: 'pending' | 'uncertain' }
  | { status: 'completed'; state: AgentChatState }
  | { status: 'rejected'; error: { code: string; message: string; status: number; details?: Record<string, unknown> } }
)
interface Receipt { target_key: string; input_hash: string; result: Outcome }
const OPERATION = 'agent_chat_control'

function unconfirmed(requestId: string) {
  return new DomainError('AGENT_CHAT_CONTROL_UNCONFIRMED',
    'This control was recorded but its outcome is unconfirmed. Read the conversation; do not submit it again with a new request ID.',
    409, { requestId })
}

/**
 * A command receipt is NOT a model-turn receipt. Reserve in autocommit before any
 * external effect, using the existing durable management receipt table. A crash
 * or lost acknowledgement leaves a non-replayable pending/uncertain tombstone.
 * Authorization (including read access to the returned state) precedes execute,
 * even on receipt reads. No transaction/connection is held across native I/O.
 */
export class AgentChatCommands {
  private closing = false
  private readonly pending = new Set<Promise<AgentChatState>>()

  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  execute(principal: ManagementPrincipal, source: 'http' | 'mcp', conversationId: string, requestId: string,
    payload: unknown, perform: () => Promise<AgentChatState>,
    readCurrent?: () => Promise<AgentChatState>,
    acceptedControl?: AcceptedChatResponseControl,
    responseEvidence?: () => ChatResponseAcknowledgment | undefined): Promise<AgentChatState> {
    if (this.closing) return Promise.reject(new DomainError('AGENT_CHAT_CLOSING', 'Agent chat is shutting down.', 503))
    const task = this.reserve(principal, source, conversationId, requestId, payload, perform, readCurrent, acceptedControl, responseEvidence)
    this.pending.add(task)
    void task.finally(() => { this.pending.delete(task) }).catch(() => undefined)
    return task
  }

  async drain(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.pending])
  }

  private async reserve(principal: ManagementPrincipal, source: 'http' | 'mcp', conversationId: string, requestId: string,
    payload: unknown, perform: () => Promise<AgentChatState>,
    readCurrent?: () => Promise<AgentChatState>,
    acceptedControl?: AcceptedChatResponseControl,
    responseEvidence?: () => ChatResponseAcknowledgment | undefined): Promise<AgentChatState> {
    // Current scope/authority is checked even for conflicts, rejections and receipt replay.
    if (readCurrent) await readCurrent()
    const control = acceptedControl ? AcceptedChatResponseControlSchema.parse(acceptedControl) : undefined
    if (control && control.conversationId !== conversationId) throw new DomainError(
      'AGENT_CHAT_CONTROL_SCOPE_CONFLICT', 'Accepted response metadata changed its conversation scope.', 409)
    const hash = commandInputHash(payload)
    const key = [principal.id, OPERATION, requestId]
    // All control kinds share the same namespace; changing kind or target also conflicts.
    const admitted = await this.pool.query(`with claimed as (
      insert into management_command_receipts (principal_id,operation,command_id,target_key,input_hash,result)
      values ($1,$2,$3,$4,$5,$7::jsonb)
      on conflict (principal_id,operation,command_id) do nothing returning 1
    ) insert into management_audit (principal_id,source,action,target_key,outcome,details)
      select $1,$6,$2,$4,'uncertain',jsonb_build_object('commandId',$3::text,'phase','reserved') from claimed returning 1`,
    [...key, conversationId, hash, source, JSON.stringify({ status: 'pending', ...(control ? { acceptedControl: control } : {}) })])
    if (!admitted.rowCount) {
      const prior = (await this.pool.query<Receipt>(`select target_key,input_hash,result from management_command_receipts
        where principal_id=$1 and operation=$2 and command_id=$3`, key)).rows[0]
      if (!prior) throw unconfirmed(requestId)
      if (prior.target_key !== conversationId || prior.input_hash !== hash) {
        throw new DomainError('AGENT_CHAT_REQUEST_CONFLICT', 'This request ID was already used for a different control or input.', 409)
      }
      if (prior.result.status === 'completed') return AgentChatStateSchema.parse(
        readCurrent ? await readCurrent() : prior.result.state)
      if (prior.result.status === 'rejected') {
        const error = prior.result.error
        throw new DomainError(error.code, error.message, error.status, error.details)
      }
      throw unconfirmed(requestId)
    }

    let outcome: Outcome
    try {
      outcome = { status: 'completed', state: AgentChatStateSchema.parse(await perform()) }
    } catch (error) {
      // Domain validation failures are replayable rejections. Transport/storage
      // errors do not prove that the external effect failed; never retry them.
      outcome = error instanceof DomainError ? { status: 'rejected', error: {
        code: error.code, message: error.message, status: error.status,
        ...(error.details ? { details: error.details } : {}),
      } } : { status: 'uncertain' }
    }
    if (control) {
      outcome = { ...outcome, acceptedControl: control }
      const evidence = responseEvidence?.()
      const parsed = evidence ? ChatResponseAcknowledgmentSchema.safeParse(evidence) : undefined
      if (parsed?.success && parsed.data.harness === control.native.harness && parsed.data.nativeSessionId === control.native.sessionId
        && parsed.data.nativeRequestId === control.native.requestId && parsed.data.nativeRequestType === control.native.requestType
        && parsed.data.optionId === control.choice.optionId && parsed.data.semantic === control.choice.semantic) {
        outcome.providerAcknowledgment = parsed.data
      }
    }
    try {
      const saved = await this.pool.query(`with settled as (
        update management_command_receipts set result=$4::jsonb
        where principal_id=$1 and operation=$2 and command_id=$3 and result->>'status'='pending' returning target_key
      ) insert into management_audit (principal_id,source,action,target_key,outcome,details)
        select $1,$5,$2,target_key,$6,jsonb_build_object('commandId',$3::text) from settled returning 1`,
      [...key, JSON.stringify(outcome), source, outcome.status === 'completed' ? 'succeeded' : outcome.status === 'rejected' ? 'failed' : 'uncertain'])
      if (saved.rowCount !== 1) throw unconfirmed(requestId)
    } catch {
      // The durable reservation remains the fence even when saving the outcome fails.
      throw unconfirmed(requestId)
    }
    if (outcome.status === 'completed') return AgentChatStateSchema.parse(
      readCurrent ? await readCurrent() : outcome.state)
    if (outcome.status === 'rejected') {
      const error = outcome.error
      throw new DomainError(error.code, error.message, error.status, error.details)
    }
    throw unconfirmed(requestId)
  }
}
