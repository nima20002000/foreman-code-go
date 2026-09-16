import {
  DurableInteractionSchema,
  type DurableInteraction,
} from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type pg from 'pg'

import { requireRespondableInteraction } from '../access/appPolicy.js'
import { lockActiveWorkerPrincipal, requireActiveWorkerBinding } from '../access/workerLifecycle.js'
import { DomainError } from '../errors.js'

type DecisionResult = { interaction: DurableInteraction; replayed: boolean }

/** Transactional durable interaction primitives; routing/dispatch intentionally lives elsewhere. */
export class PostgresInteractionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: DurableInteraction): Promise<{ interaction: DurableInteraction; created: boolean }> {
    const interaction = DurableInteractionSchema.parse(input)
    const result = await this.pool.query<{ record: unknown }>(
      `insert into durable_interactions
       (id, workspace_id, workflow_id, run_id, execution_id, requesting_agent_id, harness,
        native_session_id, native_request_id, status, revision, record)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       on conflict (harness, native_session_id, native_request_id) do nothing
       returning record`,
      [interaction.id, interaction.workspaceId, interaction.workflowId, interaction.runId,
        interaction.executionId, interaction.requestingAgentId, interaction.harness,
        interaction.nativeSessionId, interaction.nativeRequestId, interaction.status,
        interaction.revision, JSON.stringify(interaction)],
    )
    if (result.rows[0]) return { interaction: DurableInteractionSchema.parse(result.rows[0].record), created: true }
    const existing = await this.pool.query<{ record: unknown }>(
      `select record from durable_interactions
       where harness=$1 and native_session_id=$2 and native_request_id=$3`,
      [interaction.harness, interaction.nativeSessionId, interaction.nativeRequestId],
    )
    const persisted = DurableInteractionSchema.parse(existing.rows[0]?.record)
    if (persisted.executionId !== interaction.executionId || persisted.requestingAgentId !== interaction.requestingAgentId) {
      throw new DomainError('INTERACTION_IDENTITY_CONFLICT', 'The native request identity is already bound to another execution.', 409)
    }
    return { interaction: persisted, created: false }
  }

  async get(id: string): Promise<DurableInteraction | undefined> {
    const result = await this.pool.query<{ record: unknown }>('select record from durable_interactions where id=$1', [id])
    return result.rows[0] ? DurableInteractionSchema.parse(result.rows[0].record) : undefined
  }

  async listPending(input: { workspaceId?: string; workflowId?: string; afterId?: string; limit: number }): Promise<DurableInteraction[]> {
    const result = await this.pool.query<{ record: unknown }>(
      `select record from durable_interactions
       where status='pending' and ($1::text is null or workspace_id=$1)
         and ($2::text is null or workflow_id=$2) and ($3::text is null or id>$3)
       order by id limit $4`, [input.workspaceId ?? null, input.workflowId ?? null, input.afterId ?? null, input.limit],
    )
    return result.rows.map((row) => DurableInteractionSchema.parse(row.record))
  }

  async decide(input: {
    id: string; optionId: string; expectedRevision: number; nativeResponse: unknown; auditReference?: string
    principal?: ManagementPrincipal
    beforeCommit?(client: pg.PoolClient, result: DecisionResult): Promise<void>
  }): Promise<DecisionResult> {
    const client = await this.pool.connect()
    let committing = false
    let releaseError: Error | undefined
    try {
      await client.query('begin')
      let principal: ManagementPrincipal | undefined
      let targetRunId: string | undefined
      if (input.principal) {
        const target = await client.query<{ run_id: string }>('select run_id from durable_interactions where id=$1', [input.id])
        targetRunId = target.rows[0]?.run_id
        principal = await lockActiveWorkerPrincipal(client, input.principal, targetRunId)
        const activeRun = await client.query(
          `select 1 from runs where id=$1 and execution_state in ('running','waiting')
           and worker_credentials_closed_at is null and record->>'outcome'='pending'`, [targetRunId ?? null],
        )
        if (activeRun.rowCount !== 1) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
      }
      const found = await client.query<{ record: unknown }>('select record from durable_interactions where id=$1 for update', [input.id])
      const current = found.rows[0] ? DurableInteractionSchema.parse(found.rows[0].record) : undefined
      if (!current) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
      if (principal) {
        requireRespondableInteraction(principal, current)
        if (current.runId !== targetRunId) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
      }
      let result: DecisionResult
      if (current.status !== 'pending') {
        if (current.selectedOptionId !== input.optionId) throw new DomainError('INTERACTION_ALREADY_DECIDED', 'The interaction already has a different decision.', 409)
        result = { interaction: current, replayed: true }
      } else {
        if (current.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'The interaction changed since it was read.', 409, { currentRevision: current.revision })
        const option = current.responseOptions.find((candidate) => candidate.optionId === input.optionId)
        if (!option) throw new DomainError('INTERACTION_OPTION_INVALID', 'The response option is not valid for this interaction.', 409)
        const now = new Date().toISOString()
        const next = DurableInteractionSchema.parse({
          ...current, revision: current.revision + 1, status: 'delivery_pending',
          selectedOptionId: option.optionId, selectedSemantic: option.semantic,
          nativeResponse: principal ? { optionId: option.optionId, semantic: option.semantic } : input.nativeResponse,
          deliveryState: 'pending',
          ...(input.auditReference ? { auditReference: input.auditReference } : {}),
          decidedAt: now, updatedAt: now,
        })
        await client.query(
          `update durable_interactions set status=$2, revision=$3, record=$4::jsonb, updated_at=now()
           where id=$1 and revision=$5`, [next.id, next.status, next.revision, JSON.stringify(next), current.revision],
        )
        result = { interaction: next, replayed: false }
      }
      await input.beforeCommit?.(client, result)
      // Recheck wall-clock expiry after any audit/validation wait. Parent and
      // principal locks prevent Stop/revocation from overtaking this commit.
      if (principal) await requireActiveWorkerBinding(client, principal.id)
      committing = true
      await client.query('commit')
      return result
    } catch (error) {
      try { await client.query('rollback') } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error('Decision rollback failed.')
      }
      if (committing) {
        throw new DomainError('INTERACTION_DECISION_STATUS_UNKNOWN', 'Decision commit could not be confirmed. Read the interaction before retrying; the decision may already have committed.', 503)
      }
      throw error
    } finally { client.release(releaseError) }
  }

  async updateDelivery(id: string, expectedRevision: number, state: 'submitted' | 'uncertain' | 'delivered' | 'failed'): Promise<DurableInteraction> {
    const current = await this.get(id)
    if (!current) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
    if (current.revision !== expectedRevision) throw new DomainError('REVISION_CONFLICT', 'The interaction changed since it was read.', 409, { currentRevision: current.revision })
    const now = new Date().toISOString()
    const status = state === 'delivered' ? 'delivered' : state === 'failed' ? 'delivery_failed' : 'delivery_pending'
    const next = DurableInteractionSchema.parse({ ...current, revision: current.revision + 1, status, deliveryState: state,
      ...(state === 'delivered' ? { deliveredAt: now } : {}), updatedAt: now })
    const result = await this.pool.query(
      `update durable_interactions set status=$2, revision=$3, record=$4::jsonb, updated_at=now()
       where id=$1 and revision=$5`, [id, next.status, next.revision, JSON.stringify(next), expectedRevision],
    )
    if (result.rowCount !== 1) throw new DomainError('REVISION_CONFLICT', 'The interaction changed during delivery.', 409)
    return next
  }
}
