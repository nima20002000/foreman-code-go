import { OperatorActivityPageSchema, OperatorActivityQuerySchema, OperatorActivitySchema, type OperatorActivity, type OperatorActivityQuery } from '@graphql/contracts'
import type pg from 'pg'
import type { OperatorActivityChange } from './operatorActivity.js'

type Queryable = Pick<pg.PoolClient, 'query'>
const changeSchema = OperatorActivitySchema.omit({ sequence: true, revision: true })

export class PostgresOperatorActivityRepository {
  constructor(private readonly pool: pg.Pool) {}

  async append(conversationId: string, requestId: string, input: OperatorActivityChange): Promise<{ activity: OperatorActivity; revision: number } | undefined> {
    const value = changeSchema.parse(input)
    if (value.requestId !== requestId) throw new Error('Activity belongs to a different request.')
    const result = await this.pool.query<{ record: unknown; sequence: string; activity_revision: string; conversation_revision: string }>(`
      with owner as (
        select id from operator_conversations where id=$1 and active_request_id=$2 and deleted_at is null for update
      ), applied as (
        insert into operator_conversation_activity as activity (conversation_id,request_id,activity_id,record)
          select id,$2,$3,$4::jsonb from owner
        on conflict(conversation_id,request_id,activity_id) do update set
          record=activity.record || excluded.record, revision=activity.revision+1
        where activity.record is distinct from (activity.record || excluded.record)
          and (activity.record->>'status' not in ('completed','failed','canceled') or activity.record->>'status'=excluded.record->>'status')
          and not (activity.record->>'status'='running' and excluded.record->>'status'='pending')
        returning record,sequence,revision
      ), bumped as (
        update operator_conversations set revision=revision+1
          where id in (select id from owner) and exists(select 1 from applied) returning revision
      ) select applied.record,applied.sequence::text,applied.revision::text as activity_revision,
        bumped.revision::text as conversation_revision from applied cross join bumped`,
    [conversationId, requestId, value.id, JSON.stringify(value)])
    const row = result.rows[0]
    return row ? { activity: OperatorActivitySchema.parse({ ...(row.record as object), sequence: row.sequence, revision: Number(row.activity_revision) }),
      revision: Number(row.conversation_revision) } : undefined
  }

  async page(conversationId: string, input: Partial<OperatorActivityQuery> = {}, query: Queryable = this.pool) {
    const { before, limit } = OperatorActivityQuerySchema.parse(input)
    const result = await query.query<{ record: unknown; sequence: string; revision: string }>(`
      select record,sequence::text,revision::text from operator_conversation_activity
      where conversation_id=$1 and ($2::bigint is null or sequence<$2::bigint)
      order by sequence desc limit $3`, [conversationId, before ?? null, limit + 1])
    const rows = result.rows.slice(0, limit)
    return OperatorActivityPageSchema.parse({
      activities: rows.reverse().map((row) => ({ ...(row.record as object), sequence: row.sequence, revision: Number(row.revision) })),
      nextCursor: result.rows.length > limit ? result.rows[limit - 1]!.sequence : null,
    })
  }

  async finish(conversationId: string, requestId: string, canceled: boolean, query: Queryable): Promise<void> {
    // A terminal turn is not proof that every tool succeeded. Preserve missing
    // completion evidence explicitly instead of painting all entries successful.
    await query.query(`update operator_conversation_activity set revision=revision+1,
      record=jsonb_set(record,'{status}',to_jsonb(case when $3 then 'canceled'
        when record->>'kind'='thinking' then 'completed' else 'unknown' end::text))
      where conversation_id=$1 and request_id=$2 and record->>'status' in ('pending','running')`, [conversationId, requestId, canceled])
  }
}
