import { createHash, randomUUID } from 'node:crypto'

import {
  HarnessConfigurationSchema, operatorChatSettings, ConversationSchema, MessageSchema, OperatorConfigurationVersionSchema, OperatorConversationStateSchema,
  OperatorConversationSummarySchema, type OperatorConversationSummary,
  type HarnessConfiguration, type Conversation, type ExecutionResult, type OperatorConfigurationVersion,
  type OperatorConversationState, type PendingNativeInteraction, type SendOperatorMessageRequest,
} from '@graphql/contracts'
import {
  OperatorConversationHistoryPageSchema, OperatorConversationHistoryQuerySchema,
  type OperatorConversationHistoryPage, type OperatorConversationHistoryQuery,
} from '@graphql/contracts/operator-chat'
import type pg from 'pg'

import { PostgresOperatorActivityRepository } from './operatorActivityRepository.js'
import { PostgresSettingsRepository } from '../settings/postgres.js'
import { DomainError } from '../errors.js'
import { isOperatorReview, operatorConversationOwnerPredicate, PostgresOperatorReviewLifecycle } from './operatorReviewLifecycle.js'

export type TurnPhase = 'accepted' | 'creating' | 'ready' | 'submitting' | 'submitted'
export interface ConversationRow {
  id: string
  record: unknown
  deleted_at?: Date | null
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

export const OPERATOR_SNAPSHOT_MESSAGE_LIMIT = 32
export const OPERATOR_SNAPSHOT_MESSAGE_BYTES = 256 * 1024
export const OPERATOR_HISTORY_PAGE_BYTES = 1024 * 1024

export function commandPayload(input: SendOperatorMessageRequest) {
  return { content: input.content, ...(input.settings ? { settings: input.settings } : {}), ...(input.context && Object.keys(input.context).length ? {
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
  readonly activity: PostgresOperatorActivityRepository
  readonly reviews: PostgresOperatorReviewLifecycle
  constructor(private readonly pool: pg.Pool) { this.activity = new PostgresOperatorActivityRepository(pool); this.reviews = new PostgresOperatorReviewLifecycle(pool) }

  async create(operatorId: string, configuration: OperatorConfigurationVersion, ownerId: string, title?: string, id: string = randomUUID()): Promise<Conversation> {
    if (!isOperatorReview(id)) return this.createWithQuery(this.pool, operatorId, configuration, ownerId, title, id)
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await this.reviews.lockAdmission(id.slice('operator-review:'.length), ownerId, client)
      const value = await this.createWithQuery(client, operatorId, configuration, ownerId, title, id)
      await client.query('commit')
      return value
    } catch (error) { await client.query('rollback').catch(() => undefined); throw error } finally { client.release() }
  }

  private async createWithQuery(query: Queryable, operatorId: string, configuration: OperatorConfigurationVersion,
    ownerId: string, title: string | undefined, id: string): Promise<Conversation> {
    const now = new Date().toISOString()
    const value = ConversationSchema.parse({ id, agentId: operatorId, scope: 'application',
      operatorConfigurationVersionId: configuration.id, title: title ?? 'New conversation', status: 'open', createdAt: now, updatedAt: now })
    await query.query(`insert into operator_conversations
      (id,operator_id,operator_configuration_version_id,harness,owner_principal_id,record)
      values ($1,$2,$3,$4,$5,$6::jsonb) on conflict(id) do nothing`,
    [id, operatorId, configuration.id, configuration.harness.harness, ownerId, JSON.stringify(value)])
    const row = await this.active(id, query)
    if (!row || row.owner_principal_id !== ownerId) throw new DomainError('ACCESS_DENIED', 'The conversation belongs to another principal.', 403)
    return conversation(row)
  }

  async list(ownerId: string): Promise<Conversation[]> {
    const result = await this.pool.query<ConversationRow>(
      `select c.* from operator_conversations c where c.deleted_at is null and ${operatorConversationOwnerPredicate} order by c.updated_at desc,c.id`, [ownerId])
    return result.rows.map(conversation)
  }

  async summaries(ownerId: string, limit?: number, attentionOnly = false): Promise<OperatorConversationSummary[]> {
    // One small owner-filtered projection. Do not fetch message history or native request payloads.
    const result = await this.pool.query<{
      id: string; title: string | null; turn_state: OperatorConversationSummary['turnState'];
      revision: string | number; active_request_id: string | null; needs_attention: boolean;
    }>(`select id,record->>'title' as title,turn_state,revision,active_request_id,
      coalesce(active_request_id is not null and pending_interaction is not null
        and response_delivery='offered' and not cancel_requested and record->>'status'='open', false) as needs_attention
      from operator_conversations c where c.deleted_at is null and ${operatorConversationOwnerPredicate}
        and exists(select 1 from operator_conversation_messages m where m.conversation_id=c.id)
        and (not $3::boolean or (active_request_id is not null and pending_interaction is not null
          and response_delivery='offered' and not cancel_requested and record->>'status'='open'))
        order by (select max(m.sequence) from operator_conversation_messages m where m.conversation_id=c.id) desc,id limit $2`, [ownerId, limit ?? null, attentionOnly])
    return result.rows.map((row) => OperatorConversationSummarySchema.parse({
      conversationId: row.id, ...(row.title === null ? {} : { title: row.title }),
      turnState: row.turn_state, revision: Number(row.revision), activeRequestId: row.active_request_id,
      needsAttention: row.needs_attention,
    }))
  }

  async get(id: string, query: Queryable = this.pool): Promise<OperatorConversationState | undefined> {
    // One statement gives the bounded recent window and state the same MVCC
    // snapshot. Large/older messages remain accessible through history().
    const result = await query.query<ConversationRow & { messages: unknown[]; activities: unknown[]; activity_cursor: string | null; message_count: string; configuration: unknown; chat_settings: unknown }>(`select c.*,
      (select record from operator_configuration_versions where id=c.operator_configuration_version_id) as configuration,
      (select t.payload->'settings' from operator_conversation_turns t join operator_conversation_messages m
        on m.conversation_id=t.conversation_id and m.client_request_id=t.request_id
        where t.conversation_id=c.id and t.payload ? 'settings' order by m.sequence desc limit 1) as chat_settings,
      (select count(*) from operator_conversation_messages where conversation_id=c.id) as message_count,
      coalesce((select jsonb_agg(a.record || jsonb_build_object('sequence',a.sequence::text,'revision',a.revision) order by a.sequence)
        from (select record,sequence,revision from operator_conversation_activity where conversation_id=c.id order by sequence desc limit 100) a),'[]'::jsonb) as activities,
      case when exists(select 1 from operator_conversation_activity where conversation_id=c.id order by sequence desc offset 100 limit 1)
        then (select sequence::text from operator_conversation_activity where conversation_id=c.id order by sequence desc offset 99 limit 1) end as activity_cursor,
      coalesce((select jsonb_agg(retained.record order by retained.sequence) from (
        select recent.*,sum(octet_length(recent.record::text)) over (order by recent.sequence desc) as bytes
        from (select m.record || case when m.client_request_id is null then '{}'::jsonb else jsonb_build_object('requestId',m.client_request_id) end as record,m.sequence from operator_conversation_messages m
          where m.conversation_id=c.id order by m.sequence desc limit $2) recent
        ) retained where retained.bytes<=$3),'[]'::jsonb) as messages
      from operator_conversations c where c.id=$1`, [id, OPERATOR_SNAPSHOT_MESSAGE_LIMIT, OPERATOR_SNAPSHOT_MESSAGE_BYTES])
    const row = result.rows[0]
    if (!row) return undefined
    const configuration = OperatorConfigurationVersionSchema.parse(row.configuration)
    return OperatorConversationStateSchema.parse({ conversation: conversation(row), messages: row.messages,
      activities: row.activities, activityNextCursor: row.activity_cursor,
      hasEarlierMessages: Number(row.message_count) > row.messages.length,
      settings: row.chat_settings ?? operatorChatSettings(configuration.harness, configuration.showThinking),
      turnState: row.turn_state, revision: Number(row.revision), activeRequestId: row.active_request_id,
      ...(row.last_error ? { error: row.last_error } : {}),
      ...(row.last_result ? { lastResult: row.last_result } : {}),
      ...(row.pending_interaction ? { pendingInteraction: row.pending_interaction } : {}),
      ...(row.response_delivery ? { responseDelivery: row.response_delivery } : {}),
    })
  }

  /**
   * Stable descending keyset selection, presented oldest-first within each page.
   * Receipts are joined to the exact accepted user message, including after the
   * active request clears or browser enrollment erases its local outbox.
   */
  async history(id: string, input: Partial<OperatorConversationHistoryQuery> = {}): Promise<OperatorConversationHistoryPage | undefined> {
    const { before, limit } = OperatorConversationHistoryQuerySchema.parse(input)
    const result = await this.pool.query<{
      id: string; revision: number | string; active_request_id: string | null;
      entries: unknown[]; next_cursor: string | null;
    }>(`with candidates as (
        select m.*,row_number() over (order by m.sequence desc) as ordinal,
          sum(octet_length(m.record::text)) over (order by m.sequence desc) as bytes
        from (select sequence,record || case when client_request_id is null then '{}'::jsonb else jsonb_build_object('requestId',client_request_id) end as record,client_request_id from operator_conversation_messages
          where conversation_id=$1 and ($2::bigint is null or sequence<$2::bigint)
          order by sequence desc limit ($3::integer+1)) m
      ), selected as (
        select * from candidates where ordinal<=$3 and (bytes<=$4 or ordinal=1)
      )
      select c.id,c.revision,c.active_request_id,
        coalesce((select jsonb_agg(jsonb_build_object(
          'sequence',m.sequence::text,'message',m.record,
          'receipt',case when t.request_id is null then null else jsonb_build_object(
            'requestId',t.request_id,'inputHash',t.input_hash,
            'outcome',t.result->>'outcome','retryable',t.retryable) end) order by m.sequence)
          from selected m left join operator_conversation_turns t
            on t.conversation_id=$1 and t.request_id=m.client_request_id),'[]'::jsonb) as entries,
        case when exists(select 1 from candidates where sequence<(select min(sequence) from selected))
          then (select min(sequence)::text from selected) else null end as next_cursor
      from operator_conversations c where c.id=$1`,
    [id, before ?? null, limit, OPERATOR_HISTORY_PAGE_BYTES])
    const row = result.rows[0]
    if (!row) return undefined
    // One oversized message is returned over HTTP so the cursor always advances;
    // it is never put in a live SSE snapshot.
    return OperatorConversationHistoryPageSchema.parse({ conversationId: row.id, revision: Number(row.revision),
      activeRequestId: row.active_request_id, entries: row.entries, nextCursor: row.next_cursor })
  }

  async configuration(id: string, query: Queryable = this.pool): Promise<OperatorConfigurationVersion | undefined> {
    const result = await query.query<{ record: unknown }>('select record from operator_configuration_versions where id=$1', [id])
    return result.rows[0] ? OperatorConfigurationVersionSchema.parse(result.rows[0].record) : undefined
  }
  async active(id: string, query: Queryable = this.pool): Promise<ConversationRow | undefined> {
    return (await query.query<ConversationRow>('select * from operator_conversations where id=$1', [id])).rows[0]
  }
  async unfinished(): Promise<ConversationRow[]> {
    return (await this.pool.query<ConversationRow>(
      'select * from operator_conversations where active_request_id is not null order by updated_at,id')).rows
  }

  async setDeleted(id: string, ownerId: string, deleted: boolean): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const row = (await client.query<ConversationRow>('select * from operator_conversations where id=$1 for update', [id])).rows[0]
      if (!row || row.owner_principal_id !== ownerId) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
      if (row.active_request_id || !['idle', 'error'].includes(row.turn_state)) {
        throw new DomainError('CONVERSATION_TURN_ACTIVE', 'Stop the response before deleting this chat.', 409)
      }
      if (Boolean(row.deleted_at) !== deleted) {
        await client.query('update operator_conversations set deleted_at=case when $2 then now() else null end, revision=revision+1 where id=$1', [id, deleted])
        if (deleted) await client.query(`update management_principals set revoked_at=coalesce(revoked_at,now())
          where id in (select principal_id from operator_chat_credentials where conversation_id=$1)`, [id])
      }
      await client.query('commit')
    } catch (error) { await client.query('rollback').catch(() => undefined); throw error }
    finally { client.release() }
  }

  async harnessForMessage(configuration: OperatorConfigurationVersion, input: SendOperatorMessageRequest): Promise<HarnessConfiguration> {
    const settings = input.settings
    if (!settings) return configuration.harness
    const base = settings.harness === configuration.harness.harness ? configuration.harness
      : (await new PostgresSettingsRepository(this.pool).getHarnessDefaults())[settings.harness]
    return HarnessConfigurationSchema.parse(settings.harness === 'codex'
      ? { ...base, model: settings.model, reasoningEffort: settings.reasoningEffort, serviceTier: settings.serviceTier }
      : { ...base, model: settings.model, variant: settings.variant, thinking: settings.showThinking })
  }

  async beginTurn(id: string, input: SendOperatorMessageRequest, ownerId: string, harness?: HarnessConfiguration) {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const row = (await client.query<ConversationRow>('select * from operator_conversations where id=$1 for update', [id])).rows[0]
      if (!row || row.deleted_at || row.owner_principal_id !== ownerId) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
      const prior = (await client.query<{ input_hash: string; payload: { content: string; context?: unknown }; retryable: boolean }>(
        'select input_hash,payload,retryable from operator_conversation_turns where conversation_id=$1 and request_id=$2', [id, input.requestId])).rows[0]
      if (prior && (prior.input_hash === 'legacy'
        ? prior.payload.content !== input.content || Object.keys(input.context ?? {}).length > 0 || Boolean(input.settings)
        : prior.input_hash !== commandHash(input))) {
        throw new DomainError('COMMAND_ID_CONFLICT', 'This request ID was already used with a different message or route context.', 409)
      }
      const replayed = Boolean(prior && (!prior.retryable || row.active_request_id))
      if (!replayed) {
        if (conversation(row).status === 'archived') throw new DomainError('CONVERSATION_ARCHIVED', 'This conversation is read-only.', 409)
        await this.reviews.assertActive(id, client)
        if (row.active_request_id || !['idle', 'error'].includes(row.turn_state)) {
          throw new DomainError('CONVERSATION_TURN_ACTIVE', 'This conversation has an active or uncertain turn.', 409)
        }
        if (harness) {
          const current = await this.configuration(row.operator_configuration_version_id, client)
          if (!current) throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'Operator configuration was not found.', 409)
          const showThinking = input.settings?.showThinking ?? current.showThinking ?? false
          if (JSON.stringify(current.harness) !== JSON.stringify(harness) || showThinking !== (current.showThinking ?? false)) {
            await client.query('select pg_advisory_xact_lock(hashtext($1))', ['application-operator'])
            const versionRow = await client.query<{ version: number }>('select coalesce(max(version),0)+1 as version from operator_configuration_versions where operator_id=$1', [current.operatorId])
            const next = OperatorConfigurationVersionSchema.parse({ ...current, id: randomUUID(), version: Number(versionRow.rows[0]!.version),
              harness, showThinking, contentHash: `sha256:${createHash('sha256').update(JSON.stringify({ harness, showThinking })).digest('hex')}`, createdAt: new Date().toISOString() })
            await client.query('insert into operator_configuration_versions (id,operator_id,version,record) values ($1,$2,$3,$4::jsonb)', [next.id,next.operatorId,next.version,JSON.stringify(next)])
            await client.query(`update operator_conversations set operator_configuration_version_id=$2,harness=$3,
              native_session_id=case when harness=$3 then native_session_id else null end,
              provider_version=case when harness=$3 then provider_version else null end where id=$1`, [id,next.id,harness.harness])
            row.record = { ...ConversationSchema.parse(row.record), operatorConfigurationVersionId: next.id }
          }
        }
        if (!prior) {
          await client.query(`insert into operator_conversation_turns (conversation_id,request_id,payload,input_hash)
            values ($1,$2,$3::jsonb,$4)`, [id, input.requestId, JSON.stringify(commandPayload(input)), commandHash(input)])
          const now = new Date().toISOString()
          const message = MessageSchema.parse({ id: randomUUID(), conversationId: id, role: 'user', requestId: input.requestId, content: input.content, createdAt: now, updatedAt: now })
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
      where id=$1 and active_request_id=$2 and not cancel_requested and record->>'status' is distinct from 'archived'`, [id, requestId, phase])
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
      where id=$1 and active_request_id=$2 and not cancel_requested and record->>'status' is distinct from 'archived' and response_delivery='offered'
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
      // Turn completion is proven by the service's exact native correlation,
      // not by whether the provider happened to create an assistant message.
      if (result.outcome === 'succeeded' && nativeMessageId) {
        const output = result.output
        const content = typeof output === 'string' ? output : output && typeof output === 'object' && !Array.isArray(output)
          ? typeof output.text === 'string' ? output.text : typeof output.content === 'string' ? output.content : '' : ''
        if (content) {
          const now = new Date().toISOString()
          const message = MessageSchema.parse({ id: randomUUID(), conversationId: id, role: 'assistant', requestId, content, createdAt: now, updatedAt: now })
          // A conflict is a correlation error, not a successful answer for a second request.
          await client.query(`insert into operator_conversation_messages (id,conversation_id,role,content,native_message_id,record)
            values ($1,$2,'assistant',$3,$4,$5::jsonb)`, [message.id, id, content, nativeMessageId, JSON.stringify(message)])
        }
      }
      await this.activity.finish(id, requestId, result.outcome === 'canceled', client)
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
