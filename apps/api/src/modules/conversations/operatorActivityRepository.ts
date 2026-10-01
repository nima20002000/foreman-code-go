import { OperatorActivityPageSchema, OperatorActivityQuerySchema, OperatorActivitySchema, type OperatorActivity, type OperatorActivityQuery } from '@graphql/contracts'
import type pg from 'pg'
import type { OperatorActivityChange } from './operatorActivity.js'

export interface ActivityMutationFence {
  connectionId?: string
  nativeGeneration?: string
  nativeSessionId?: string
  nativeTurnId?: string
  source?: { eventId?: string; sequence?: string; system?: string; observedAt?: string; connectionId?: string }
  onReconciliationRequired?: () => void
  /** Only reconciled native history may correct terminal content. */
  authoritativeReconciliation?: boolean
}

type Queryable = Pick<pg.PoolClient, 'query'>
const changeSchema = OperatorActivitySchema.omit({ sequence: true, revision: true })

export class PostgresOperatorActivityRepository {
  constructor(private readonly pool: pg.Pool) {}

  async append(conversationId: string, requestId: string, input: OperatorActivityChange, fence: ActivityMutationFence = {}): Promise<{ activity: OperatorActivity; revision: number } | undefined> {
    const value = changeSchema.parse(input)
    if (value.requestId !== requestId) throw new Error('Activity belongs to a different request.')
    for (const sequence of [fence.source?.sequence, fence.source?.nativeSequence]) {
      if (sequence !== undefined && !/^(0|[1-9][0-9]*)$/.test(sequence)) throw new Error('Invalid native source sequence.')
    }
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const owner = await client.query(`select id from operator_conversations where id=$1 and active_request_id=$2 and deleted_at is null
        and ($3::text is null or native_session_id=$3) and ($4::text is null or active_native_turn_id=$4) for update`,
      [conversationId, requestId, fence.nativeSessionId ?? null, fence.nativeTurnId ?? null])
      if (!owner.rowCount) { await client.query('commit'); return undefined }
      const prior = (await client.query<{ record: OperatorActivityChange; source_provenance: ActivityMutationFence['source'] }>(
        `select record,source_provenance from operator_conversation_activity where conversation_id=$1 and request_id=$2 and activity_id=$3 for update`,
      [conversationId, requestId, value.id])).rows[0]
      const stored = (prior?.source_provenance ?? {}) as NonNullable<ActivityMutationFence['source']> & { connectionId?: string }
      const orderedNative = source.nativeSequence !== undefined && stored.nativeSequence !== undefined
      const orderedTransport = source.connectionId !== undefined && source.connectionId === stored.connectionId
        && source.transportSequence !== undefined && stored.transportSequence !== undefined
      const source = { ...(fence.authoritativeReconciliation ? stored : {}), schemaVersion: 1, system: 'conversation_activity', ...fence.source }
      const merged = prior ? { ...prior.record, ...value } : value
      // Compare parsed allowlisted facts, independent of JSONB key order.
      const changed = !prior || JSON.stringify(changeSchema.parse(prior.record)) !== JSON.stringify(changeSchema.parse(merged))
      const sameConnection = source.connectionId === stored.connectionId
      const stale = fence.source?.eventId !== undefined && fence.source.eventId === stored.eventId
        || sameConnection && stored.sequence !== undefined && (fence.source?.sequence !== undefined
          ? BigInt(fence.source.sequence) <= BigInt(stored.sequence) : !fence.authoritativeReconciliation)
      const terminal = prior && ['completed', 'failed', 'canceled'].includes(prior.record.status)
      const ambiguous = prior && changed && (stored.connectionId !== undefined && !sameConnection
        || prior.record.status === value.status && source.sequence === undefined)
      if (stale || terminal && changed && (!fence.authoritativeReconciliation || prior.record.status !== value.status)
        || ambiguous && !fence.authoritativeReconciliation || prior?.record.status === 'running' && value.status === 'pending') {
        await client.query('commit')
        if (ambiguous && !stale && !fence.authoritativeReconciliation) fence.onReconciliationRequired?.()
        return undefined
      }
      if (!changed) {
        // An identical newer native observation advances the private watermark, never public revisions.
        if (sameConnection && source.sequence !== undefined && !fence.authoritativeReconciliation) await client.query(`update operator_conversation_activity set source_provenance=$4::jsonb
          where conversation_id=$1 and request_id=$2 and activity_id=$3`, [conversationId, requestId, value.id, JSON.stringify(source)])
        await client.query('commit'); return undefined
      }
      const applied = (await client.query<{ record: unknown; sequence: string; revision: string }>(`
        insert into operator_conversation_activity as activity (conversation_id,request_id,activity_id,record,source_provenance)
          values ($1,$2,$3,$4::jsonb,$5::jsonb)
        on conflict(conversation_id,request_id,activity_id) do update set record=excluded.record,
          source_provenance=excluded.source_provenance,revision=activity.revision+1
        returning record,sequence::text,revision::text`, [conversationId, requestId, value.id, JSON.stringify(merged), JSON.stringify(source)])).rows[0]!
      const revision = (await client.query<{ revision: string }>(`update operator_conversations set revision=revision+1 where id=$1 returning revision::text`, [conversationId])).rows[0]!.revision
      await client.query('commit')
      return { activity: OperatorActivitySchema.parse({ ...(applied.record as object), sequence: applied.sequence, revision: Number(applied.revision) }), revision: Number(revision) }
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally { client.release() }
  }

  async page(conversationId: string, input: Partial<OperatorActivityQuery> = {}, query: Queryable = this.pool) {
    const { before, limit } = OperatorActivityQuerySchema.parse(input)
    const result = await query.query<{ record: unknown; sequence: string; revision: string }>(`
      select record,sequence::text,revision::text from operator_conversation_activity
      where conversation_id=$1 and ($2::bigint is null or sequence<$2::bigint)
      order by sequence desc limit $3`, [conversationId, before ?? null, limit + 1])
    const rows = result.rows.slice(0, limit)
    const page = OperatorActivityPageSchema.parse({
      activities: rows.reverse().map((row) => ({ ...(row.record as object), sequence: row.sequence, revision: Number(row.revision) })),
      nextCursor: result.rows.length > limit ? result.rows[limit - 1]!.sequence : null,
    })
    return { ...page, itemRevisions: Object.fromEntries(rows.map((row) => [(row.record as { id: string }).id, row.revision])) }
  }

  /** The unfinished roster is independent of chronological history paging. */
  async unfinished(conversationId: string, query: Queryable = this.pool): Promise<{ activities: OperatorActivity[]; hasMore: boolean }> {
    const limit = 100
    const result = await query.query<{ record: unknown; sequence: string; revision: string }>(`
      select record,sequence::text,revision::text from operator_conversation_activity
      where conversation_id=$1 and record->>'kind' <> 'thinking' and record->>'status' in ('pending','running','unknown')
      order by sequence limit $2`, [conversationId, limit + 1])
    return { activities: result.rows.slice(0, limit).map((row) => OperatorActivitySchema.parse({ ...(row.record as object), sequence: row.sequence, revision: Number(row.revision) })),
      hasMore: result.rows.length > limit }
  }

  async finish(conversationId: string, requestId: string, canceled: boolean, query: Queryable): Promise<void> {
    // A terminal turn is not proof that every tool succeeded. Preserve missing
    // completion evidence explicitly instead of painting all entries successful.
    await query.query(`update operator_conversation_activity set revision=revision+1,
      record=jsonb_set(record,'{status}',to_jsonb(case when record->>'kind'='thinking' then case when $3 then 'canceled' else 'completed' end else 'unknown' end::text))
      where conversation_id=$1 and request_id=$2 and record->>'status' in ('pending','running')`, [conversationId, requestId, canceled])
  }
}
