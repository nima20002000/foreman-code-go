import { IdSchema, TimestampSchema, NativeSessionLaneSchema, ReviewJobSchema, type NativeSessionLane, type ReviewJob } from '@graphql/contracts'
import type pg from 'pg'

import { inTransaction } from '../../infrastructure/transaction.js'

import { DomainError } from '../errors.js'

function leaseInput(id: string, owner: string, token: string, expiresAt: string) {
  const input = {
    id: IdSchema.parse(id), owner: IdSchema.parse(owner), token: IdSchema.parse(token),
    expiresAt: new Date(TimestampSchema.parse(expiresAt)).toISOString(),
  }
  if (Date.parse(input.expiresAt) <= Date.now()) {
    throw new DomainError('LEASE_EXPIRY_INVALID', 'A new lease must expire in the future.', 400)
  }
  return input
}

function nonnegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new DomainError('REVISION_INVALID', 'Expected revision or attempt must be a nonnegative integer.', 400)
  return value
}

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
    const input = leaseInput(id, owner, token, leaseExpiresAt)
    return inTransaction(this.pool, undefined, async (client) => {
      // A leased job is recoverable only before submission. Persist submitted before
      // sending native work; unknown/submitted work must be reconciled, not redispatched.
      const result = await client.query<{ record: unknown }>(
        `update review_jobs set state='leased', revision=revision+1, updated_at=now(),
           record=record || jsonb_build_object('state','leased','leaseOwner',$2::text,
             'leaseToken',$3::text,'leaseExpiresAt',$4::text,
             'attempt',(record->>'attempt')::integer+1,'updatedAt',$5::text)
         where id=$1 and ($4::text)::timestamptz > clock_timestamp()
           and record->>'submittedAt' is null and record->>'providerTurnOrMessageId' is null
           and record->>'acknowledgedAt' is null and record->>'completedAt' is null
           and (state in ('pending','blocked_busy','blocked_disconnected')
             or (state='leased' and (record->>'leaseExpiresAt')::timestamptz <= clock_timestamp()))
         returning record`, [input.id, input.owner, input.token, input.expiresAt, new Date().toISOString()],
      )
      if (!result.rows[0]) throw new DomainError('REVIEW_JOB_NOT_CLAIMABLE', 'The review job is owned, expired input was supplied, or native work requires reconciliation.', 409)
      return ReviewJobSchema.parse(result.rows[0].record)
    })
  }

  /** Every worker write must present the claim's attempt as well as its owner/token. */
  async updateReviewJob(input: {
    id: string; owner: string; token: string; attempt: number;
    state: 'submitted' | 'acknowledged' | 'completed' | 'uncertain' | 'failed';
    providerTurnOrMessageId?: string;
  }): Promise<ReviewJob> {
    const id = IdSchema.parse(input.id)
    const owner = IdSchema.parse(input.owner)
    const token = IdSchema.parse(input.token)
    const attempt = nonnegativeInteger(input.attempt)
    const turnId = input.providerTurnOrMessageId === undefined ? undefined : IdSchema.parse(input.providerTurnOrMessageId)
    return inTransaction(this.pool, undefined, async (client) => {
      const found = await client.query<{ record: unknown }>('select record from review_jobs where id=$1 for update', [id])
      const current = found.rows[0] ? ReviewJobSchema.parse(found.rows[0].record) : undefined
      if (!current || current.leaseOwner !== owner || current.leaseToken !== token || current.attempt !== attempt) {
        throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The review job lease is no longer owned by this worker.', 409)
      }
      const transitions: Partial<Record<ReviewJob['state'], readonly ReviewJob['state'][]>> = {
        leased: ['submitted', 'uncertain', 'failed'],
        submitted: ['acknowledged', 'completed', 'uncertain', 'failed'],
        acknowledged: ['completed', 'uncertain', 'failed'],
        uncertain: ['acknowledged', 'completed', 'failed'],
      }
      if (!transitions[current.state]?.includes(input.state)) {
        throw new DomainError('REVIEW_JOB_TRANSITION_INVALID', 'The review job cannot make this lifecycle transition.', 409)
      }
      if (turnId && current.providerTurnOrMessageId && turnId !== current.providerTurnOrMessageId) {
        throw new DomainError('REVIEW_JOB_NATIVE_ID_CONFLICT', 'A submitted review cannot change native identity.', 409)
      }
      const now = new Date().toISOString()
      const next = ReviewJobSchema.parse({
        ...current, state: input.state, updatedAt: now,
        ...(turnId ? { providerTurnOrMessageId: turnId } : {}),
        ...(input.state === 'submitted' ? { submittedAt: now } : {}),
        ...(input.state === 'acknowledged' ? { acknowledgedAt: now } : {}),
        ...(input.state === 'completed' ? { completedAt: now } : {}),
      })
      const updated = await client.query(
        `update review_jobs set state=$2, revision=revision+1, record=$3::jsonb, updated_at=now()
         where id=$1 and record->>'leaseOwner'=$4 and record->>'leaseToken'=$5
           and (record->>'attempt')::integer=$6
           and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()`,
        [id, next.state, JSON.stringify(next), owner, token, attempt],
      )
      if (updated.rowCount !== 1) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The review job lease has expired.', 409)
      return next
    })
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
    const input = leaseInput(id, owner, token, leaseExpiresAt)
    const revision = nonnegativeInteger(expectedRevision)
    const correlation = IdSchema.parse(correlationId)
    return inTransaction(this.pool, undefined, async (client) => {
      const result = await client.query<{ record: unknown }>(
        `update native_session_lanes set revision=revision+1, updated_at=now(),
           record=record || jsonb_build_object('revision',revision+1,'leaseOwner',$3::text,
             'leaseToken',$4::text,'leaseExpiresAt',$5::text,'correlationId',$6::text)
         where id=$1 and revision=$2 and ($5::text)::timestamptz > clock_timestamp() and (
           record->>'leaseExpiresAt' is null or (record->>'leaseExpiresAt')::timestamptz <= clock_timestamp())
         returning record`, [input.id, revision, input.owner, input.token, input.expiresAt, correlation],
      )
      if (!result.rows[0]) throw new DomainError('SESSION_LANE_BUSY', 'The native session lane is busy, stale, or the new lease already expired.', 409)
      return NativeSessionLaneSchema.parse(result.rows[0].record)
    })
  }
}
