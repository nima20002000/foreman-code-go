import { NativeSessionLaneSchema, ReviewJobSchema, type NativeSessionLane, type ReviewJob } from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'

/** Durable fencing primitives for HAP-05. They do not dispatch or route work. */
export class PostgresInteractionCoordinationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async recoveryJobs(): Promise<ReviewJob[]> {
    const result = await this.pool.query<{ record: unknown }>(
      "select record from review_jobs where state in ('submitted','acknowledged','uncertain') order by created_at,id")
    return result.rows.map((row) => ReviewJobSchema.parse(row.record))
  }

  async renewReviewLease(jobId: string, jobToken: string, laneId: string, laneToken: string, expiresAt: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const job = await client.query("update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb($3::text)) where id=$1 and record->>'leaseToken'=$2", [jobId, jobToken, expiresAt])
      const lane = await client.query("update native_session_lanes set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb($3::text)) where id=$1 and record->>'leaseToken'=$2", [laneId, laneToken, expiresAt])
      if (job.rowCount !== 1 || lane.rowCount !== 1) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The reviewer lease was lost.', 409)
      await client.query('commit')
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }

  /** Observation only. The process-wide database owner excludes a second dispatcher. */
  async recoverReviewJob(job: ReviewJob, state: 'completed' | 'failed', error?: ReviewJob['error']): Promise<void> {
    const next = ReviewJobSchema.parse({ ...job, state, leaseOwner: undefined, leaseToken: undefined, leaseExpiresAt: undefined,
      ...(error ? { error } : {}), ...(state === 'completed' ? { completedAt: new Date().toISOString() } : {}), updatedAt: new Date().toISOString() })
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const changed = await client.query("update review_jobs set state=$2,record=$3::jsonb,revision=revision+1,updated_at=now() where id=$1 and record->>'correlationId'=$4 and state in ('submitted','acknowledged','uncertain')",
        [job.id, state, JSON.stringify(next), job.correlationId])
      if (changed.rowCount) await client.query("update native_session_lanes set record=(record-'leaseOwner'-'leaseToken'-'leaseExpiresAt'-'correlationId') || jsonb_build_object('observedStatus','idle','revision',revision+1),revision=revision+1,updated_at=now() where harness=$1 and native_session_id=$2 and record->>'correlationId'=$3",
        [job.provider, job.nativeSessionId, job.correlationId])
      await client.query('commit')
    } catch (failure) { await client.query('rollback'); throw failure } finally { client.release() }
  }

  async ensureReviewJob(job: ReviewJob, context?: { executionId: string; workingDirectory: string; providerVersion: string }): Promise<{ job: ReviewJob; created: boolean }> {
    const parsed = ReviewJobSchema.parse(job)
    const inserted = await this.pool.query<{ record: unknown }>(
      `insert into review_jobs (id, interaction_id, reviewer_agent_id, state, record, execution_id, working_directory, provider_version)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
       on conflict (interaction_id, reviewer_agent_id) do nothing returning record`,
      [parsed.id, parsed.interactionId, parsed.reviewerAgentId, parsed.state, JSON.stringify(parsed),
        context?.executionId ?? null, context?.workingDirectory ?? null, context?.providerVersion ?? null],
    )
    if (inserted.rows[0]) return { job: ReviewJobSchema.parse(inserted.rows[0].record), created: true }
    const current = await this.pool.query<{ record: unknown }>(
      'select record from review_jobs where interaction_id=$1 and reviewer_agent_id=$2',
      [parsed.interactionId, parsed.reviewerAgentId],
    )
    return { job: ReviewJobSchema.parse(current.rows[0]?.record), created: false }
  }

  async getReviewJobContext(id: string): Promise<{ executionId: string; workingDirectory: string; providerVersion: string }> {
    const result = await this.pool.query<{ execution_id: string | null; working_directory: string | null; provider_version: string | null }>(
      'select execution_id,working_directory,provider_version from review_jobs where id=$1', [id],
    )
    const row = result.rows[0]
    if (!row?.execution_id || !row.working_directory || !row.provider_version) {
      throw new DomainError('REVIEW_JOB_CONTEXT_MISSING', 'The review job has no durable execution ownership context.', 409)
    }
    return { executionId: row.execution_id, workingDirectory: row.working_directory, providerVersion: row.provider_version }
  }

  async claimReviewJob(id: string, owner: string, token: string, leaseExpiresAt: string): Promise<ReviewJob> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const found = await client.query<{ record: unknown }>(
        `select record from review_jobs where id=$1 and
         (state in ('pending','blocked_busy','blocked_disconnected') or
          (state='leased' and (record->>'leaseExpiresAt')::timestamptz <= now())) for update`, [id],
      )
      const current = found.rows[0] ? ReviewJobSchema.parse(found.rows[0].record) : undefined
      if (!current) throw new DomainError('REVIEW_JOB_NOT_CLAIMABLE', 'The review job is already owned or completed.', 409)
      const next = ReviewJobSchema.parse({
        ...current, state: 'leased', attempt: current.attempt + 1, leaseOwner: owner,
        leaseToken: token, leaseExpiresAt, updatedAt: new Date().toISOString(), error: undefined,
      })
      await client.query(
        `update review_jobs set state='leased',revision=revision+1,record=$2::jsonb,updated_at=now() where id=$1`,
        [id, JSON.stringify(next)],
      )
      await client.query('commit')
      return next
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }

  async nextReviewJob(reviewerAgentId: string): Promise<ReviewJob | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      `select record from review_jobs where reviewer_agent_id=$1 and
       (state in ('pending','blocked_busy','blocked_disconnected') or
        (state='leased' and (record->>'leaseExpiresAt')::timestamptz <= now()))
       order by created_at,id limit 1`, [reviewerAgentId],
    )
    return result.rows[0] ? ReviewJobSchema.parse(result.rows[0].record) : undefined
  }

  async transitionReviewJob(id: string, leaseToken: string, state: ReviewJob['state'], fields: {
    providerTurnOrMessageId?: string; error?: ReviewJob['error']
  } = {}): Promise<ReviewJob> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const found = await client.query<{ record: unknown }>('select record from review_jobs where id=$1 for update', [id])
      const current = found.rows[0] ? ReviewJobSchema.parse(found.rows[0].record) : undefined
      if (!current || current.leaseToken !== leaseToken) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The review job lease is no longer owned.', 409)
      const now = new Date().toISOString()
      const releases = ['completed', 'blocked_busy', 'blocked_disconnected', 'uncertain', 'failed'].includes(state)
      const next = ReviewJobSchema.parse({
        ...current, state, updatedAt: now,
        ...(state === 'submitted' ? { submittedAt: now } : {}),
        ...(state === 'acknowledged' ? { acknowledgedAt: now } : {}),
        ...(state === 'completed' ? { completedAt: now } : {}),
        ...(fields.providerTurnOrMessageId ? { providerTurnOrMessageId: fields.providerTurnOrMessageId } : {}),
        ...(fields.error ? { error: fields.error } : {}),
        ...(releases ? { leaseOwner: undefined, leaseToken: undefined, leaseExpiresAt: undefined } : {}),
      })
      await client.query(
        'update review_jobs set state=$2,revision=revision+1,record=$3::jsonb,updated_at=now() where id=$1',
        [id, state, JSON.stringify(next)],
      )
      await client.query('commit')
      return next
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
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

  async getLane(harness: NativeSessionLane['harness'], nativeSessionId: string): Promise<NativeSessionLane | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from native_session_lanes where harness=$1 and native_session_id=$2', [harness, nativeSessionId],
    )
    return result.rows[0] ? NativeSessionLaneSchema.parse(result.rows[0].record) : undefined
  }

  async releaseLane(id: string, leaseToken: string, observed: {
    observedStatus: NativeSessionLane['observedStatus']; currentTurnOrMessageId?: string; connectionGeneration?: number
  }): Promise<NativeSessionLane> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const found = await client.query<{ record: unknown }>('select record from native_session_lanes where id=$1 for update', [id])
      const current = found.rows[0] ? NativeSessionLaneSchema.parse(found.rows[0].record) : undefined
      if (!current || current.leaseToken !== leaseToken) throw new DomainError('SESSION_LANE_LEASE_LOST', 'The native session lane lease is no longer owned.', 409)
      const next = NativeSessionLaneSchema.parse({
        ...current, revision: current.revision + 1, observedStatus: observed.observedStatus,
        observedAt: new Date().toISOString(), connectionGeneration: observed.connectionGeneration ?? current.connectionGeneration,
        ...(observed.currentTurnOrMessageId ? { currentTurnOrMessageId: observed.currentTurnOrMessageId } : { currentTurnOrMessageId: undefined }),
        leaseOwner: undefined, leaseToken: undefined, leaseExpiresAt: undefined, correlationId: undefined,
      })
      await client.query(
        'update native_session_lanes set revision=$2,record=$3::jsonb,updated_at=now() where id=$1',
        [id, next.revision, JSON.stringify(next)],
      )
      await client.query('commit')
      return next
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }
}
