import type { DurableInteraction } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { NativeResponseJournal } from '../harnesses/recovery/responseJournal.js'
import { hasAction, requireAuthorization } from '../access/policy.js'
import { projectInteractionActivity, type InteractionActivityEvidence } from './activityProjection.js'
import { DomainError } from '../errors.js'
import type { WorkerInteractionAuthority } from './authorization.js'
import type { PostgresApprovalBudgetRepository } from './budget.js'
import type { InteractionNativeRuntime } from './runtimePorts.js'
import { Wave25InteractionRepository } from './wave25/repository.js'
import { deliverApproval, respondToApproval, resumeApproval,
  type ApprovalRuntimeDependencies, type AtomicApprovalResumeConsumer } from './wave25/service.js'

export type InteractionResponder =
  | { kind: 'user'; principal?: ManagementPrincipal }
  | { kind: 'orchestrator'; authority: WorkerInteractionAuthority; principal?: ManagementPrincipal;
      /** Rejected explicitly; audit belongs to the shared G1 decision writer. */
      beforeCommit?: unknown }
const message = (error: unknown) => error instanceof DomainError ? error.code : 'APPROVAL_RECOVERY_UNCERTAIN'

/** One current authenticated decision/delivery/resume service. Transport source
 * and graph complexity never select another repository or approval protocol. */
export class InteractionService {
  private atomicApprovalResume: AtomicApprovalResumeConsumer | undefined
  useAtomicApprovalResume(consumer: AtomicApprovalResumeConsumer): void {
    if (this.atomicApprovalResume && this.atomicApprovalResume !== consumer) throw new DomainError(
      'APPROVAL_RESUME_ALREADY_BOUND', 'The production checkpoint consumer is already bound.', 409)
    this.atomicApprovalResume = consumer
  }
  usesAtomicApproval(runId: string): Promise<boolean> { return this.interactions.usesAtomicApproval(runId) }
  private approvalDependencies(): ApprovalRuntimeDependencies {
    return { repository: this.interactions, nativeRuntime: this.nativeRuntime,
      ...(this.responseJournal ? { journal: this.responseJournal } : {}),
      ...(this.atomicApprovalResume ? { atomicResume: this.atomicApprovalResume } : {}) }
  }
  constructor(private readonly interactions: Wave25InteractionRepository,
    _budgets: PostgresApprovalBudgetRepository, private readonly nativeRuntime: InteractionNativeRuntime,
    _resumeGraph: (interaction: DurableInteraction) => Promise<void>, private readonly responseJournal?: NativeResponseJournal,
    private readonly activityEvidence?: (interaction: DurableInteraction) => Promise<InteractionActivityEvidence>) {
    if (!(interactions instanceof Wave25InteractionRepository)) throw new DomainError(
      'APPROVAL_REPOSITORY_REQUIRED', 'The current original-source approval repository is required.', 503)
  }
  private resumeDelivered(interaction: DurableInteraction): Promise<void> {
    return resumeApproval(this.approvalDependencies(), interaction)
  }
  private deliver(id: string, reconcileOnly = false): Promise<DurableInteraction> {
    return deliverApproval(this.approvalDependencies(), id, reconcileOnly)
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

  async reviewStatusVisible(principal: ManagementPrincipal, id: string) {
    const interaction = await this.getVisible(principal, id)
    const activity = await this.readActivity(interaction, false)
    const reviewerId = interaction.approval.designatedOrchestratorAgentId
    if (interaction.approval.handler !== 'orchestrator' || !reviewerId) return { interaction, activity }
    const job = await this.interactions.coordination.findReviewJob(id, reviewerId)
    if (!job) return { interaction, activity }
    const { state, attempt, error, retryAfter, updatedAt } = job
    return { interaction, activity, review: { state, attempt, updatedAt, reviewJobId: job.id,
      cleanupPending: state === 'failed' && !job.cleanup?.completedAt,
      ...(error ? { error } : {}), ...(retryAfter ? { retryAfter } : {}) } }
  }

  /** Read-only availability. Caller supplies the result of its existing responder-role policy. */
  async readActivity(interaction: DurableInteraction, authorized: boolean) {
    const qualified = this.activityEvidence ? await this.activityEvidence(interaction) : {
      response: { qualified: false, usable: false, path: null, authorized: false },
    } satisfies InteractionActivityEvidence
    return projectInteractionActivity(interaction, { ...qualified, response: { ...qualified.response, authorized } })
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

  respond(responder: InteractionResponder, input: { interactionId: string; optionId: string; expectedRevision: number; commandId?: string }) {
    return respondToApproval(this.approvalDependencies(), responder, input)
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
