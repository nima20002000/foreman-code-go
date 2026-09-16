import { randomUUID } from 'node:crypto'

import type { DurableInteraction } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { ManagementAction } from '@graphql/contracts/management'

import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { assertOrchestratorInteractionAuthority, type WorkerInteractionAuthority } from './authorization.js'
import type { PostgresApprovalBudgetRepository } from './budget.js'
import type { PostgresInteractionRepository } from './postgres.js'
import type { InteractionNativeRuntime } from './runtimePorts.js'
import { INTERACTION_DELIVERY_LEASE_MS, matchingDeliveryEvidence, type NativeDeliveryOutcome } from './delivery.js'

export type InteractionResponder =
  | { kind: 'user' }
  | { kind: 'operator'; principal: ManagementPrincipal }
  | { kind: 'orchestrator'; authority: WorkerInteractionAuthority }

function assertResponder(interaction: DurableInteraction, responder: InteractionResponder): void {
  if (responder.kind === 'user') {
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
    if (interaction.deliveryState !== 'delivered') return
    const claim = await this.interactions.delivery.claimGraphResume(interaction.id, randomUUID())
    if (!claim) return
    let resumeError: string | undefined
    let renewal: Promise<void> | undefined
    // Graph execution may outlive one lease. Never revive an expired/lost owner
    // and never acknowledge its callback on behalf of a replacement worker.
    const heartbeat = setInterval(() => {
      if (renewal || resumeError !== undefined) return
      renewal = this.interactions.delivery.renewGraphResume(claim)
        .catch((error: unknown) => { resumeError = message(error) })
        .finally(() => { renewal = undefined })
    }, INTERACTION_DELIVERY_LEASE_MS / 3)
    heartbeat.unref()
    try {
      await this.budgets.resume(claim.interaction.executionId)
      await this.resumeGraph(claim.interaction)
    } catch (error) {
      // RUN_NOT_RESUMABLE may mean binding/Run state has not caught up yet.
      // It is not an acknowledgement, and no graph error changes native truth.
      resumeError = message(error)
    } finally {
      clearInterval(heartbeat)
      await renewal
    }
    await this.interactions.delivery.finishGraphResume(claim, resumeError)
  }

  private async deliver(id: string, reconcileOnly = false): Promise<DurableInteraction> {
    const claim = await this.interactions.delivery.claim(id, randomUUID(), reconcileOnly)
    if (!claim) return this.get(id)
    const signal = AbortSignal.timeout(INTERACTION_DELIVERY_LEASE_MS)
    try {
      if (claim.mode === 'reconcile') {
        let outcome: NativeDeliveryOutcome = { state: 'uncertain' }
        try {
          const { manager, session } = await this.nativeRuntime.attachInteraction(claim.interaction, signal)
          const history = await manager.reconcile(session, claim.correlationId, signal)
          const evidence = manager.harness === claim.interaction.harness
            ? matchingDeliveryEvidence(claim.interaction, session, history) : undefined
          outcome = evidence ? { state: 'delivered', evidence }
            : { state: 'uncertain', error: 'No qualified receipt proves delivery of this exact native response.' }
        } catch (error) {
          outcome = { state: 'uncertain', error: message(error) }
        }
        return await this.interactions.delivery.finish(claim, outcome)
      }

      let attached
      try {
        attached = await this.nativeRuntime.attachInteraction(claim.interaction, signal)
        signal.throwIfAborted()
        if (attached.manager.harness !== claim.interaction.harness
          || attached.session.harness !== claim.interaction.harness
          || attached.session.providerVersion !== claim.interaction.providerVersion
          || attached.session.nativeSessionId !== claim.interaction.nativeSessionId) {
          throw new DomainError('INTERACTION_SESSION_MISMATCH', 'The attached session does not match the durable interaction.', 409)
        }
      } catch (error) {
        // No response was attempted. A later explicit retry can acquire a new fence.
        return await this.interactions.delivery.finish(claim, { state: 'failed', error: message(error) })
      }
      const { manager, session } = attached
      return await this.interactions.delivery.finish(claim, async (current, writeSignal) => {
        const option = current.responseOptions.find((candidate) => candidate.optionId === current.selectedOptionId)
        if (!option) throw new DomainError('INTERACTION_OPTION_INVALID', 'The durable response option is unavailable.', 409)
        // Only this try/catch classifies native errors. Database commit failures
        // and graph-resume failures must never turn a delivered response into a retry.
        try {
          writeSignal.throwIfAborted()
          await manager.respond(session, current.nativeRequestId, option, writeSignal)
          return { state: 'delivered' }
        } catch (error) {
          return { state: deliveryCertainty(error) === 'uncertain' ? 'uncertain' : 'failed', error: message(error) }
        }
      }, signal)
    } catch (error) {
      if (error instanceof DomainError && ['EXECUTION_STOPPED', 'DELIVERY_OWNER_LOST', 'DELIVERY_ATTEMPT_STALE'].includes(error.code)) {
        return this.get(id)
      }
      throw error
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

  async respond(responder: InteractionResponder, input: { interactionId: string; optionId: string; expectedRevision: number; commandId?: string }) {
    const current = await this.get(input.interactionId)
    assertResponder(current, responder)
    const option = current.responseOptions.find((candidate) => candidate.optionId === input.optionId)
    if (!option) throw new DomainError('INTERACTION_OPTION_INVALID', 'The response option is not valid for this interaction.', 409)
    if (current.selectedOptionId && current.selectedOptionId !== input.optionId) {
      throw new DomainError('INTERACTION_ALREADY_DECIDED', 'The interaction already has a different decision.', 409)
    }
    if (current.selectedOptionId === input.optionId && current.status !== 'canceled'
      && responder.kind === 'operator' && input.commandId) {
      // Even a harmless delivery replay must validate this command identity in
      // the authorized decision transaction before touching the graph handoff.
      await this.interactions.decide({ id: current.id, optionId: input.optionId, expectedRevision: input.expectedRevision,
        nativeResponse: current.nativeResponse, command: { principal: responder.principal, commandId: input.commandId } })
    }
    if (current.selectedOptionId === input.optionId && current.deliveryState === 'delivered') {
      // Authorization still applies, but completed replays do not consult the
      // active-time budget or reattach/mutate the provider.
      await this.resumeDelivered(current)
      return { interaction: await this.get(current.id), replayed: true }
    }
    if (['canceled', 'expired'].includes(current.status)) {
      throw new DomainError('INTERACTION_NOT_RESPONDABLE', 'This interaction no longer accepts responses.', 409)
    }
    if (current.selectedOptionId === input.optionId
      && (current.deliveryState === 'submitted' || current.deliveryState === 'uncertain')) {
      const reconciled = await this.reconcile(current)
      return { interaction: reconciled, replayed: true }
    }
    await this.budgets.assertActive(current.executionId)
    const nativeResponse = { optionId: option.optionId, semantic: option.semantic }
    const auditReference = responder.kind === 'operator' ? responder.principal.id
      : responder.kind === 'orchestrator' ? responder.authority.agentId : undefined
    const decision = await this.interactions.decide({
      id: current.id, optionId: option.optionId, expectedRevision: input.expectedRevision,
      nativeResponse, ...(auditReference ? { auditReference } : {}),
      ...(responder.kind === 'operator' && input.commandId ? {
        command: { principal: responder.principal, commandId: input.commandId },
      } : {}),
    })
    const interaction = await this.deliver(decision.interaction.id)
    await this.resumeDelivered(interaction)
    return { interaction: await this.get(interaction.id), replayed: decision.replayed }
  }

  async reconcile(interaction: DurableInteraction): Promise<DurableInteraction> {
    const current = await this.deliver(interaction.id, true)
    await this.resumeDelivered(current)
    return this.get(current.id)
  }

  /** Bounded, cursor-based recovery for the application lifecycle worker. No native replay. */
  async recover(input: { afterId?: string; limit: number }): Promise<{ nextCursor: string | null; errors: Array<{ interactionId: string; error: string }> }> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new DomainError('RECOVERY_LIMIT_INVALID', 'Recovery batch size must be between 1 and 100.', 400)
    }
    const rows = await this.interactions.delivery.recoveryCandidates({ ...input, limit: input.limit + 1 })
    const errors: Array<{ interactionId: string; error: string }> = []
    for (const candidate of rows.slice(0, input.limit)) {
      try {
        const current = candidate.deliveryState === 'delivered' ? candidate : await this.deliver(candidate.id)
        await this.resumeDelivered(current)
      } catch (error) {
        errors.push({ interactionId: candidate.id, error: message(error) })
      }
    }
    return { nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null, errors }
  }
}
