import { randomUUID } from 'node:crypto'
import { DurableInteractionSchema, type DurableInteraction } from '@graphql/contracts'
import type pg from 'pg'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresAccessService } from '../access/postgres.js'
import type { OperatorChatService } from '../conversations/operatorChat.js'
import type { NativeRollout } from '../harnesses/nativeRollout.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import { PostgresInteractionCoordinationRepository } from './coordination.js'
import { ReviewerDispatcher } from './reviewer.js'
import type { InteractionNativeRuntime } from './runtimePorts.js'

/** Drives durable, explicitly assigned reviewers; never fabricates a board Agent or grants. */
export class AutomaticReviewService {
  private readonly coordination: PostgresInteractionCoordinationRepository
  private readonly dispatcher: ReviewerDispatcher
  private readonly workerId = `reviewer-${randomUUID()}`
  private readonly tasks = new Map<string, Promise<unknown>>()
  private readonly lastErrors = new Map<string, string>()
  private polling: Promise<void> | undefined
  private closing = false
  constructor(private readonly pool: pg.Pool, private readonly runs: PostgresRunRepository,
    native: InteractionNativeRuntime, private readonly chat: OperatorChatService, private readonly access: PostgresAccessService,
    private readonly locations: WorkspaceLocationService, private readonly rollout: NativeRollout) {
    this.coordination = new PostgresInteractionCoordinationRepository(pool)
    this.dispatcher = new ReviewerDispatcher(this.coordination, native)
  }
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve()
    if (this.polling) return this.polling
    this.polling = this.poll().finally(() => { this.polling = undefined })
    return this.polling
  }
  private async poll() {
    await this.dispatcher.reconcile()
    let after = ''
    while (!this.closing) {
      const result = await this.pool.query<{ id: string; record: unknown }>(`select id,record from durable_interactions
        where id>$1 and status='pending' and record->'approval'->>'handler' in ('orchestrator','operator')
        order by id limit 50`, [after])
      if (!result.rows.length) break
      for (const row of result.rows) {
        after = row.id
        if (this.closing) break
        const interaction = DurableInteractionSchema.parse(row.record)
        if (!interaction.graphInterruptId || this.tasks.has(interaction.id)) continue
        const task = this.schedule(interaction).catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : 'Automatic reviewer setup failed.'
          if (this.lastErrors.get(interaction.id) === message) return
          this.lastErrors.set(interaction.id, message)
          await this.runs.recordActivity(interaction.runId, 'backend', 'review_job_state', {
            interactionId: interaction.id, state: 'blocked', message,
          }, interaction.executionId)
        }).finally(() => this.tasks.delete(interaction.id))
        this.tasks.set(interaction.id, task)
        void task.catch(() => undefined)
      }
    }
  }
  private async schedule(interaction: DurableInteraction): Promise<void> {
    const run = await this.runs.get(interaction.runId)
    if (!run || run.executionState !== 'waiting' || !run.authorizationPrincipalId) return
    await this.locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId)
    if (this.closing) return
    if (interaction.approval.handler === 'operator') {
      const principal = await this.access.currentOperator(run.authorizationPrincipalId)
      requireAuthorization(principal, 'interactions:respond', { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id })
      await this.chat.reviewInteraction(interaction.id, principal)
      return
    }
    const reviewerId = interaction.approval.designatedOrchestratorAgentId
    if (!reviewerId || reviewerId === interaction.requestingAgentId) throw new Error('Automatic review requires a different designated Orchestrator.')
    const versionId = run.agentConfigurationVersionIds[reviewerId]
    const execution = (await this.runs.listExecutions(run.id)).filter((item) => item.agentId === reviewerId
      && item.agentConfigurationVersionId === versionId && item.state === 'completed' && item.nativeSessionId && item.workingDirectory).at(-1)
    if (!execution?.nativeSessionId || !execution.workingDirectory) throw new Error('The designated Orchestrator needs an existing completed native session in this Run. No replacement reviewer was created.')
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
    if (!configuration || !this.rollout.enabled(configuration.harness.harness)) throw new Error('The designated reviewer has not passed its native rollout gate.')
    const providerVersion = configuration.harness.harness === 'codex' ? 'codex-cli 0.154.0' : '1.18.31'
    const session = { harness: configuration.harness.harness, providerVersion, nativeSessionId: execution.nativeSessionId }
    await this.coordination.ensureLane({ id: `review-lane:${session.harness}:${session.nativeSessionId}`,
      harness: session.harness, nativeSessionId: session.nativeSessionId, ownerAgentId: reviewerId,
      revision: 0, observedStatus: 'idle', connectionGeneration: 0, observedAt: new Date().toISOString() })
    await this.dispatcher.enqueue(interaction, reviewerId, session, { executionId: execution.id, workingDirectory: execution.workingDirectory })
    if (this.closing) return
    const job = await this.dispatcher.dispatchNext(reviewerId, this.workerId)
    if (job) await this.runs.recordActivity(interaction.runId, 'backend', 'review_job_state', {
      interactionId: job.interactionId, reviewJobId: job.id, state: job.state,
      ...(job.error ? { error: job.error } : {}),
    }, interaction.executionId)
  }
  async shutdown(): Promise<void> {
    this.closing = true
    const stopping = this.dispatcher.shutdown()
    await Promise.allSettled([stopping, ...(this.polling ? [this.polling] : []), ...this.tasks.values()])
  }
}
