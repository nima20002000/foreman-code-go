import { randomUUID } from 'node:crypto'

import { DurableInteractionSchema, ReviewJobSchema, type DurableInteraction, type ReviewJob } from '@foreman-code/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'
import {
  assertInteractionRevision, interactionTransaction, lockInteraction, type InteractionLease,
} from './persistence.js'

interface LeaseRow {
  lease_owner: string | null
  lease_token: string | null
  lease_fence: string
  lease_expires_at: Date | null
}

interface GraphResumeRow extends LeaseRow {
  interaction_id: string
  run_id: string
  execution_id: string
  graph_thread_id: string
  graph_interrupt_id: string | null
  delivery_revision: string
  state: 'pending' | 'resuming' | 'resumed' | 'blocked' | 'canceled'
  revision: string
  evidence: Record<string, unknown>
  error: { code: string; message: string } | null
}

export interface GraphResumeIntent {
  interactionId: string
  runId: string
  executionId: string
  graphThreadId: string
  graphInterruptId: string | null
  deliveryRevision: number
  state: GraphResumeRow['state']
  revision: number
  lease: InteractionLease | null
  evidence: Record<string, unknown>
  error: { code: string; message: string } | null
}

function leaseFrom(row: LeaseRow): InteractionLease | null {
  return row.lease_owner && row.lease_token && row.lease_expires_at ? {
    owner: row.lease_owner, token: row.lease_token, fence: Number(row.lease_fence), expiresAt: row.lease_expires_at.toISOString(),
  } : null
}

function graphResume(row: GraphResumeRow): GraphResumeIntent {
  return {
    interactionId: row.interaction_id, runId: row.run_id, executionId: row.execution_id,
    graphThreadId: row.graph_thread_id, graphInterruptId: row.graph_interrupt_id,
    deliveryRevision: Number(row.delivery_revision), state: row.state, revision: Number(row.revision),
    lease: leaseFrom(row), evidence: row.evidence, error: row.error,
  }
}

function validLeaseInput(owner: string, leaseMs: number): void {
  if (!owner.trim() || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new DomainError('LEASE_INVALID', 'A lease requires an owner and a positive integer duration.', 400)
  }
}

/** Persistence only. An expired lease permits inspection, never native resubmission. */
export class PostgresInteractionRecoveryRepository {
  constructor(private readonly pool: pg.Pool) {}

  async claimDelivery(id: string, expectedRevision: number, owner: string, leaseMs: number): Promise<{
    interaction: DurableInteraction; lease: InteractionLease; requiresReconciliation: boolean
  }> {
    validLeaseInput(owner, leaseMs)
    return interactionTransaction(this.pool, async (client) => {
      const row = await lockInteraction(client, id)
      const current = row.interaction
      assertInteractionRevision(current, expectedRevision)
      if (row.leaseActive || current.status !== 'delivery_pending') {
        throw new DomainError('DELIVERY_NOT_CLAIMABLE', 'The delivery is already owned or is not pending.', 409)
      }
      const next = DurableInteractionSchema.parse({ ...current, revision: current.revision + 1, updatedAt: new Date().toISOString() })
      const token = `delivery-lease-${randomUUID()}`
      const claimed = await client.query<{ delivery_fence: string; delivery_lease_expires_at: Date }>(
        `update durable_interactions set delivery_owner=$2,delivery_token=$3,delivery_fence=delivery_fence+1,
           delivery_lease_expires_at=clock_timestamp()+($4::bigint*interval '1 millisecond'),
           revision=$5,record=$6::jsonb,updated_at=now()
         where id=$1 and revision=$7 and (delivery_lease_expires_at is null or delivery_lease_expires_at <= clock_timestamp())
           and not exists (select 1 from approval_execution_state b where b.execution_id=durable_interactions.execution_id and b.stopped_at is not null)
         returning delivery_fence::text,delivery_lease_expires_at`,
        [id, owner, token, leaseMs, next.revision, JSON.stringify(next), current.revision],
      )
      const claim = claimed.rows[0]
      if (!claim) throw new DomainError('DELIVERY_NOT_CLAIMABLE', 'The delivery was stopped or another worker owns it.', 409)
      return {
        interaction: next,
        lease: { owner, token, fence: Number(claim.delivery_fence), expiresAt: claim.delivery_lease_expires_at.toISOString() },
        requiresReconciliation: current.deliveryState !== 'pending',
      }
    })
  }

  async renewDelivery(id: string, lease: InteractionLease, leaseMs: number): Promise<InteractionLease> {
    validLeaseInput(lease.owner, leaseMs)
    const result = await this.pool.query<{ delivery_lease_expires_at: Date }>(
      `update durable_interactions set delivery_lease_expires_at=clock_timestamp()+($5::bigint*interval '1 millisecond')
       where id=$1 and delivery_owner=$2 and delivery_token=$3 and delivery_fence=$4
         and delivery_lease_expires_at > clock_timestamp() and status='delivery_pending'
       returning delivery_lease_expires_at`, [id, lease.owner, lease.token, lease.fence, leaseMs],
    )
    if (!result.rows[0]) throw new DomainError('DELIVERY_LEASE_LOST', 'The delivery lease is no longer owned.', 409)
    return { ...lease, expiresAt: result.rows[0].delivery_lease_expires_at.toISOString() }
  }

  async releaseDelivery(id: string, lease: InteractionLease): Promise<void> {
    const result = await this.pool.query(
      `update durable_interactions set delivery_owner=null,delivery_token=null,delivery_lease_expires_at=null
       where id=$1 and delivery_owner=$2 and delivery_token=$3 and delivery_fence=$4
         and delivery_lease_expires_at > clock_timestamp()`, [id, lease.owner, lease.token, lease.fence],
    )
    if (result.rowCount !== 1) throw new DomainError('DELIVERY_LEASE_LOST', 'The delivery lease is no longer owned.', 409)
  }

  async listDeliveryRecovery(limit: number): Promise<DurableInteraction[]> {
    const found = await this.pool.query<{ record: unknown }>(
      `select record from durable_interactions where status='delivery_pending'
         and (delivery_lease_expires_at is null or delivery_lease_expires_at <= clock_timestamp())
       order by delivery_lease_expires_at nulls first,id limit $1`, [limit],
    )
    return found.rows.map((row) => DurableInteractionSchema.parse(row.record))
  }

  async getGraphResume(id: string): Promise<GraphResumeIntent | undefined> {
    const found = await this.pool.query<GraphResumeRow>('select * from interaction_graph_resumes where interaction_id=$1', [id])
    return found.rows[0] ? graphResume(found.rows[0]) : undefined
  }

  async listGraphResumeRecovery(limit: number): Promise<GraphResumeIntent[]> {
    const found = await this.pool.query<GraphResumeRow>(
      `select * from interaction_graph_resumes where state in ('pending','resuming','blocked')
         and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
       order by lease_expires_at nulls first,interaction_id limit $1`, [limit],
    )
    return found.rows.map(graphResume)
  }

  async claimGraphResume(id: string, expectedRevision: number, owner: string, leaseMs: number): Promise<GraphResumeIntent> {
    validLeaseInput(owner, leaseMs)
    return interactionTransaction(this.pool, async (client) => {
      // Always lock interaction before resume intent, matching delivery/Stop triggers.
      const { interaction } = await lockInteraction(client, id)
      if (interaction.status !== 'delivered' || !interaction.graphInterruptId || !interaction.selectedOptionId) {
        throw new DomainError('GRAPH_RESUME_NOT_CLAIMABLE', 'The exact delivered interaction and graph interrupt are required.', 409)
      }
      const result = await client.query<GraphResumeRow>(
        `update interaction_graph_resumes set state='resuming',revision=revision+1,
           lease_owner=$3,lease_token=$4,lease_fence=lease_fence+1,
           lease_expires_at=clock_timestamp()+($5::bigint*interval '1 millisecond'),updated_at=now()
         where interaction_id=$1 and revision=$2 and state in ('pending','resuming','blocked')
           and graph_thread_id=$6 and graph_interrupt_id=$7
           and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
           and not exists (select 1 from approval_execution_state b where b.execution_id=interaction_graph_resumes.execution_id and b.stopped_at is not null)
         returning *`,
        [id, expectedRevision, owner, `graph-resume-${randomUUID()}`, leaseMs, interaction.graphThreadId, interaction.graphInterruptId],
      )
      if (!result.rows[0]) throw new DomainError('GRAPH_RESUME_NOT_CLAIMABLE', 'The graph resume intent is owned, stopped, or stale.', 409)
      return graphResume(result.rows[0])
    })
  }

  async renewGraphResume(id: string, lease: InteractionLease, leaseMs: number): Promise<InteractionLease> {
    validLeaseInput(lease.owner, leaseMs)
    const result = await this.pool.query<{ lease_expires_at: Date }>(
      `update interaction_graph_resumes set lease_expires_at=clock_timestamp()+($5::bigint*interval '1 millisecond')
       where interaction_id=$1 and lease_owner=$2 and lease_token=$3 and lease_fence=$4
         and state='resuming' and lease_expires_at > clock_timestamp() returning lease_expires_at`,
      [id, lease.owner, lease.token, lease.fence, leaseMs],
    )
    if (!result.rows[0]) throw new DomainError('GRAPH_RESUME_LEASE_LOST', 'The graph resume lease is no longer owned.', 409)
    return { ...lease, expiresAt: result.rows[0].lease_expires_at.toISOString() }
  }

  async finishGraphResume(id: string, expectedRevision: number, lease: InteractionLease, result: {
    state: 'resumed' | 'blocked'
    graphThreadId: string
    graphInterruptId: string
    evidence: Record<string, unknown>
    error?: { code: string; message: string }
  }): Promise<GraphResumeIntent> {
    return interactionTransaction(this.pool, async (client) => {
      const { interaction } = await lockInteraction(client, id)
      if (interaction.status !== 'delivered' || interaction.graphThreadId !== result.graphThreadId
        || interaction.graphInterruptId !== result.graphInterruptId) {
        throw new DomainError('GRAPH_RESUME_IDENTITY_CONFLICT', 'The graph resume result does not match the delivered interaction.', 409)
      }
      const updated = await client.query<GraphResumeRow>(
        `update interaction_graph_resumes set state=$6,revision=revision+1,evidence=$7::jsonb,
           error=coalesce($8::jsonb,error),lease_owner=null,lease_token=null,lease_expires_at=null,updated_at=now()
         where interaction_id=$1 and revision=$2 and lease_owner=$3 and lease_token=$4 and lease_fence=$5
           and state='resuming' and lease_expires_at > clock_timestamp() returning *`,
        [id, expectedRevision, lease.owner, lease.token, lease.fence, result.state,
          JSON.stringify(result.evidence), result.error ? JSON.stringify(result.error) : null],
      )
      if (!updated.rows[0]) throw new DomainError('GRAPH_RESUME_LEASE_LOST', 'The graph resume revision or lease changed.', 409)
      return graphResume(updated.rows[0])
    })
  }

  async listReviewRecovery(reviewerAgentId: string, limit: number): Promise<Array<{ job: ReviewJob; revision: number }>> {
    const found = await this.pool.query<{ record: unknown; revision: string }>(
      `select record,revision::text from review_jobs where reviewer_agent_id=$1
         and state in ('leased','submitted','acknowledged','uncertain')
         and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
       order by created_at,id limit $2`, [reviewerAgentId, limit],
    )
    return found.rows.map((row) => ({ job: ReviewJobSchema.parse(row.record), revision: Number(row.revision) }))
  }

  async claimReviewRecovery(id: string, expectedRevision: number, owner: string, leaseMs: number): Promise<{
    job: ReviewJob; revision: number; lease: InteractionLease
  }> {
    validLeaseInput(owner, leaseMs)
    return interactionTransaction(this.pool, async (client) => {
      const found = await client.query<{ record: unknown; revision: string }>('select record,revision::text from review_jobs where id=$1 for update', [id])
      const row = found.rows[0]
      if (!row || Number(row.revision) !== expectedRevision) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The review job revision changed.', 409)
      const current = ReviewJobSchema.parse(row.record)
      const expiration = await client.query<{ expires_at: Date }>(
        "select clock_timestamp()+($1::bigint*interval '1 millisecond') as expires_at", [leaseMs],
      )
      const leaseExpiresAt = expiration.rows[0]!.expires_at.toISOString()
      const job = ReviewJobSchema.parse({
        ...current, leaseOwner: owner, leaseToken: `review-recovery-${randomUUID()}`, leaseExpiresAt, updatedAt: new Date().toISOString(),
      })
      // In particular, do not reset submitted/acknowledged to leased, increment
      // attempt, replace correlationId, or clear existing provider/error evidence.
      const updated = await client.query<LeaseRow & { revision: string }>(
        `update review_jobs set record=$3::jsonb,revision=revision+1,updated_at=now()
         where id=$1 and revision=$2 and state in ('leased','submitted','acknowledged','uncertain')
           and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
         returning lease_owner,lease_token,lease_fence::text,lease_expires_at,revision::text`,
        [id, expectedRevision, JSON.stringify(job)],
      )
      if (!updated.rows[0]) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The review job is owned or no longer recoverable.', 409)
      return { job, revision: Number(updated.rows[0].revision), lease: leaseFrom(updated.rows[0])! }
    })
  }

  async renewReviewRecovery(id: string, lease: InteractionLease, leaseMs: number): Promise<InteractionLease> {
    validLeaseInput(lease.owner, leaseMs)
    const updated = await this.pool.query<{ lease_expires_at: Date }>(
      `update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb(
         to_char((clock_timestamp()+($5::bigint*interval '1 millisecond')) at time zone 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
       where id=$1 and lease_owner=$2 and lease_token=$3 and lease_fence=$4
         and lease_expires_at > clock_timestamp() and state in ('leased','submitted','acknowledged','uncertain')
       returning lease_expires_at`, [id, lease.owner, lease.token, lease.fence, leaseMs],
    )
    if (!updated.rows[0]) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The review recovery lease is no longer owned.', 409)
    return { ...lease, expiresAt: updated.rows[0].lease_expires_at.toISOString() }
  }

  async recordReviewRecovery(id: string, expectedRevision: number, lease: InteractionLease, evidence: {
    nativeSessionId: string; correlationId: string; providerTurnOrMessageId?: string; details: Record<string, unknown>
  }): Promise<number> {
    return interactionTransaction(this.pool, async (client) => {
      const found = await client.query<{ record: unknown }>('select record from review_jobs where id=$1 for update', [id])
      const current = found.rows[0] ? ReviewJobSchema.parse(found.rows[0].record) : undefined
      if (!current || current.nativeSessionId !== evidence.nativeSessionId || current.correlationId !== evidence.correlationId
        || (current.providerTurnOrMessageId && evidence.providerTurnOrMessageId
          && current.providerTurnOrMessageId !== evidence.providerTurnOrMessageId)) {
        throw new DomainError('REVIEW_RECOVERY_IDENTITY_CONFLICT', 'Review evidence belongs to another native session or submission.', 409)
      }
      const result = await client.query<{ revision: string }>(
        `update review_jobs set recovery_evidence=recovery_evidence || jsonb_build_array($6::jsonb),
           revision=revision+1,updated_at=now()
         where id=$1 and revision=$2 and lease_owner=$3 and lease_token=$4 and lease_fence=$5
           and lease_expires_at > clock_timestamp() returning revision::text`,
        [id, expectedRevision, lease.owner, lease.token, lease.fence, JSON.stringify(evidence)],
      )
      if (!result.rows[0]) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'The review recovery revision or lease changed.', 409)
      return Number(result.rows[0].revision)
    })
  }
}
