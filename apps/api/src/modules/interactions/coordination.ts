import { NativeSessionLaneSchema, ReviewJobSchema, type NativeSessionLane, type ReviewJob } from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'

/** Durable fencing primitives for HAP-05. They do not dispatch or route work. */
export class PostgresInteractionCoordinationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async ensureReviewJob(job: ReviewJob): Promise<{ job: ReviewJob; created: boolean }> {
    const parsed = ReviewJobSchema.parse(job)
    const inserted = await this.pool.query<{ record: unknown }>(
      `insert into review_jobs (id, interaction_id, reviewer_agent_id, state, record)
       values ($1,$2,$3,$4,$5::jsonb)
       on conflict (interaction_id, reviewer_agent_id) do nothing returning record`,
      [parsed.id, parsed.interactionId, parsed.reviewerAgentId, parsed.state, JSON.stringify(parsed)],
    )
    if (inserted.rows[0]) return { job: ReviewJobSchema.parse(inserted.rows[0].record), created: true }
    const current = await this.pool.query<{ record: unknown }>(
      'select record from review_jobs where interaction_id=$1 and reviewer_agent_id=$2',
      [parsed.interactionId, parsed.reviewerAgentId],
    )
    return { job: ReviewJobSchema.parse(current.rows[0]?.record), created: false }
  }

  async claimReviewJob(id: string, owner: string, token: string, leaseExpiresAt: string): Promise<ReviewJob> {
    const result = await this.pool.query<{ record: unknown }>(
      `update review_jobs set state='leased', revision=revision+1, updated_at=now(),
         record=jsonb_set(jsonb_set(jsonb_set(jsonb_set(record, '{state}', '"leased"'),
           '{leaseOwner}', to_jsonb($2::text)), '{leaseToken}', to_jsonb($3::text)),
           '{leaseExpiresAt}', to_jsonb($4::text))
       where id=$1 and state in ('pending','blocked_busy','blocked_disconnected')
       returning record`, [id, owner, token, leaseExpiresAt],
    )
    if (!result.rows[0]) throw new DomainError('REVIEW_JOB_NOT_CLAIMABLE', 'The review job is already owned or completed.', 409)
    return ReviewJobSchema.parse(result.rows[0].record)
  }

  async ensureLane(lane: NativeSessionLane): Promise<NativeSessionLane> {
    const parsed = NativeSessionLaneSchema.parse(lane)
    const result = await this.pool.query<{ record: unknown }>(
      `insert into native_session_lanes (id,harness,native_session_id,owner_agent_id,revision,record)
       values ($1,$2,$3,$4,$5,$6::jsonb)
       on conflict (harness,native_session_id) do update set native_session_id=excluded.native_session_id
       returning record`,
      [parsed.id, parsed.harness, parsed.nativeSessionId, parsed.ownerAgentId, parsed.revision, JSON.stringify(parsed)],
    )
    const current = NativeSessionLaneSchema.parse(result.rows[0]?.record)
    if (current.ownerAgentId !== parsed.ownerAgentId) throw new DomainError('SESSION_LANE_OWNER_CONFLICT', 'The native session belongs to another Agent.', 409)
    return current
  }

  async claimLane(id: string, expectedRevision: number, owner: string, token: string, leaseExpiresAt: string, correlationId: string): Promise<NativeSessionLane> {
    const result = await this.pool.query<{ record: unknown }>(
      `update native_session_lanes set revision=revision+1, updated_at=now(),
         record=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(record,
           '{revision}', to_jsonb((revision+1)::bigint)), '{leaseOwner}', to_jsonb($3::text)),
           '{leaseToken}', to_jsonb($4::text)), '{leaseExpiresAt}', to_jsonb($5::text)),
           '{correlationId}', to_jsonb($6::text))
       where id=$1 and revision=$2 and (
         record->>'leaseExpiresAt' is null or (record->>'leaseExpiresAt')::timestamptz <= now())
       returning record`, [id, expectedRevision, owner, token, leaseExpiresAt, correlationId],
    )
    if (!result.rows[0]) throw new DomainError('SESSION_LANE_BUSY', 'The native session lane is busy or stale.', 409)
    return NativeSessionLaneSchema.parse(result.rows[0].record)
  }
}
