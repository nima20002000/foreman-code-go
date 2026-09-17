import { createHash, randomUUID } from 'node:crypto'

import {
  ConversationSchema, MessageSchema, OperatorConfigurationVersionSchema, OperatorConversationStateSchema,
  OperatorConversationSummarySchema, type OperatorConversationSummary,
  type Conversation, type ExecutionResult, type OperatorConfigurationVersion,
  type OperatorConversationState, type PendingNativeInteraction, type SendOperatorMessageRequest,
} from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'

export type TurnPhase = 'accepted' | 'creating' | 'ready' | 'submitting' | 'submitted'
export interface ConversationRow {
  id: string
  record: unknown
  owner_principal_id: string | null
  operator_configuration_version_id: string
  harness: 'codex' | 'opencode'
  provider_version: string | null
  native_session_id: string | null
  active_request_id: string | null
  active_native_turn_id: string | null
  active_phase: TurnPhase | null
  cancel_requested: boolean
  turn_state: OperatorConversationState['turnState']
  last_error: string | null
  revision: string | number
  pending_interaction: PendingNativeInteraction | null
  response_delivery: 'offered' | 'submitted' | 'uncertain' | null
  last_result: ExecutionResult | null
  updated_at: Date
}
type Queryable = Pick<pg.PoolClient, 'query'>

export function commandPayload(input: SendOperatorMessageRequest) {
  return { content: input.content, ...(input.context && Object.keys(input.context).length ? {
    context: Object.fromEntries(Object.entries(input.context).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))),
  } : {}) }
}
export function commandHash(input: SendOperatorMessageRequest): string {
  return createHash('sha256').update(JSON.stringify(commandPayload(input))).digest('hex')
}
export function nativeCorrelation(conversationId: string, requestId: string): string {
  return `operator:${conversationId}:${requestId}`
}
function conversation(row: ConversationRow): Conversation {
  return ConversationSchema.parse({ ...ConversationSchema.parse(row.record), updatedAt: row.updated_at.toISOString() })
}

/** SQL transitions are fenced by the accepted request, even under a delayed native response. */
export class PostgresOperatorConversationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(operatorId: string, configuration: OperatorConfigurationVersion, ownerId: string, title?: string, id: string = randomUUID()): Promise<Conversation> {
    const now = new Date().toISOString()
    const value = ConversationSchema.parse({ id, agentId: operatorId, scope: 'application',
      operatorConfigurationVersionId: configuration.id, title: title ?? 'New conversation', status: 'open', createdAt: now, updatedAt: now })
    await this.pool.query(`insert into operator_conversations
      (id,operator_id,operator_configuration_version_id,harness,owner_principal_id,record)
      values ($1,$2,$3,$4,$5,$6::jsonb) on conflict(id) do nothing`,
    [id, operatorId, configuration.id, configuration.harness.harness, ownerId, JSON.stringify(value)])
    const row = await this.active(id)
    if (!row || row.owner_principal_id !== ownerId) throw new DomainError('ACCESS_DENIED', 'The conversation belongs to another principal.', 403)
    return conversation(row)
  }

  async list(ownerId: string): Promise<Conversation[]> {
    const result = await this.pool.query<ConversationRow>(
      'select * from operator_conversations where owner_principal_id=$1 order by updated_at desc,id', [ownerId])
    return result.rows.map(conversation)
  }

  async summaries(ownerId: string): Promise<OperatorConversationSummary[]> {
    // One small owner-filtered projection. Do not fetch message history or native request payloads.
    const result = await this.pool.query<{
      id: string; title: string | null; turn_state: OperatorConversationSummary['turnState'];
      revision: string | number; active_request_id: string | null; needs_attention: boolean;
    }>(`select id,record->>'title' as title,turn_state,revision,active_request_id,
      coalesce(active_request_id is not null and pending_interaction is not null
        and response_delivery='offered' and not cancel_requested, false) as needs_attention
      from operator_conversations where owner_principal_id=$1 order by updated_at desc,id`, [ownerId])
    return result.rows.map((row) => OperatorConversationSummarySchema.parse({
      conversationId: row.id, ...(row.title === null ? {} : { title: row.title }),
      turnState: row.turn_state, revision: Number(row.revision), activeRequestId: row.active_request_id,
      needsAttention: row.needs_attention,
    }))
  }

  async get(id: string, query: Queryable = this.pool): Promise<OperatorConversationState | undefined> {
    // One statement gives messages and state the same MVCC snapshot. No nested pool checkout.
    const result = await query.query<ConversationRow & { messages: unknown[] }>(`select c.*,
      coalesce((select jsonb_agg(m.record order by m.sequence) from operator_conversation_messages m
        where m.conversation_id=c.id),'[]'::jsonb) as messages
      from operator_conversations c where c.id=$1`, [id])
    const row = result.rows[0]
    if (!row) return undefined
    return OperatorConversationStateSchema.parse({ conversation: conversation(row), messages: row.messages,
      turnState: row.turn_state, revision: Number(row.revision), activeRequestId: row.active_request_id,
      ...(row.last_error ? { error: row.last_error } : {}),
      ...(row.last_result ? { lastResult: row.last_result } : {}),
      ...(row.pending_interaction ? { pendingInteraction: row.pending_interaction } : {}),
      ...(row.response_delivery ? { responseDelivery: row.response_delivery } : {}),
    })
  }

  async configuration(id: string): Promise<OperatorConfigurationVersion | undefined> {
    const result = await this.pool.query<{ record: unknown }>('select record from operator_configuration_versions where id=$1', [id])
    return result.rows[0] ? OperatorConfigurationVersionSchema.parse(result.rows[0].record) : undefined
  }
  async active(id: string): Promise<ConversationRow | undefined> {
    return (await this.pool.query<ConversationRow>('select * from operator_conversations where id=$1', [id])).rows[0]
  }
  async unfinished(): Promise<ConversationRow[]> {
    return (await this.pool.query<ConversationRow>(
      'select * from operator_conversations where active_request_id is not null order by updated_at,id')).rows
  }

  async beginTurn(id: string, input: SendOperatorMessageRequest, ownerId: string) {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const row = (await client.query<ConversationRow>('select * from operator_conversations where id=$1 for update', [id])).rows[0]
      if (!row || row.owner_principal_id !== ownerId) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
      const prior = (await client.query<{ input_hash: string; payload: { content: string; context?: unknown }; retryable: boolean }>(
        'select input_hash,payload,retryable from operator_conversation_turns where conversation_id=$1 and request_id=$2', [id, input.requestId])).rows[0]
      if (prior && (prior.input_hash === 'legacy'
        ? prior.payload.content !== input.content || Object.keys(input.context ?? {}).length > 0
        : prior.input_hash !== commandHash(input))) {
        throw new DomainError('COMMAND_ID_CONFLICT', 'This request ID was already used with a different message or route context.', 409)
      }
      const replayed = Boolean(prior && (!prior.retryable || row.active_request_id))
      if (!replayed) {
        if (row.active_request_id || !['idle', 'error'].includes(row.turn_state)) {
          throw new DomainError('CONVERSATION_TURN_ACTIVE', 'This conversation has an active or uncertain turn.', 409)
        }
        if (!prior) {
          await client.query(`insert into operator_conversation_turns (conversation_id,request_id,payload,input_hash)
            values ($1,$2,$3::jsonb,$4)`, [id, input.requestId, JSON.stringify(commandPayload(input)), commandHash(input)])
          const now = new Date().toISOString()
          const message = MessageSchema.parse({ id: randomUUID(), conversationId: id, role: 'user', content: input.content, createdAt: now, updatedAt: now })
          await client.query(`insert into operator_conversation_messages (id,conversation_id,role,content,client_request_id,record)
            values ($1,$2,'user',$3,$4,$5::jsonb)`, [message.id, id, input.content, input.requestId, JSON.stringify(message)])
        }
        await client.query('update operator_conversation_turns set retryable=false,result=null where conversation_id=$1 and request_id=$2', [id, input.requestId])
        const title = ConversationSchema.parse(row.record).title
        const record = title === 'New conversation' ? { ...ConversationSchema.parse(row.record), title: input.content.replace(/\s+/g, ' ').slice(0, 72) } : row.record
        await client.query(`update operator_conversations set active_request_id=$2,active_native_turn_id=null,
          active_phase='accepted',cancel_requested=false,turn_state='starting',last_error=null,last_result=null,
          pending_interaction=null,response_delivery=null,revision=revision+1,record=$3::jsonb,updated_at=now() where id=$1`,
        [id, input.requestId, JSON.stringify(record)])
      }
      const state = await this.get(id, client)
      if (!state) throw new Error('Conversation disappeared inside its locked transaction.')
      await client.query('commit')
      return { replayed, state }
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally { client.release() }
  }

  async phase(id: string, requestId: string, phase: TurnPhase): Promise<boolean> {
    const result = await this.pool.query(`update operator_conversations set active_phase=$3,revision=revision+1,updated_at=now()
      where id=$1 and active_request_id=$2 and not cancel_requested`, [id, requestId, phase])
    return result.rowCount === 1
  }
  async bind(id: string, requestId: string, version: string, nativeId: string): Promise<void> {
    const result = await this.pool.query(`update operator_conversations set provider_version=$3,native_session_id=$4,
      active_phase='ready',revision=revision+1,updated_at=now()
      where id=$1 and active_request_id=$2 and (native_session_id is null or native_session_id=$4)`, [id, requestId, version, nativeId])
    if (result.rowCount !== 1) throw new DomainError('NATIVE_SESSION_BINDING_UNCERTAIN', 'Native binding ownership was lost.', 409)
  }
  async submitted(id: string, requestId: string, nativeTurnId: string): Promise<boolean> {
    const result = await this.pool.query(`update operator_conversations set active_native_turn_id=$3,active_phase='submitted',
      turn_state=case when cancel_requested then 'canceling' else 'active' end,revision=revision+1,updated_at=now()
      where id=$1 and active_request_id=$2 and (active_native_turn_id is null or active_native_turn_id=$3)`, [id, requestId, nativeTurnId])
    return result.rowCount === 1
  }
  async requestCancel(id: string, requestId: string): Promise<boolean> {
    const result = await this.pool.query(`update operator_conversations set cancel_requested=true,turn_state='canceling',
      revision=revision+1,updated_at=now() where id=$1 and active_request_id=$2`, [id, requestId])
    return result.rowCount === 1
  }
  async uncertain(id: string, requestId: string, message: string): Promise<void> {
    await this.pool.query(`update operator_conversations set turn_state='uncertain',last_error=$3,revision=revision+1,updated_at=now()
      where id=$1 and active_request_id=$2`, [id, requestId, message])
  }
  async pending(id: string, requestId: string, value?: PendingNativeInteraction): Promise<void> {
    await this.pool.query(`update operator_conversations set pending_interaction=$3::jsonb,
      response_delivery=case when $3::jsonb is null then null
        when pending_interaction->'turn'->>'nativeRequestId'=$3::jsonb->'turn'->>'nativeRequestId' then coalesce(response_delivery,'offered')
        else 'offered' end,revision=revision+1,updated_at=now()
      where id=$1 and active_request_id=$2`, [id, requestId, value ? JSON.stringify(value) : null])
  }
  async claimResponse(id: string, requestId: string, nativeRequestId: string): Promise<boolean> {
    return (await this.pool.query(`update operator_conversations set response_delivery='submitted',revision=revision+1,updated_at=now()
      where id=$1 and active_request_id=$2 and not cancel_requested and response_delivery='offered'
        and pending_interaction->'turn'->>'nativeRequestId'=$3`, [id, requestId, nativeRequestId])).rowCount === 1
  }
  async responseFailed(id: string, requestId: string, nativeRequestId: string): Promise<void> {
    await this.pool.query(`update operator_conversations set response_delivery='offered',revision=revision+1,updated_at=now()
      where id=$1 and active_request_id=$2 and response_delivery='submitted'
        and pending_interaction->'turn'->>'nativeRequestId'=$3`, [id, requestId, nativeRequestId])
  }
  async responseUncertain(id: string, requestId: string): Promise<void> {
    await this.pool.query(`update operator_conversations set response_delivery='uncertain',revision=revision+1,updated_at=now()
      where id=$1 and active_request_id=$2 and response_delivery='submitted'`, [id, requestId])
  }

  async finish(id: string, requestId: string, result: ExecutionResult, nativeMessageId?: string, retryable = false): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const row = (await client.query<ConversationRow>('select * from operator_conversations where id=$1 for update', [id])).rows[0]
      if (!row || row.active_request_id !== requestId) { await client.query('commit'); return false }
      if (result.outcome === 'succeeded') {
        if (!nativeMessageId) throw new Error('A successful native result requires a verified native message identity.')
        const output = result.output
        const content = typeof output === 'string' ? output : output && typeof output === 'object' && !Array.isArray(output)
          ? typeof output.text === 'string' ? output.text : typeof output.content === 'string' ? output.content : '' : ''
        const now = new Date().toISOString()
        const message = MessageSchema.parse({ id: randomUUID(), conversationId: id, role: 'assistant', content, createdAt: now, updatedAt: now })
        // A conflict is a correlation error, not a successful answer for a second request.
        await client.query(`insert into operator_conversation_messages (id,conversation_id,role,content,native_message_id,record)
          values ($1,$2,'assistant',$3,$4,$5::jsonb)`, [message.id, id, content, nativeMessageId, JSON.stringify(message)])
      }
      await client.query('update operator_conversation_turns set result=$3::jsonb,retryable=$4 where conversation_id=$1 and request_id=$2',
        [id, requestId, JSON.stringify(result), retryable])
      await client.query(`update operator_conversations set active_request_id=null,active_native_turn_id=null,active_phase=null,
        cancel_requested=false,pending_interaction=null,response_delivery=null,last_result=$3::jsonb,last_error=$4,
        turn_state=$5,revision=revision+1,updated_at=now() where id=$1 and active_request_id=$2`,
      [id, requestId, JSON.stringify(result), result.error?.message ?? null, result.outcome === 'failed' ? 'error' : 'idle'])
      await client.query('commit')
      return true
    } catch (error) { await client.query('rollback').catch(() => undefined); throw error } finally { client.release() }
  }
}
