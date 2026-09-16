import { NativeSessionLaneSchema, ReviewJobSchema, type NativeHarnessEvent, type NativeSessionLane, type ReviewJob } from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'
import { appendNativeEvent } from '../runs/nativeEvents.js'

// A submitted job may have reached the provider even when no acknowledgement was saved.
const recoverableJob = `state in ('pending','leased','blocked_busy','blocked_disconnected','submitted','acknowledged','uncertain')
  and (record->>'leaseExpiresAt' is null or (record->>'leaseExpiresAt')::timestamptz <= clock_timestamp())`

export interface WriterFence { id: string; token: string }

/** Durable fencing primitives for HAP-05. They do not dispatch or route work. */
export class PostgresInteractionCoordinationRepository {
  constructor(private readonly pool: pg.Pool) {}

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
    const existing = ReviewJobSchema.parse(current.rows[0]?.record)
    if (existing.provider !== parsed.provider || existing.nativeSessionId !== parsed.nativeSessionId) {
      throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'A review cannot move to a replacement native session.', 409)
    }
    return { job: existing, created: false }
  }

  async findReviewJob(interactionId: string, reviewerAgentId: string): Promise<ReviewJob | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from review_jobs where interaction_id=$1 and reviewer_agent_id=$2',
      [interactionId, reviewerAgentId],
    )
    return result.rows[0] ? ReviewJobSchema.parse(result.rows[0].record) : undefined
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

  async appendReviewNativeEvent(job: ReviewJob, event: NativeHarnessEvent): Promise<void> {
    const result = await this.pool.query<{ record: unknown; execution_id: string | null }>(
      'select record,execution_id from review_jobs where id=$1', [job.id],
    )
    const row = result.rows[0]
    const current = row ? ReviewJobSchema.parse(row.record) : undefined
    if (!row?.execution_id || !current || current.provider !== job.provider
      || current.nativeSessionId !== job.nativeSessionId || current.correlationId !== job.correlationId
      || current.reviewerAgentId !== job.reviewerAgentId || current.interactionId !== job.interactionId) {
      throw new DomainError('REVIEW_JOB_CONTEXT_MISSING', 'Native review history must match the durable reviewer execution and submission.', 409)
    }
    await appendNativeEvent(this.pool, { ...event, executionId: row.execution_id })
  }

  async claimReviewJob(id: string, owner: string, token: string, leaseExpiresAt: string): Promise<ReviewJob> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const found = await client.query<{ record: unknown }>(
        `select record from review_jobs where id=$1 and
         ${recoverableJob} and $2::timestamptz > clock_timestamp() for update`, [id, leaseExpiresAt],
      )
      const current = found.rows[0] ? ReviewJobSchema.parse(found.rows[0].record) : undefined
      if (!current) throw new DomainError('REVIEW_JOB_NOT_CLAIMABLE', 'The review job is already owned or completed.', 409)
      const next = ReviewJobSchema.parse({
        ...current, state: ['submitted', 'acknowledged', 'uncertain'].includes(current.state) ? current.state : 'leased', attempt: current.attempt + 1, leaseOwner: owner,
        leaseToken: token, leaseExpiresAt, updatedAt: new Date().toISOString(), error: undefined,
      })
      await client.query(
        `update review_jobs set state=$3,revision=revision+1,record=$2::jsonb,updated_at=now() where id=$1`,
        [id, JSON.stringify(next), next.state],
      )
      await client.query('commit')
      return next
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }

  async nextReviewJob(reviewerAgentId: string): Promise<ReviewJob | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      `select record from review_jobs where reviewer_agent_id=$1 and
       ${recoverableJob}
       order by updated_at,id limit 1`, [reviewerAgentId],
    )
    return result.rows[0] ? ReviewJobSchema.parse(result.rows[0].record) : undefined
  }

  async reviewJobAgents(): Promise<string[]> {
    const result = await this.pool.query<{ reviewer_agent_id: string }>(
      `select distinct reviewer_agent_id from review_jobs where ${recoverableJob}`,
    )
    return result.rows.map((row) => row.reviewer_agent_id)
  }

  async isReviewPending(interactionId: string, reviewerAgentId: string): Promise<boolean> {
    const result = await this.pool.query(
      `select id from durable_interactions where id=$1 and status='pending'
       and record->'approval'->>'handler'='orchestrator'
       and record->'approval'->>'designatedOrchestratorAgentId'=$2`, [interactionId, reviewerAgentId],
    )
    return result.rowCount === 1
  }

  async assertReviewJobLease(id: string, token: string): Promise<void> {
    const result = await this.pool.query(
      `select id from review_jobs where id=$1 and record->>'leaseToken'=$2
       and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()`, [id, token],
    )
    if (!result.rowCount) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The review job lease expired or changed owners.', 409)
  }

  async renewReviewJob(id: string, token: string, leaseMs: number): Promise<string> {
    const result = await this.pool.query<{ expires_at: string }>(
      `update review_jobs set revision=revision+1, updated_at=clock_timestamp(),
       record=jsonb_set(record, '{leaseExpiresAt}', to_jsonb(to_char(
         (clock_timestamp()+($3 * interval '1 millisecond')) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
       where id=$1 and record->>'leaseToken'=$2
       and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()
       returning record->>'leaseExpiresAt' as expires_at`, [id, token, leaseMs],
    )
    if (result.rowCount !== 1) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'An expired review lease cannot be renewed.', 409)
    return result.rows[0]!.expires_at
  }

  async transitionReviewJob(id: string, leaseToken: string, state: ReviewJob['state'], fields: {
    providerTurnOrMessageId?: string; error?: ReviewJob['error']; writerFence?: WriterFence; releaseLease?: boolean
  } = {}, expected?: { revision: number; fence: number }): Promise<ReviewJob> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const found = await client.query<{ record: unknown; revision: string; lease_fence: string; lease_active: boolean }>(
        `select record,revision::text,lease_fence::text,
           coalesce(lease_expires_at > clock_timestamp(),false) as lease_active
         from review_jobs where id=$1 for update`, [id],
      )
      const row = found.rows[0]
      const current = row ? ReviewJobSchema.parse(row.record) : undefined
      if (!row?.lease_active || !current || current.leaseToken !== leaseToken
        || (expected && (Number(row.revision) !== expected.revision || Number(row.lease_fence) !== expected.fence))) {
        throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The review job revision or lease is no longer owned.', 409)
      }
      if (current.providerTurnOrMessageId && fields.providerTurnOrMessageId
        && current.providerTurnOrMessageId !== fields.providerTurnOrMessageId) {
        throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The review job is already bound to another provider turn or message.', 409)
      }
      if (fields.writerFence) {
        const owned = await client.query(
          `select id from native_session_lanes where id=$1 and record->>'leaseToken'=$2
           and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp() for update`,
          [fields.writerFence.id, fields.writerFence.token],
        )
        if (!owned.rowCount) throw new DomainError('SESSION_LANE_LEASE_LOST', 'The native writer is no longer owned.', 409)
      }
      const now = new Date().toISOString()
      const releases = fields.releaseLease || ['completed', 'blocked_busy', 'blocked_disconnected', 'uncertain', 'failed'].includes(state)
      const next = ReviewJobSchema.parse({
        ...current, state, updatedAt: now,
        ...(state === 'submitted' ? { submittedAt: current.submittedAt ?? now } : {}),
        ...(state === 'acknowledged' ? { acknowledgedAt: current.acknowledgedAt ?? now } : {}),
        ...(state === 'completed' ? { completedAt: current.completedAt ?? now } : {}),
        ...(fields.providerTurnOrMessageId ? { providerTurnOrMessageId: fields.providerTurnOrMessageId } : {}),
        ...(fields.error ? { error: fields.error } : {}),
        ...(releases ? { leaseOwner: undefined, leaseToken: undefined, leaseExpiresAt: undefined } : {}),
      })
      const updated = await client.query(
        `update review_jobs set state=$2,revision=revision+1,record=$3::jsonb,updated_at=now()
         where id=$1 and revision=$4 and lease_token=$5 and lease_fence=$6
           and lease_expires_at > clock_timestamp()
           and ($7::text is null or exists (
             select 1 from native_session_lanes where id=$7 and record->>'leaseToken'=$8
               and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()))`,
        [id, state, JSON.stringify(next), row.revision, leaseToken, row.lease_fence, fields.writerFence?.id ?? null, fields.writerFence?.token ?? null],
      )
      if (updated.rowCount !== 1) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The review job lease expired during its transition.', 409)
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
         record=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(record,
           '{revision}', to_jsonb((revision+1)::bigint)), '{leaseOwner}', to_jsonb($3::text)),
           '{leaseToken}', to_jsonb($4::text)), '{leaseExpiresAt}', to_jsonb(to_char($5::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
           '{correlationId}', to_jsonb($6::text)), '{observedStatus}', '"busy"'::jsonb)
       where id=$1 and revision=$2 and $5::timestamptz > clock_timestamp() and (
         record->>'leaseExpiresAt' is null or (record->>'leaseExpiresAt')::timestamptz <= clock_timestamp())
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

  async bindLaneTurn(fence: WriterFence, correlationId: string): Promise<void> {
    const result = await this.pool.query(
      `update native_session_lanes set revision=revision+1, updated_at=clock_timestamp(),
       record=jsonb_set(jsonb_set(record - 'currentTurnOrMessageId', '{revision}', to_jsonb((revision+1)::bigint)),
         '{correlationId}', to_jsonb($3::text))
       where id=$1 and record->>'leaseToken'=$2
       and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()`, [fence.id, fence.token, correlationId],
    )
    if (result.rowCount !== 1) throw new DomainError('SESSION_LANE_LEASE_LOST', 'The native writer is no longer owned.', 409)
  }

  async assertLaneLease(id: string, token: string): Promise<void> {
    const result = await this.pool.query(
      `select id from native_session_lanes where id=$1 and record->>'leaseToken'=$2
       and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()`, [id, token],
    )
    if (!result.rowCount) throw new DomainError('SESSION_LANE_LEASE_LOST', 'The native writer lease expired or changed owners.', 409)
  }

  async renewLane(id: string, token: string, leaseMs: number): Promise<string> {
    const result = await this.pool.query<{ expires_at: string }>(
      `update native_session_lanes set revision=revision+1, updated_at=clock_timestamp(),
       record=jsonb_set(jsonb_set(record, '{revision}', to_jsonb((revision+1)::bigint)),
         '{leaseExpiresAt}', to_jsonb(to_char(
           (clock_timestamp()+($3 * interval '1 millisecond')) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
       where id=$1 and record->>'leaseToken'=$2
       and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()
       returning record->>'leaseExpiresAt' as expires_at`, [id, token, leaseMs],
    )
    if (result.rowCount !== 1) throw new DomainError('SESSION_LANE_LEASE_LOST', 'An expired native writer lease cannot be renewed.', 409)
    return result.rows[0]!.expires_at
  }

  async releaseLane(id: string, leaseToken: string, observed: {
    observedStatus: NativeSessionLane['observedStatus']; currentTurnOrMessageId?: string; connectionGeneration?: number
  }): Promise<NativeSessionLane> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const found = await client.query<{ record: unknown }>(
        `select record from native_session_lanes where id=$1 and record->>'leaseToken'=$2
         and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp() for update`, [id, leaseToken],
      )
      const current = found.rows[0] ? NativeSessionLaneSchema.parse(found.rows[0].record) : undefined
      if (!current || current.leaseToken !== leaseToken) throw new DomainError('SESSION_LANE_LEASE_LOST', 'The native session lane lease is no longer owned.', 409)
      const next = NativeSessionLaneSchema.parse({
        ...current, revision: current.revision + 1, observedStatus: observed.observedStatus,
        observedAt: new Date().toISOString(), connectionGeneration: observed.connectionGeneration ?? current.connectionGeneration,
        ...(observed.currentTurnOrMessageId ? { currentTurnOrMessageId: observed.currentTurnOrMessageId } : { currentTurnOrMessageId: undefined }),
        leaseOwner: undefined, leaseToken: undefined, leaseExpiresAt: undefined,
        correlationId: observed.observedStatus === 'idle' ? undefined : current.correlationId,
      })
      const updated = await client.query(
        `update native_session_lanes set revision=$2,record=$3::jsonb,updated_at=now()
         where id=$1 and record->>'leaseToken'=$4
         and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()`,
        [id, next.revision, JSON.stringify(next), leaseToken],
      )
      if (updated.rowCount !== 1) throw new DomainError('SESSION_LANE_LEASE_LOST', 'The native writer expired during release.', 409)
      await client.query('commit')
      return next
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }
}
