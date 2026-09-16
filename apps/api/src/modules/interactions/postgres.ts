import {
  AgentConfigurationVersionSchema,
  DurableInteractionSchema,
  HarnessExecutionSchema,
  InteractionRecoveryQuerySchema,
  WorkflowRunSchema,
  type DurableInteraction,
  type InteractionRecoveryQuery,
} from '@graphql/contracts'
import type pg from 'pg'

import { inTransaction } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'

/** Transactional durable interaction primitives; routing/dispatch intentionally lives elsewhere. */
export class PostgresInteractionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: DurableInteraction): Promise<{ interaction: DurableInteraction; created: boolean }> {
    const interaction = DurableInteractionSchema.parse(input)
    if (interaction.status !== 'pending' || interaction.revision !== 0) {
      throw new DomainError('INTERACTION_INITIAL_STATE_INVALID', 'New native requests must begin pending at revision zero.', 400)
    }
    return inTransaction(this.pool, undefined, async (client) => {
      const scope = await client.query<{ run: unknown; execution: unknown; configuration: unknown }>(
        `select r.record as run, e.record as execution, c.record as configuration
         from harness_executions e join runs r on r.id=e.run_id
         join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId'
         where e.id=$1 for share of r, e, c`, [interaction.executionId],
      )
      const row = scope.rows[0]
      if (!row) throw new DomainError('INTERACTION_SCOPE_INVALID', 'The accepted execution and Run are unavailable.', 409)
      const run = WorkflowRunSchema.parse(row.run)
      const execution = HarnessExecutionSchema.parse(row.execution)
      const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
      if (run.id !== interaction.runId || run.workspaceId !== interaction.workspaceId
        || run.workflowId !== interaction.workflowId || execution.runId !== run.id
        || execution.id !== interaction.executionId || execution.agentId !== interaction.requestingAgentId
        || configuration.agentId !== execution.agentId || configuration.workspaceId !== run.workspaceId
        || configuration.id !== execution.agentConfigurationVersionId
        || run.agentConfigurationVersionIds[execution.agentId] !== configuration.id
        || configuration.harness.harness !== interaction.harness
        || (execution.nativeSessionId !== undefined && execution.nativeSessionId !== interaction.nativeSessionId)) {
        throw new DomainError('INTERACTION_SCOPE_INVALID', 'The native request does not match its accepted execution and Run.', 409)
      }
      if (!run.approval || run.approval.handler !== interaction.approval.handler
        || run.approval.designatedOrchestratorAgentId !== interaction.approval.designatedOrchestratorAgentId) {
        throw new DomainError('INTERACTION_APPROVAL_CONFLICT', 'The interaction must use the Run\'s accepted approval snapshot.', 409)
      }
      const result = await client.query<{ record: unknown }>(
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
      const existing = await client.query<{ record: unknown }>(
        `select record from durable_interactions
         where harness=$1 and native_session_id=$2 and native_request_id=$3`,
        [interaction.harness, interaction.nativeSessionId, interaction.nativeRequestId],
      )
      const persisted = DurableInteractionSchema.parse(existing.rows[0]?.record)
      const bindings = ['workspaceId', 'workflowId', 'runId', 'executionId', 'requestingAgentId',
        'providerVersion', 'nativeRequestType', 'graphThreadId'] as const
      if (bindings.some((field) => persisted[field] !== interaction[field])) {
        throw new DomainError('INTERACTION_IDENTITY_CONFLICT', 'The native request identity is already bound to another immutable scope.', 409)
      }
      return { interaction: persisted, created: false }
    })
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

  /** Failed sends are conservative: reconcile them unless native non-delivery is confirmed. */
  async listRecoverableDeliveries(input: InteractionRecoveryQuery): Promise<DurableInteraction[]> {
    const query = InteractionRecoveryQuerySchema.parse(input)
    const result = await this.pool.query<{ record: unknown }>(
      `select record from durable_interactions where workspace_id=$1
         and ($2::text is null or workflow_id=$2) and ($3::text is null or run_id=$3)
         and ($4::text is null or id>$4)
         and (($5='send' and ((status='decided' and record->>'deliveryState'='not_started')
           or (status='delivery_pending' and record->>'deliveryState'='pending')))
           or ($5='reconcile' and ((status='delivery_pending' and record->>'deliveryState' in ('submitted','uncertain'))
             or (status='delivery_failed' and record->>'deliveryState'='failed'))))
       order by id limit $6`,
      [query.workspaceId, query.workflowId ?? null, query.runId ?? null, query.afterId ?? null, query.mode, query.limit],
    )
    return result.rows.map((row) => DurableInteractionSchema.parse(row.record))
  }

  async decide(input: { id: string; optionId: string; expectedRevision: number; nativeResponse: unknown; auditReference?: string }): Promise<{ interaction: DurableInteraction; replayed: boolean }> {
    // Validate before opening a transaction, including replay calls. Undefined is not JSON.
    const response = DurableInteractionSchema.shape.nativeResponse.unwrap().parse(input.nativeResponse)
    return inTransaction(this.pool, undefined, async (client) => {
      const found = await client.query<{ record: unknown }>('select record from durable_interactions where id=$1 for update', [input.id])
      const current = found.rows[0] ? DurableInteractionSchema.parse(found.rows[0].record) : undefined
      if (!current) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
      if (current.status !== 'pending') {
        if (current.status !== 'canceled' && current.selectedOptionId === input.optionId) return { interaction: current, replayed: true }
        throw new DomainError('INTERACTION_ALREADY_DECIDED', 'The interaction is canceled or already has a different decision.', 409)
      }
      if (current.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'The interaction changed since it was read.', 409, { currentRevision: current.revision })
      const option = current.responseOptions.find((candidate) => candidate.optionId === input.optionId)
      if (!option) throw new DomainError('INTERACTION_OPTION_INVALID', 'The response option is not valid for this interaction.', 409)
      const now = new Date().toISOString()
      const next = DurableInteractionSchema.parse({
        ...current, revision: current.revision + 1, status: 'delivery_pending',
        selectedOptionId: option.optionId, selectedSemantic: option.semantic,
        nativeResponse: response, deliveryState: 'pending',
        ...(input.auditReference ? { auditReference: input.auditReference } : {}),
        decidedAt: now, updatedAt: now,
      })
      const updated = await client.query(
        `update durable_interactions set status=$2, revision=$3, record=$4::jsonb, updated_at=now()
         where id=$1 and revision=$5 and status='pending'`, [next.id, next.status, next.revision, JSON.stringify(next), current.revision],
      )
      if (updated.rowCount !== 1) throw new DomainError('REVISION_CONFLICT', 'The interaction changed during the decision.', 409)
      return { interaction: next, replayed: false }
    })
  }

  private async changeDelivery(id: string, expectedRevision: number, transition: (current: DurableInteraction) => DurableInteraction): Promise<DurableInteraction> {
    return inTransaction(this.pool, undefined, async (client) => {
      const found = await client.query<{ record: unknown }>('select record from durable_interactions where id=$1 for update', [id])
      const current = found.rows[0] ? DurableInteractionSchema.parse(found.rows[0].record) : undefined
      if (!current) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
      if (current.revision !== expectedRevision) throw new DomainError('REVISION_CONFLICT', 'The interaction changed since it was read.', 409, { currentRevision: current.revision })
      const next = DurableInteractionSchema.parse(transition(current))
      const updated = await client.query(
        `update durable_interactions set status=$2, revision=$3, record=$4::jsonb, updated_at=now()
         where id=$1 and revision=$5 and status=$6 and record->>'deliveryState'=$7`,
        [id, next.status, next.revision, JSON.stringify(next), current.revision, current.status, current.deliveryState],
      )
      if (updated.rowCount !== 1) throw new DomainError('REVISION_CONFLICT', 'The interaction changed during delivery.', 409)
      return next
    })
  }

  /** Persist submitted BEFORE invoking the provider. A crash then requires reconciliation. */
  async updateDelivery(id: string, expectedRevision: number, state: 'submitted' | 'uncertain' | 'delivered' | 'failed'): Promise<DurableInteraction> {
    return this.changeDelivery(id, expectedRevision, (current) => {
      const transitions: Partial<Record<DurableInteraction['deliveryState'], readonly typeof state[]>> = {
        not_started: ['submitted', 'failed'], pending: ['submitted', 'failed'],
        submitted: ['uncertain', 'delivered', 'failed'], uncertain: ['delivered', 'failed'],
      }
      if (current.status === 'pending' || current.status === 'canceled' || current.status === 'delivered'
        || !transitions[current.deliveryState]?.includes(state)) {
        throw new DomainError('INTERACTION_DELIVERY_TRANSITION_INVALID', 'Delivery requires a decision and cannot reopen terminal work or blindly resend uncertain work.', 409)
      }
      const now = new Date().toISOString()
      const status = state === 'delivered' ? 'delivered' : state === 'failed' ? 'delivery_failed' : 'delivery_pending'
      return DurableInteractionSchema.parse({ ...current, revision: current.revision + 1, status, deliveryState: state,
        ...(state === 'delivered' ? { deliveredAt: now } : {}), updatedAt: now })
    })
  }

  /** not_delivered requires conclusive native evidence, never merely a timeout or missing response. */
  async reconcileDelivery(id: string, expectedRevision: number, result: 'delivered' | 'not_delivered' | 'unknown'): Promise<DurableInteraction> {
    return this.changeDelivery(id, expectedRevision, (current) => {
      if (!['submitted', 'uncertain', 'failed'].includes(current.deliveryState)
        || !['delivery_pending', 'delivery_failed'].includes(current.status)) {
        throw new DomainError('INTERACTION_RECONCILIATION_INVALID', 'Only unresolved delivery attempts may be reconciled.', 409)
      }
      const now = new Date().toISOString()
      return DurableInteractionSchema.parse({ ...current, revision: current.revision + 1,
        status: result === 'delivered' ? 'delivered' : 'delivery_pending',
        deliveryState: result === 'delivered' ? 'delivered' : result === 'not_delivered' ? 'pending' : 'uncertain',
        ...(result === 'delivered' ? { deliveredAt: now } : {}), updatedAt: now,
      })
    })
  }
}
