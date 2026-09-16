import {
  DurableInteractionSchema,
  type DurableInteraction,
} from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'

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

  async decide(input: { id: string; optionId: string; expectedRevision: number; nativeResponse: unknown; auditReference?: string }): Promise<{ interaction: DurableInteraction; replayed: boolean }> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const found = await client.query<{ record: unknown }>('select record from durable_interactions where id=$1 for update', [input.id])
      const current = found.rows[0] ? DurableInteractionSchema.parse(found.rows[0].record) : undefined
      if (!current) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
      if (current.status !== 'pending') {
        if (current.selectedOptionId === input.optionId) { await client.query('commit'); return { interaction: current, replayed: true } }
        throw new DomainError('INTERACTION_ALREADY_DECIDED', 'The interaction already has a different decision.', 409)
      }
      if (current.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'The interaction changed since it was read.', 409, { currentRevision: current.revision })
      const option = current.responseOptions.find((candidate) => candidate.optionId === input.optionId)
      if (!option) throw new DomainError('INTERACTION_OPTION_INVALID', 'The response option is not valid for this interaction.', 409)
      const now = new Date().toISOString()
      const next = DurableInteractionSchema.parse({
        ...current, revision: current.revision + 1, status: 'delivery_pending',
        selectedOptionId: option.optionId, selectedSemantic: option.semantic,
        nativeResponse: input.nativeResponse, deliveryState: 'pending',
        ...(input.auditReference ? { auditReference: input.auditReference } : {}),
        decidedAt: now, updatedAt: now,
      })
      await client.query(
        `update durable_interactions set status=$2, revision=$3, record=$4::jsonb, updated_at=now()
         where id=$1 and revision=$5`, [next.id, next.status, next.revision, JSON.stringify(next), current.revision],
      )
      await client.query('commit')
      return { interaction: next, replayed: false }
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
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
