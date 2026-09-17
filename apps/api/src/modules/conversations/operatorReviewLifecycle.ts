import { randomUUID } from 'node:crypto'
import { MessageSchema } from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'

type Queryable = Pick<pg.PoolClient, 'query'>
export const isOperatorReview = (id: string): boolean => id.startsWith('operator-review:')

/** Only an actual automatic-review binding adds a human reader. Normal chats stay private. */
export const operatorConversationOwnerPredicate = `(c.owner_principal_id=$1 or exists (
  select 1 from durable_interactions i join run_authority_principals b on b.run_id=i.record->>'runId'
  where c.id='operator-review:' || i.id and c.owner_principal_id=b.principal_id and b.owner_principal_id=$1
))`

export interface OperatorReviewBinding {
  runId: string
  interactionId: string
  executionPrincipalId: string
  humanOwnerId: string
  active: boolean
}

/** No new schema: immutable Run bindings identify reviews; archived is their durable end fence. */
export class PostgresOperatorReviewLifecycle {
  constructor(private readonly pool: pg.Pool) {}

  async binding(id: string, query: Queryable = this.pool): Promise<OperatorReviewBinding | undefined> {
    const result = await query.query<OperatorReviewBinding>(`select b.run_id as "runId",i.id as "interactionId",
      b.principal_id as "executionPrincipalId",b.owner_principal_id as "humanOwnerId",
      coalesce(c.record->>'status'='open' and i.status='pending'
        and i.record->'approval'->>'handler'='operator' and nullif(i.record->>'graphInterruptId','') is not null
        and r.execution_state='waiting' and r.record->>'authorizationPrincipalId'=b.principal_id
        and p.revoked_at is null and p.expires_at>now()
        and not exists(select 1 from run_cleanup_intents cleanup where cleanup.run_id=r.id and cleanup.pending),false) as active
      from operator_conversations c join durable_interactions i on c.id='operator-review:' || i.id
      join run_authority_principals b on b.run_id=i.record->>'runId' and b.principal_id=c.owner_principal_id
      join runs r on r.id=b.run_id join management_principals p on p.id=b.principal_id
      where c.id=$1`, [id])
    return result.rows[0]
  }

  async assertActive(id: string, query: Queryable = this.pool): Promise<void> {
    if (isOperatorReview(id) && !(await this.binding(id, query))?.active) this.ended()
  }

  /** Lock the execution authority before a review is inserted. stopRun uses the same lock. */
  async lockAdmission(interactionId: string, principalId: string, client: pg.PoolClient): Promise<void> {
    const result = await client.query(`select p.id from management_principals p
      join run_authority_principals b on b.principal_id=p.id
      join runs r on r.id=b.run_id and r.record->>'authorizationPrincipalId'=p.id
      join durable_interactions i on i.record->>'runId'=r.id
      where i.id=$1 and p.id=$2 and p.delegated_from=b.owner_principal_id
        and p.revoked_at is null and p.expires_at>now() and r.execution_state='waiting'
        and i.status='pending' and i.record->'approval'->>'handler'='operator'
        and nullif(i.record->>'graphInterruptId','') is not null
        and not exists(select 1 from run_cleanup_intents cleanup where cleanup.run_id=r.id and cleanup.pending)
      for share of p,r`, [interactionId, principalId])
    if (result.rowCount !== 1) this.ended()
  }

  async candidates(): Promise<string[]> {
    return (await this.pool.query<{ id: string }>(`select id from operator_conversations
      where id like 'operator-review:%' and (record->>'status'='open' or active_request_id is not null)
      order by id`)).rows.map((row) => row.id)
  }

  async end(id: string, reason: string): Promise<void> {
    if (!isOperatorReview(id)) throw new DomainError('ACCESS_DENIED', 'Only automatic reviews have a Run-owned lifetime.', 403)
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await this.archive(client, id, reason)
      await client.query('commit')
    } catch (error) { await client.query('rollback').catch(() => undefined); throw error } finally { client.release() }
  }

  /** Durable fence first; never revokes the human owner or deletes review history. */
  async stopRun(runId: string, reason: string): Promise<string[]> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      // Admission/credential issuance holds a share lock on this tokenless principal.
      // Once this update commits, even a late credential cannot authenticate through its parent.
      await client.query(`update management_principals p set revoked_at=coalesce(p.revoked_at,now())
        from run_authority_principals b where b.run_id=$1 and p.id=b.principal_id
          and p.delegated_from=b.owner_principal_id`, [runId])
      // Commit the parent fence before locking conversations/child credentials.
      // Run admission locks caller and parent principals; combining these updates
      // in one transaction would invert that lock order. Revocation survives a
      // later archive failure, which is reported and repaired on retry.
      await client.query('commit')
      await client.query('begin')
      const rows = await client.query<{ id: string }>(`select c.id from operator_conversations c
        join durable_interactions i on c.id='operator-review:' || i.id
        where i.record->>'runId'=$1 order by c.id`, [runId])
      for (const row of rows.rows) await this.archive(client, row.id, reason)
      await client.query('commit')
      return rows.rows.map((row) => row.id)
    } catch (error) { await client.query('rollback').catch(() => undefined); throw error } finally { client.release() }
  }

  private async archive(client: pg.PoolClient, id: string, reason: string): Promise<void> {
    const row = (await client.query<{ archived: boolean }>(`select record->>'status'='archived' as archived
      from operator_conversations where id=$1 for update`, [id])).rows[0]
    if (!row) return
    if (!row.archived) {
      await client.query(`update operator_conversations set record=jsonb_set(record,'{status}','"archived"'::jsonb),
        cancel_requested=active_request_id is not null,
        turn_state=case when active_request_id is not null then 'canceling' else turn_state end,
        revision=revision+1,updated_at=now() where id=$1`, [id])
      const now = new Date().toISOString()
      const message = MessageSchema.parse({ id: randomUUID(), conversationId: id, role: 'system',
        content: `Automatic Operator review ended: ${reason}`, createdAt: now, updatedAt: now })
      await client.query(`insert into operator_conversation_messages(id,conversation_id,role,content,record)
        values($1,$2,'system',$3,$4::jsonb)`, [message.id, id, message.content, JSON.stringify(message)])
    }
    // Repeat this even for an archived review, so retry repairs a failed/late release.
    await client.query(`update management_principals set revoked_at=coalesce(revoked_at,now())
      where id in (select principal_id from operator_chat_credentials where conversation_id=$1)`, [id])
  }

  private ended(): never {
    throw new DomainError('OPERATOR_REVIEW_ENDED', 'This Run no longer permits automatic Operator review.', 409)
  }
}


/** Authentication-time guard: polling is not the authority boundary for a live review token. */
export async function requireActiveOperatorReviewCredential(database: Queryable, principalId: string): Promise<void> {
  const result = await database.query<{ active: boolean }>(`select coalesce(
      c.record->>'status'='open' and i.status='pending' and i.record->'approval'->>'handler'='operator'
      and nullif(i.record->>'graphInterruptId','') is not null and r.execution_state='waiting'
      and r.record->>'authorizationPrincipalId'=b.principal_id
      and p.delegated_from=b.principal_id and b.principal_id=c.owner_principal_id
      and not exists(select 1 from run_cleanup_intents cleanup where cleanup.run_id=r.id and cleanup.pending),false) as active
    from operator_chat_credentials credential join operator_conversations c on c.id=credential.conversation_id
    join management_principals p on p.id=credential.principal_id
    left join durable_interactions i on c.id='operator-review:' || i.id
    left join run_authority_principals b on b.run_id=i.record->>'runId' and b.principal_id=c.owner_principal_id
    left join runs r on r.id=b.run_id
    where credential.principal_id=$1 and c.id like 'operator-review:%'`, [principalId])
  if (result.rows.some((row) => !row.active)) {
    throw new DomainError('AUTH_REVIEW_ENDED', 'The automatic Operator review credential is no longer active.', 401)
  }
}
