import { randomUUID } from 'node:crypto'

import type { DurableInteraction } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { ManagementAction } from '@graphql/contracts/management'

import { hasAction, requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { assertOrchestratorInteractionAuthority, type WorkerInteractionAuthority } from './authorization.js'
import { PostgresApprovalBudgetRepository } from './budget.js'
import { PostgresInteractionRepository } from './postgres.js'
import type { InteractionNativeRuntime } from './runtimePorts.js'

export type InteractionResponder =
  | { kind: 'user'; principal?: ManagementPrincipal }
  | { kind: 'operator'; principal: ManagementPrincipal }
  | { kind: 'orchestrator'; authority: WorkerInteractionAuthority }

function assertResponder(interaction: DurableInteraction, responder: InteractionResponder): void {
  if (responder.kind === 'user') {
    if (responder.principal) requireAuthorization(responder.principal, 'interactions:respond', {
      workspaceId: interaction.workspaceId, workflowId: interaction.workflowId, runId: interaction.runId,
    })
    if (interaction.approval.handler !== 'user') {
      throw new DomainError('INTERACTION_ACCESS_DENIED', 'The caller is not authorized for this interaction.', 403)
    }
    return
  }
  if (responder.kind === 'orchestrator') {
    assertOrchestratorInteractionAuthority(interaction, responder.authority)
    return
  }
  if (interaction.approval.handler !== 'operator') {
    throw new DomainError('INTERACTION_ACCESS_DENIED', 'The interaction is assigned to a different handler.', 403)
  }
  requireAuthorization(responder.principal, 'interactions:respond' as ManagementAction, {
    workspaceId: interaction.workspaceId, workflowId: interaction.workflowId, runId: interaction.runId,
  })
}

function deliveryCertainty(error: unknown): 'definite' | 'uncertain' {
  if (error && typeof error === 'object' && 'certainty' in error
    && (error.certainty === 'definite' || error.certainty === 'uncertain')) return error.certainty
  if (error && typeof error === 'object' && 'result' in error) {
    const code = (error as { result?: { error?: { code?: string } } }).result?.error?.code
    if (code === 'NATIVE_RESPONSE_DELIVERY_UNCERTAIN') return 'uncertain'
    if (code === 'NATIVE_RESPONSE_UNKNOWN_REQUEST' || code === 'NATIVE_RESPONSE_OPTION_INVALID') return 'definite'
  }
  return 'uncertain'
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown native delivery failure.'
}

/** One authoritative decide -> native delivery -> reconciliation boundary for all handlers. */
export class InteractionService {
  constructor(
    private readonly interactions: PostgresInteractionRepository,
    private readonly budgets: PostgresApprovalBudgetRepository,
    private readonly nativeRuntime: InteractionNativeRuntime,
    private readonly resumeGraph: (interaction: DurableInteraction) => Promise<void>,
  ) {}

  private async resumeDelivered(interaction: DurableInteraction): Promise<void> {
    await this.budgets.resume(interaction.executionId)
    try {
      await this.resumeGraph(interaction)
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'RUN_NOT_RESUMABLE')) throw error
    }
  }

  async get(id: string): Promise<DurableInteraction> {
    const interaction = await this.interactions.get(id)
    if (!interaction) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
    return interaction
  }

  async list(input: { workspaceId?: string; workflowId?: string; runId?: string; handler?: DurableInteraction['approval']['handler']; status?: DurableInteraction['status']; cursor?: string; limit: number }): Promise<{ items: DurableInteraction[]; nextCursor: string | null }> {
    const rows = await this.interactions.list({
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.handler ? { handler: input.handler } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.cursor ? { afterId: input.cursor } : {}), limit: input.limit + 1,
    })
    const items = rows.slice(0, input.limit)
    return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.id : null }
  }

  async getVisible(principal: ManagementPrincipal, id: string): Promise<DurableInteraction> {
    const interaction = await this.get(id)
    requireAuthorization(principal, 'interactions:read', {
      workspaceId: interaction.workspaceId, workflowId: interaction.workflowId, runId: interaction.runId,
    })
    return interaction
  }

  async listVisible(principal: ManagementPrincipal, input: {
    workspaceId?: string | undefined; workflowId?: string | undefined; runId?: string | undefined;
    handler?: DurableInteraction['approval']['handler'] | undefined;
    status?: DurableInteraction['status'] | undefined; cursor?: string | undefined; limit: number;
  }) {
    if (!hasAction(principal, 'interactions:read')) {
      throw new DomainError('ACCESS_DENIED', 'The caller is not authorized to read interactions.', 403)
    }
    const scopes = principal.grants.filter((grant) => grant.actions.includes('interactions:read')).map((grant) => grant.scope)
    const filters = { workspaceId: input.workspaceId, workflowId: input.workflowId, runId: input.runId, handler: input.handler, scopes }
    const rows = await this.interactions.list({ ...filters, status: input.status, afterId: input.cursor, limit: input.limit + 1 })
    const items = rows.slice(0, input.limit)
    const counts = await this.interactions.pendingCounts(filters)
    return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.id : null, ...counts }
  }

  async respond(responder: InteractionResponder, input: { interactionId: string; optionId: string; expectedRevision: number }) {
    const current = await this.get(input.interactionId)
    assertResponder(current, responder)
    if (current.status === 'canceled') throw new DomainError('INTERACTION_CANCELED', 'This interaction was canceled and cannot be retried.', 409)
    await this.budgets.assertActive(current.executionId)
    const option = current.responseOptions.find((candidate) => candidate.optionId === input.optionId)
    if (!option) throw new DomainError('INTERACTION_OPTION_INVALID', 'The response option is not valid for this interaction.', 409)

    if (current.selectedOptionId === input.optionId
      && (current.deliveryState === 'submitted' || current.deliveryState === 'uncertain')) {
      const reconciled = await this.reconcile(current)
      if (reconciled.deliveryState === 'delivered') await this.resumeDelivered(reconciled)
      return { interaction: reconciled, replayed: true }
    }
    const nativeResponse = { optionId: option.optionId, semantic: option.semantic }
    const auditReference = responder.kind === 'operator' ? responder.principal.id
      : responder.kind === 'orchestrator' ? responder.authority.agentId : undefined
    const decision = await this.interactions.decide({
      id: current.id, optionId: option.optionId, expectedRevision: input.expectedRevision,
      nativeResponse, ...(auditReference ? { auditReference } : {}),
    })
    if (decision.interaction.deliveryState === 'delivered') return decision

    let attached
    try {
      attached = await this.nativeRuntime.attachInteraction(decision.interaction)
    } catch {
      return {
        interaction: await this.interactions.updateDelivery(
          decision.interaction.id, decision.interaction.revision, 'failed',
        ),
        replayed: decision.replayed,
      }
    }

    const submitted = await this.interactions.updateDelivery(
      decision.interaction.id, decision.interaction.revision, 'submitted',
    )
    const correlationId = `approval-${randomUUID()}`
    const attempt = await this.interactions.beginDeliveryAttempt(submitted, correlationId)
    const { manager, session } = attached
    try {
      await manager.respond(session, submitted.nativeRequestId, option)
      await this.interactions.finishDeliveryAttempt(submitted.id, attempt, 'delivered')
      const delivered = await this.interactions.updateDelivery(submitted.id, submitted.revision, 'delivered')
      await this.resumeDelivered(delivered)
      return { interaction: delivered, replayed: decision.replayed }
    } catch (error) {
      const certainty = deliveryCertainty(error)
      const state = certainty === 'uncertain' ? 'uncertain' : 'failed'
      await this.interactions.finishDeliveryAttempt(submitted.id, attempt, state, message(error))
      const failed = await this.interactions.updateDelivery(submitted.id, submitted.revision, state)
      return { interaction: failed, replayed: decision.replayed }
    }
  }

  async reconcile(interaction: DurableInteraction): Promise<DurableInteraction> {
    try {
      const { manager, session } = await this.nativeRuntime.attachInteraction(interaction)
      const history = await manager.reconcile(session, `approval:${interaction.id}`)
      const stillPending = history.pendingInteractions.some((item) => item.turn.nativeRequestId === interaction.nativeRequestId)
      return this.interactions.updateDelivery(interaction.id, interaction.revision, stillPending ? 'failed' : 'delivered')
    } catch {
      if (interaction.deliveryState === 'uncertain') return interaction
      return this.interactions.updateDelivery(interaction.id, interaction.revision, 'uncertain')
    }
  }
}
