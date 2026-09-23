import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  DurableInteractionSchema,
  HarnessExecutionSchema,
  type DurableInteraction,
  type ExecutionResult,
  type HarnessExecution,
  type HarnessExecutionRequest,
  type WorkflowApprovalConfiguration,
  type AgentConfigurationVersion,
  type NativeSessionReference,
  type NativeHarnessEvent,
  type PendingNativeInteraction,
  type ReviewJob,
  HarnessExecutionRequestSchema,
} from '@graphql/contracts'

import { WORKER_CREDENTIAL_RENEWAL_WINDOW_MS, type IssuedWorkerCredential } from '../access/workerCredentials.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../harnesses/port.js'
import { DomainError } from '../errors.js'
import { ReviewerDispatcher } from './reviewer.js'
import { nativePersistenceRedactor } from './nativePersistence.js'
import { nativeApprovalContext } from './nativeApprovalContext.js'
import type { ReviewCleanupSession, ReviewCredentialMaintenance } from './reviewerRuntime.js'
import { coordinateSessionManager, isLeaseLost, type SingleWriterSessionManager } from './sessionWriter.js'
import { HarnessExecutionError } from '../harnesses/errors.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import { redactKnownSecrets, redactSecretText } from '../harnesses/secrets.js'
import { attemptCleanup } from './cleanup.js'
import { buildHarnessPrompt } from '../harnesses/prompt.js'
import { maintainCredential } from '../harnesses/credentialHeartbeat.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { RunOwnership } from '../runs/ownership.js'
import type { WorkflowNativeLease } from '../runs/workflowNativeGraph.js'
import { normalizeNativeProducerEvent } from '../run-graph/nativeProducerNormalization.js'
import type { PostgresApprovalBudgetRepository } from './budget.js'
import type { PostgresInteractionRepository } from './postgres.js'
import type {
  AttachedInteractionSession,
  NativeManagerResolutionContext,
  NativeManagerOwnershipContext,
  NativeSessionManagerResolver,
  ResolvedNativeSessionManager,
} from './runtimePorts.js'
import type { ExecutionCredentialProvider } from '../harnesses/mcpDetection.js'

export type ApprovalExecutionObservation =
  | { state: 'waiting'; execution: HarnessExecution; interaction: DurableInteraction; interactions: DurableInteraction[] }
  | { state: 'completed'; execution: HarnessExecution; result: ExecutionResult }

interface OwnedNativeSession {
  execution: HarnessExecution
  context: NativeManagerResolutionContext
  manager: SingleWriterSessionManager
  controller: AbortController
  generation: number
  failed?: boolean
  session?: NativeSessionReference
  opening?: Promise<NativeSessionReference>
  openingFailed?: boolean
  cleanup?: Promise<Error[]>
}

/** Idempotent ensure/observe boundary called first on every LangGraph node entry. */
export class ApprovalExecutionCoordinator {
  private readonly managerCredentials = new WeakMap<NativeHarnessSessionManager, IssuedWorkerCredential>()

  readonly reviewers: ReviewerDispatcher
  private readonly writers = new WeakMap<NativeHarnessSessionManager, SingleWriterSessionManager>()
  private readonly rawManagers = new WeakMap<NativeHarnessSessionManager, NativeHarnessSessionManager>()
  // A waiting graph has no active task, but still owns its native process.
  private readonly ownedSessions = new Map<string, OwnedNativeSession>()
  private readonly closedExecutions = new Set<string>()
  private readonly stoppingRuns = new Set<string>()
  private readonly pendingCleanupRuns = new Set<string>()
  private readonly cancellations = new Map<string, Promise<void>>()

  residentRunIds(): string[] {
    return [...new Set([...this.pendingCleanupRuns, ...[...this.ownedSessions.values()].map((owned) => owned.execution.runId)])]
  }

  private ownSession(execution: HarnessExecution, context: NativeManagerResolutionContext, manager: SingleWriterSessionManager): OwnedNativeSession {
    if (this.stoppingRuns.has(execution.runId)) throw new Error('The Run is stopping; native work cannot be restarted.')
    let owned = this.ownedSessions.get(execution.id)
    if (!owned) {
      this.closedExecutions.delete(execution.id)
      owned = { execution, context, manager, controller: new AbortController(), generation: 0 }
      this.ownedSessions.set(execution.id, owned)
    }
    return owned
  }

  private openingSession(owned: OwnedNativeSession, operation: Promise<NativeSessionReference>): Promise<NativeSessionReference> {
    const opening = operation.then(
      (session) => {
        owned.session = session
        owned.generation += 1
        // A late create/attach completion invalidates earlier closure evidence.
        this.closedExecutions.delete(owned.execution.id)
        delete owned.openingFailed
        return session
      },
      (error: unknown) => { owned.openingFailed = true; throw error },
    ).finally(() => { if (owned.opening === opening) delete owned.opening })
    owned.opening = opening
    return opening
  }

  private cleanupSession(owned: OwnedNativeSession, cancel = true): Promise<Error[]> {
    if (cancel) owned.controller.abort()
    if (owned.cleanup) return owned.cleanup
    const safe = nativePersistenceRedactor(Object.values(this.managerCredentials.get(owned.manager)?.environment.variables ?? {}))
    const task = (async () => {
      const failures: Error[] = []
      const attempt = <T>(label: string, operation: (signal: AbortSignal) => Promise<T>) =>
        attemptCleanup(failures, `${owned.execution.id}: ${label}`, operation)
      // Create/attach can be in flight when Stop arrives. Never invent an identity
      // or replay a turn to obtain a session that can be canceled.
      if (owned.opening) await attempt('await native session', async () => { await owned.opening })
      if (!owned.session && owned.execution.nativeSessionId) {
        const interaction = await attempt('read native identity', () => this.interactions.getForExecution(owned.execution.id))
        const providerVersion = interaction?.nativeSessionId === owned.execution.nativeSessionId
          && interaction.harness === owned.context.harness ? interaction.providerVersion
          : (await attempt('read capabilities', (signal) => owned.manager.capabilities(signal)))?.providerVersion
        if (providerVersion) owned.session = {
          harness: owned.context.harness, providerVersion, nativeSessionId: owned.execution.nativeSessionId,
        }
      }
      let closed = this.closedExecutions.has(owned.execution.id)
        || (!owned.session && !owned.opening && !owned.openingFailed && !owned.execution.nativeSessionId)
      if (owned.session && !closed) {
        const session = owned.session
        if (cancel) await attempt('cancel native session', (signal) => owned.manager.cancel(session, signal))
        const generation = owned.generation
        closed = await attempt('close native session', async () => {
          await owned.manager.close(session)
          // A close of an older connection cannot confirm a late attach is closed.
          if (owned.generation !== generation) return false
          // Remember a late successful close even when the cleanup deadline won.
          this.closedExecutions.add(owned.execution.id)
          return true
        }) === true
      }
      if (!closed && this.recoverNativeProcesses) {
        closed = await attempt('recover registered native process groups',
          (signal) => this.recoverNativeProcesses!(owned.execution.id, signal)) === true
      }
      if (closed) this.closedExecutions.add(owned.execution.id)
      const revoked = await attempt('revoke execution credential', async () => {
        await this.credentials?.revokeForExecution(owned.execution.id)
        return true
      })
      if (closed && revoked && !owned.opening) {
        const released = await attempt('release native manager', async () => { this.managerCredentials.delete(owned.manager); this.managers.release?.(owned.context, this.rawManagers.get(owned.manager) ?? owned.manager, owned.failed ? 'failed' : 'released'); return true })
        if (released && this.ownedSessions.get(owned.execution.id) === owned) this.ownedSessions.delete(owned.execution.id)
      }
      if ((!closed || owned.opening) && !failures.length) failures.push(new Error(`${owned.execution.id}: native session closure is unconfirmed.`))
      return failures.map((error) => safe.error(error) as Error)
    })().finally(() => { delete owned.cleanup })
    owned.cleanup = task
    return task
  }
  constructor(
    private readonly runs: PostgresRunRepository,
    private readonly interactions: PostgresInteractionRepository,
    private readonly budgets: PostgresApprovalBudgetRepository,
    private readonly managers: NativeSessionManagerResolver,
    private readonly activeTimeoutMs: number,
    private readonly credentials?: ExecutionCredentialProvider,
    private readonly validateContinuation?: (executionId: string, signal?: AbortSignal) => Promise<void>,
    private readonly recoverNativeProcesses?: (executionId: string, signal: AbortSignal) => Promise<boolean>,
  ) {
    this.reviewers = new ReviewerDispatcher(interactions.coordination, this)
  }

  /** Bind only an existing execution of the designated reviewer in this Run. Never spawn a substitute. */
  async enqueueReview(interaction: DurableInteraction): Promise<void> {
    if (interaction.status !== 'pending' || interaction.approval.handler !== 'orchestrator') return
    const agentId = interaction.approval.designatedOrchestratorAgentId
    if (!agentId || agentId === interaction.requestingAgentId) return
    const connection = await this.interactions.assertOrchestratorConnection(interaction)
    if (await this.interactions.coordination.findReviewJob(interaction.id, agentId)) return
    const candidates = (await this.runs.listExecutions(interaction.runId))
      .filter((execution) => execution.agentId === agentId && execution.workflowNodeId === connection?.orchestratorNodeId
        && execution.nativeSessionId && execution.workingDirectory && execution.runtimeDirectory)
    // No guessing between attempts/sessions. The pending interaction remains the recovery source.
    if (candidates.length !== 1) return
    const execution = candidates[0]!
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
    if (!configuration || configuration.productRole !== 'orchestrator') return
    const native = await this.interactions.coordination.workflowSession(execution.id)
    if (!native?.finalized || execution.state !== 'completed') return
    await this.reviewers.enqueue(interaction, agentId, {
      ...native.session,
    }, { executionId: execution.id, workingDirectory: execution.workingDirectory! })
  }

  /** Pending interactions repair a crash between creation and enqueue, including sessions bound later. */
  async reconcileReviews(onError: (error: unknown) => void): Promise<void> {
    let afterId: string | undefined
    do {
      const page = await this.interactions.list({ handler: 'orchestrator', status: 'pending', limit: 100,
        ...(afterId ? { afterId } : {}) })
      for (const interaction of page) await this.enqueueReview(interaction).catch(onError)
      afterId = page.length === 100 ? page.at(-1)!.id : undefined
    } while (afterId)
    await this.reviewers.reconcile(onError)
  }

  private managerContext(
    execution: HarnessExecution,
    configuration: AgentConfigurationVersion,
  ): NativeManagerResolutionContext {
    if (!execution.workingDirectory) throw new Error('The durable execution has no accepted working directory.')
    if (configuration.id !== execution.agentConfigurationVersionId || configuration.agentId !== execution.agentId) {
      throw new Error('The pinned Agent configuration does not match its durable execution.')
    }
    return {
      harness: configuration.harness.harness, executionId: execution.id, agentId: execution.agentId,
      workingDirectory: execution.workingDirectory, configuration,
    }
  }

  private resolveManager(context: NativeManagerResolutionContext) {
    const resolved = this.managers.resolve(context)
    if (resolved.manager.harness !== context.harness) {
      throw new Error('The resolved native manager does not match the durable execution harness.')
    }
    let manager = this.writers.get(resolved.manager)
    if (!manager) {
      manager = coordinateSessionManager(resolved.manager, this.interactions.coordination, context.agentId)
      this.writers.set(resolved.manager, manager)
      this.rawManagers.set(manager, resolved.manager)
    }
    return {
      ...resolved, manager,
      get processState() { return resolved.processState },
    }
  }

  private async prepareEnvironment(
    context: NativeManagerResolutionContext,
    resolved: ResolvedNativeSessionManager,
    signal?: AbortSignal,
    purpose?: 'reviewer',
  ) {
    if (!this.credentials) return undefined
    if (resolved.processState === 'resident') {
      const credential = this.managerCredentials.get(resolved.manager)
      if (!credential) throw new Error('The resident native process has no owned worker credential lease.')
      const expiresAt = Date.parse(credential.expiresAt)
      if (!Number.isFinite(expiresAt)) throw new Error('The worker credential expiry is invalid.')
      if (expiresAt <= Date.now() && (purpose === 'reviewer' || !this.credentials.renew)) {
        throw new Error('The resident worker credential cannot be renewed without replacing its process.')
      }
      if (this.credentials.renew && expiresAt <= Date.now() + WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
        const renewedExpiry = await this.credentials.renew(context.executionId, { principalId: credential.principalId })
        if (!Number.isFinite(Date.parse(renewedExpiry)) || Date.parse(renewedExpiry) <= Date.now()) {
          throw new Error('Worker credential renewal did not return a live lease.')
        }
        signal?.throwIfAborted()
        if (this.managerCredentials.get(resolved.manager) !== credential) {
          throw new Error('The native credential owner changed during renewal.')
        }
        this.managerCredentials.set(resolved.manager, { ...credential, expiresAt: renewedExpiry })
      }
      signal?.throwIfAborted()
      // A resident process keeps its original token/environment, including across long waits.
      return undefined
    }
    const prepared = await this.credentials.prepare({
      executionId: context.executionId, harness: context.harness, workingDirectory: context.workingDirectory,
      ...(purpose ? { purpose } : {}),
      ...(signal ? { signal } : {}),
    })
    const expiresAt = Date.parse(prepared.credential.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('The prepared worker credential is not live.')
    this.managerCredentials.set(resolved.manager, prepared.credential)
    signal?.throwIfAborted()
    return prepared.credential.environment
  }

  /** Snapshot the owned process values before a terminal cleanup can discard them. */
  reviewPersistence(executionId: string) {
    const owned = this.ownedSessions.get(executionId)
    const credential = owned && this.managerCredentials.get(owned.manager)
    if (this.credentials && !credential) throw new DomainError('REVIEWER_CREDENTIAL_LOST',
      'Native persistence requires the exact process credential redaction context.', 409)
    return nativePersistenceRedactor(Object.values(credential?.environment.variables ?? {}))
  }

  reviewCredentialIdentity(executionId: string, session: NativeSessionReference): { required: boolean; principalId?: string } {
    const owned = this.ownedSessions.get(executionId)
    if (owned?.session) this.assertSessionIdentity(owned.session, session)
    const credential = owned && this.managerCredentials.get(owned.manager)
    return { required: Boolean(this.credentials), ...(credential ? { principalId: credential.principalId } : {}) }
  }

  async revokeReviewCredential(principalId: string): Promise<void> {
    if (!this.credentials) throw new Error('The captured reviewer credential cannot be revoked without its provider.')
    // The durable job stores only the captured principal, not a reusable token.
    // Never revokeForExecution here: a successor may own a different principal.
    await this.credentials.revoke({ principalId })
  }

  async recoverReviewCleanup(executionId: string, session: NativeSessionReference, job: ReviewJob,
    signal: AbortSignal): Promise<ReviewCleanupSession> {
    signal.throwIfAborted()
    const execution = await this.runs.getExecution(executionId)
    const native = await this.interactions.coordination.workflowSession(executionId)
    const configuration = execution && await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
    if (!job.cleanup || job.state !== 'failed' || !execution || execution.agentId !== job.reviewerAgentId
      || execution.nativeSessionId !== job.nativeSessionId || session.nativeSessionId !== job.nativeSessionId
      || session.harness !== job.provider || !native?.finalized || !configuration
      || configuration.harness.harness !== job.provider || configuration.agentId !== job.reviewerAgentId) {
      throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'Cleanup does not match the durable reviewer execution.', 409)
    }
    this.assertSessionIdentity(native.session, session)
    signal.throwIfAborted()
    const owned = this.ownedSessions.get(executionId)
    if (owned?.session) this.assertSessionIdentity(owned.session, session)
    const context = { ...this.managerContext(execution, configuration), purpose: 'reviewer' as const }
    const resolved = owned ? undefined : this.resolveManager(context)
    const manager = owned?.manager ?? resolved!.manager
    // Resolving a writer is not starting/attaching it. In particular there is no
    // prepareEnvironment, beginStart, capabilities, or credential heartbeat here.
    const resident = owned ? Boolean(owned.session && !owned.opening) : resolved!.processState === 'resident'
    return {
      manager, resident, closed: this.closedExecutions.has(executionId),
      confirmClosed: async (cleanupSignal) => {
        cleanupSignal.throwIfAborted()
        // Only the nonresident orphan-process path may perform closure recovery.
        // A missing local manager by itself proves absolutely nothing.
        if (owned || this.ownedSessions.has(executionId) || resolved?.processState !== 'needs_start') return false
        const closed = await this.recoverNativeProcesses?.(executionId, cleanupSignal) === true
        cleanupSignal.throwIfAborted()
        if (closed) this.closedExecutions.add(executionId)
        return closed
      },
    }
  }

  private async validateReviewer(owned: OwnedNativeSession, session: NativeSessionReference, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.ownedSessions.get(owned.execution.id) !== owned || owned.context.purpose !== 'reviewer'
      || owned.controller.signal.aborted || this.stoppingRuns.has(owned.execution.runId)) {
      throw new DomainError('REVIEWER_AUTHORITY_LOST', 'The reviewer no longer owns this native process.', 409)
    }
    const execution = await this.runs.getExecution(owned.execution.id)
    const run = await this.runs.get(owned.execution.runId)
    const native = await this.interactions.coordination.workflowSession(owned.execution.id)
    const configuration = execution && await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
    signal.throwIfAborted()
    if (!execution || execution.state !== 'completed' || execution.agentId !== owned.context.agentId
      || execution.runId !== owned.execution.runId || execution.nativeSessionId !== session.nativeSessionId
      || execution.agentConfigurationVersionId !== owned.execution.agentConfigurationVersionId
      || execution.workingDirectory !== owned.context.workingDirectory
      || execution.runtimeDirectory !== owned.execution.runtimeDirectory
      || !run || run.id !== owned.execution.runId || !['running', 'waiting'].includes(run.executionState) || run.outcome !== 'pending'
      || run.approval?.handler !== 'orchestrator' || run.approval.designatedOrchestratorAgentId !== execution.agentId
      || configuration?.productRole !== 'orchestrator' || configuration.agentId !== execution.agentId
      || configuration.id !== execution.agentConfigurationVersionId || configuration.workspaceId !== run.workspaceId
      || configuration.harness.harness !== session.harness || !native?.finalized) {
      throw new DomainError('REVIEWER_AUTHORITY_LOST', 'The Run or finalized reviewer execution no longer authorizes this review.', 409)
    }
    this.assertSessionIdentity(native.session, session)
    await this.validateContinuation?.(execution.id, signal)
    signal.throwIfAborted()
  }

  async maintainReviewCredential(executionId: string, session: NativeSessionReference, parentSignal: AbortSignal,
    assertOwned: () => Promise<void>): Promise<ReviewCredentialMaintenance> {
    const owned = this.ownedSessions.get(executionId)
    if (!owned) throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The reviewer native process is no longer owned.', 409)
    const initial = this.managerCredentials.get(owned.manager)
    const generation = owned.generation
    if (this.credentials && !initial) throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The reviewer credential is no longer owned.', 409)
    const stopped = new AbortController()
    const failed = new AbortController()
    const signal = AbortSignal.any([parentSignal, owned.controller.signal, stopped.signal, failed.signal])
    const check = async () => {
      signal.throwIfAborted()
      await assertOwned()
      if (owned.generation !== generation || owned.opening) throw new DomainError('REVIEWER_AUTHORITY_LOST',
        'The native reviewer connection changed during credential maintenance.', 409)
      await this.validateReviewer(owned, session, signal)
      await assertOwned()
      signal.throwIfAborted()
    }
    let invalidation: Promise<void> | undefined
    const invalidate = () => {
      // No revokeForExecution: a successor may already own a different principal.
      invalidation ??= (initial && this.credentials ? this.credentials.revoke(initial) : Promise.resolve())
        .catch((error: unknown) => { invalidation = undefined; throw error })
      return invalidation
    }
    // Initial authority reads can stall too. Do not wait past the process token's
    // safety deadline before publishing a fail-closed handle to the dispatcher.
    const preflightDeadline = initial ? setTimeout(() => failed.abort(new DomainError('REVIEWER_CREDENTIAL_LOST',
      'Reviewer credential authority validation exceeded its safety deadline.', 409)),
    Math.max(0, Date.parse(initial.expiresAt) - Date.now() - 5_000)) : undefined
    preflightDeadline?.unref()
    let abortPreflight: (() => void) | undefined
    try {
      await Promise.race([check(), new Promise<never>((_resolve, reject) => {
        abortPreflight = () => reject(signal.reason)
        signal.addEventListener('abort', abortPreflight, { once: true })
        if (signal.aborted) abortPreflight()
      })])
    } catch (error) {
      if (isLeaseLost(error) || parentSignal.aborted || owned.controller.signal.aborted) throw error
      // Return the captured owner handle even on failed preflight, so dispatch
      // can persist the failure and cancel/revoke without guessing an owner.
      failed.abort(new DomainError('REVIEWER_CREDENTIAL_LOST',
        'The reviewer authority could not be confirmed before credential maintenance.', 409))
    } finally {
      clearTimeout(preflightDeadline)
      if (abortPreflight) signal.removeEventListener('abort', abortPreflight)
    }
    const stopRenewal = !signal.aborted && initial && this.credentials ? maintainCredential({
      expiresAt: () => this.managerCredentials.get(owned.manager)?.expiresAt,
      signal,
      refresh: async () => {
        await check()
        const credential = this.managerCredentials.get(owned.manager)
        if (!credential || credential.principalId !== initial.principalId || credential.environment !== initial.environment
          || !Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= Date.now()) {
          throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The reviewer lost its live process credential.', 409)
        }
        if (Date.parse(credential.expiresAt) <= Date.now() + WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
          if (!this.credentials?.renew) throw new Error('The reviewer credential cannot be renewed in place.')
          const expiresAt = await this.credentials.renew(executionId, { principalId: initial.principalId })
          await check()
          if (this.managerCredentials.get(owned.manager) !== credential || !Number.isFinite(Date.parse(expiresAt))
            || Date.parse(expiresAt) <= Date.now()) throw new Error('Reviewer credential renewal lost its owner or returned an invalid expiry.')
          this.managerCredentials.set(owned.manager, { ...credential, expiresAt })
        }
      },
      onFailure: (error) => {
        // Lease loss must remain distinguishable: it cannot cancel a successor's native turn.
        failed.abort(isLeaseLost(error) ? error : new DomainError('REVIEWER_CREDENTIAL_LOST',
          'Review stopped because its App MCP credential or authority could not be maintained. No native work was restarted.', 409))
        if (!isLeaseLost(error)) void invalidate().catch(() => undefined)
      },
    }) : undefined
    return { signal, invalidate, ...(initial ? { principalId: initial.principalId } : {}),
      stop: async () => { stopped.abort(); await stopRenewal?.() } }
  }

  async recordReviewFailure(executionId: string, job: ReviewJob, error: NonNullable<ReviewJob['error']>,
    pending?: PendingNativeInteraction, pendingRequests?: readonly PendingNativeInteraction[]): Promise<void> {
    const owned = this.ownedSessions.get(executionId)
    if (!owned || owned.execution.agentId !== job.reviewerAgentId || owned.session?.nativeSessionId !== job.nativeSessionId) {
      throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The failure does not belong to this reviewer execution.', 409)
    }
    const safe = this.reviewPersistence(executionId)
    await this.runs.recordActivity(owned.execution.runId, 'backend', 'review_job_state', safe.value({
      reviewJobId: job.id, interactionId: job.interactionId, state: 'failed', error,
      correlationId: job.correlationId, nativeSessionId: job.nativeSessionId,
      ...(job.providerTurnOrMessageId ? { nativeTurnId: job.providerTurnOrMessageId } : {}),
      ...(pending ? { nativeApproval: pending } : {}),
      ...(pendingRequests?.length ? { nativeApprovals: pendingRequests } : {}),
    }), executionId)
  }

  async finishRun(runId: string): Promise<void> {
    const failures: Error[] = []
    for (const owned of this.ownedSessions.values()) {
      if (owned.execution.runId !== runId) continue
      // An active reviewer may be awaiting this graph response through MCP.
      // It releases its session in finishReview after its native turn settles.
      if (owned.session && owned.manager.isActive(owned.session)) continue
      failures.push(...await this.cleanupSession(owned, false))
    }
    if (failures.length) throw new AggregateError(failures, 'Completed Run session cleanup was incomplete.')
  }

  async finishReview(executionId: string): Promise<void> {
    const owned = this.ownedSessions.get(executionId)
    if (!owned || (await this.runs.get(owned.execution.runId))?.executionState !== 'completed') return
    const failures = await this.cleanupSession(owned, false)
    if (failures.length) throw new AggregateError(failures, 'Review session cleanup was incomplete.')
  }

  async validateInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<void> {
    await this.validateContinuation?.(interaction.executionId, signal)
  }

  async attachInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<AttachedInteractionSession> {
    const execution = await this.runs.getExecution(interaction.executionId)
    if (!execution?.workingDirectory || !execution.runtimeDirectory) throw new Error('The durable execution cannot reconstruct its native session start input.')
    if (execution.agentId !== interaction.requestingAgentId || execution.runId !== interaction.runId) {
      throw new Error('The interaction requester does not own its durable execution.')
    }
    return this.attachOwnedSession({
      harness: interaction.harness, executionId: execution.id, agentId: execution.agentId,
      workingDirectory: execution.workingDirectory,
    }, {
      harness: interaction.harness, providerVersion: interaction.providerVersion,
      nativeSessionId: interaction.nativeSessionId,
    }, signal)
  }

  async attachOwnedSession(
    context: NativeManagerOwnershipContext,
    sessionReference: { harness: NativeManagerResolutionContext['harness']; providerVersion: string; nativeSessionId: string },
    signal?: AbortSignal,
  ): Promise<AttachedInteractionSession> {
    const execution = await this.runs.getExecution(context.executionId)
    if (!execution?.workingDirectory || !execution.runtimeDirectory || execution.agentId !== context.agentId
      || execution.workingDirectory !== context.workingDirectory
      || execution.nativeSessionId !== sessionReference.nativeSessionId || sessionReference.harness !== context.harness) {
      throw new Error('The native session ownership context does not match its durable execution.')
    }
    const run = await this.runs.get(execution.runId)
    if (!run) throw new Error('The durable execution Run is unavailable.')
    if (run.executionState === 'completed') throw new Error('A completed Run cannot restart native work.')
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
    if (!configuration || configuration.harness.harness !== context.harness) throw new Error('The durable execution configuration is unavailable or mismatched.')
    if (context.purpose === 'reviewer') {
      const native = await this.interactions.coordination.workflowSession(execution.id)
      if (configuration.productRole !== 'orchestrator' || !['running', 'waiting'].includes(run.executionState)
        || run.outcome !== 'pending' || execution.state !== 'completed' || !native?.finalized || run.approval?.handler !== 'orchestrator'
        || run.approval.designatedOrchestratorAgentId !== execution.agentId) {
        throw new DomainError('SESSION_LANE_BUSY', 'Workflow finalization must finish before review attachment.', 409)
      }
      this.assertSessionIdentity(native.session, sessionReference)
    } else if (execution.state === 'completed') {
      throw new DomainError('WORKER_EXECUTION_TERMINAL', 'A completed workflow execution cannot resume native work.', 409)
    }
    await this.validateContinuation?.(execution.id, signal)
    const resolutionContext = { ...this.managerContext(execution, configuration),
      ...(context.purpose ? { purpose: context.purpose } : {}),
    }
    const request = HarnessExecutionRequestSchema.parse({
      executionId: execution.id, runId: execution.runId, workspaceId: run.workspaceId,
      workflowNodeId: execution.workflowNodeId, workingDirectory: execution.workingDirectory,
      runtimeDirectory: execution.runtimeDirectory, configuration, input: execution.input,
    })
    if (this.stoppingRuns.has(execution.runId)) throw new Error('The Run is stopping.')
    const resolved = this.resolveManager(resolutionContext)
    // Claim outside cleanup: losing a concurrent startup race does not own its credentials.
    if (resolved.processState === 'needs_start') resolved.beginStart?.()
    const owned = this.ownSession(execution, resolutionContext, resolved.manager)
    owned.session = sessionReference
    signal = signal ? AbortSignal.any([signal, owned.controller.signal]) : owned.controller.signal
    try {
      const environment = await this.prepareEnvironment(resolutionContext, resolved, signal, context.purpose)
      await this.validateContinuation?.(execution.id, signal)
      signal.throwIfAborted()
      if (resolved.processState === 'resident') {
        await resolved.manager.history(sessionReference, signal)
        return { manager: resolved.manager, session: sessionReference, signal: owned.controller.signal }
      }
      const session = await this.openingSession(owned, resolved.manager.attachSession(sessionReference, {
        kind: 'workflow', correlationId: context.correlationId ?? `execution:${execution.id}`, request,
        ...(context.nativeTurnId ? { nativeTurnId: context.nativeTurnId } : {}),
        ...(environment ? { environment } : {}),
      }, signal))
      this.assertSessionIdentity(sessionReference, session)
      resolved.markResident?.()
      signal.throwIfAborted()
      return { manager: resolved.manager, session, signal: owned.controller.signal }
    } catch (error) {
      const safe = nativePersistenceRedactor(Object.values(this.managerCredentials.get(owned.manager)?.environment.variables ?? {}))
      if (isLeaseLost(error) || (error instanceof DomainError && error.code === 'SESSION_LANE_BUSY')) throw safe.error(error)
      resolved.markFailed?.()
      owned.failed = true
      await this.cleanupSession(owned)
      throw safe.error(error)
    }
  }

  private assertSessionIdentity(expected: NativeSessionReference, actual: NativeSessionReference): void {
    if (expected.harness !== actual.harness || expected.providerVersion !== actual.providerVersion
      || expected.nativeSessionId !== actual.nativeSessionId) {
      throw new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'The native manager returned a different session identity.', 409)
    }
  }

  /**
   * A terminal execution can be recovered without claiming that an ambiguous
   * approval was delivered. Only the exact durable execution correlation counts.
   * No prompt/response is sent and the interaction's delivery ledger is untouched.
   */
  async recoverTerminalInteraction(interaction: DurableInteraction, owner: RunOwnership, signal: AbortSignal): Promise<boolean> {
    const resident = this.ownedSessions.get(interaction.executionId)
    let safe = nativePersistenceRedactor(Object.values(resident
      ? this.managerCredentials.get(resident.manager)?.environment.variables ?? {} : {}))
    try {
      if (!interaction.selectedOptionId || !['submitted', 'uncertain'].includes(interaction.deliveryState)) return false
      signal.throwIfAborted()
      owner.assertOwned()
      const execution = await this.runs.getExecution(interaction.executionId, owner)
      if (!execution || execution.runId !== interaction.runId || execution.agentId !== interaction.requestingAgentId
        || execution.nativeSessionId !== interaction.nativeSessionId) return false
      if (execution.state === 'completed') return Boolean(execution.result)
      const attached = await this.attachInteraction(interaction, signal)
      safe = this.reviewPersistence(execution.id)
      signal = attached.signal ? AbortSignal.any([signal, attached.signal]) : signal
      this.assertSessionIdentity(attached.session, interaction)
      const correlationId = `execution:${execution.id}`
      const history = await attached.manager.reconcile(attached.session, correlationId, signal)
      const terminal = history.terminalTurn
      if (!terminal || terminal.correlationId !== correlationId || history.correlationId !== correlationId
        || !history.nativeTurnId || terminal.providerId !== history.nativeTurnId
        || history.pendingInteraction || history.pendingInteractions.length) return false
      signal.throwIfAborted()
      owner.assertOwned()
      for (const event of history.events) {
        signal.throwIfAborted()
        owner.assertOwned()
        await this.runs.appendNativeEvent(safe.value({ ...event, executionId: execution.id }), owner)
      }
      signal.throwIfAborted()
      owner.assertOwned()
      await this.runs.updateExecution(HarnessExecutionSchema.parse({ ...execution, state: 'completed',
        result: safe.value(terminal.result), finishedAt: new Date().toISOString() }), owner)
      signal.throwIfAborted()
      owner.assertOwned()
      await this.runs.recordActivity(execution.runId, 'backend', 'harness_output', {
        executionTerminalRecovered: true, nativeTurnId: terminal.providerId,
        interactionId: interaction.id, approvalDeliveryUnconfirmed: true,
      }, execution.id, owner.client)
      return true
    } catch (error) { throw safe.error(error) }
  }

  /** Resume values are delivery notifications, never decisions for the currently pending request. */
  async assertResume(execution: HarnessExecution, value: unknown): Promise<void> {
    const id = value && typeof value === 'object' && 'interactionId' in value ? value.interactionId : undefined
    const interaction = typeof id === 'string' ? await this.interactions.get(id) : undefined
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
    if (!interaction || interaction.deliveryState !== 'delivered'
      || !configuration || configuration.harness.harness !== interaction.harness
      || interaction.executionId !== execution.id || interaction.runId !== execution.runId
      || interaction.requestingAgentId !== execution.agentId
      || interaction.nativeSessionId !== execution.nativeSessionId) {
      throw new DomainError('GRAPH_INTERRUPT_RESUME_INVALID', 'The resume value is not a delivered interaction for this execution.', 409)
    }
  }

  cancelRun(runId: string, owner?: RunOwnership): Promise<void> {
    this.stoppingRuns.add(runId)
    this.pendingCleanupRuns.add(runId)
    const local = [...this.ownedSessions.values()].filter((owned) => owned.execution.runId === runId)
    for (const owned of local) owned.controller.abort()
    const existing = this.cancellations.get(runId)
    if (existing) return existing
    const task = (async () => {
      const failures: Error[] = []
      // Start local native cleanup before any database wait. Process every sibling,
      // and keep failed closures registered for a later Stop/shutdown retry.
      const cleanups = local.map(async (owned) => {
        failures.push(...await this.cleanupSession(owned))
        await attemptCleanup(failures, `${owned.execution.id}: stop active budget`, () => this.budgets.stop(owned.execution.id))
      })
      const executions = await attemptCleanup(failures, `${runId}: list executions`, () => this.runs.listExecutions(runId))
      const known = new Set(local.map((owned) => owned.execution.id))
      for (const execution of executions ?? []) {
        cleanups.push((async () => {
          if (known.has(execution.id)) return
          const recovered = await attemptCleanup(failures, `${execution.id}: recover registered process groups`,
            async (signal) => this.recoverNativeProcesses ? this.recoverNativeProcesses(execution.id, signal) : false)
          if (recovered) this.closedExecutions.add(execution.id)
          const owned = await attemptCleanup(failures, `${execution.id}: resolve native session`, async (signal) => {
            if (!execution.nativeSessionId || this.closedExecutions.has(execution.id)) return undefined
            if (execution.state === 'completed') {
              const native = await this.interactions.coordination.workflowSession(execution.id)
              // Workflow finalization was published only after native closure.
              // A later reviewer credential is evidence of a new review lifetime.
              if (native?.finalized && !native.reviewerActive
                && !await this.interactions.coordination.hasUnsettledReview(execution.id)) return undefined
            }
            const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
            signal.throwIfAborted()
            if (!configuration) throw new Error('The durable execution configuration is unavailable.')
            const context = this.managerContext(execution, configuration)
            const resolved = this.resolveManager(context)
            if (resolved.processState === 'needs_start') {
              // Stop must never start/attach a replacement native process, nor
              // mistake lack of a local manager for proof of native closure.
              this.managers.release?.(context)
              throw new Error('The native session is not resident; closure cannot be confirmed.')
            }
            const owned: OwnedNativeSession = { execution, context, manager: resolved.manager, controller: new AbortController(), generation: 0 }
            this.ownedSessions.set(execution.id, owned)
            return owned
          })
          if (owned) failures.push(...await this.cleanupSession(owned))
          else await attemptCleanup(failures, `${execution.id}: revoke execution credential`, async () => {
            await this.credentials?.revokeForExecution(execution.id)
          })
          await attemptCleanup(failures, `${execution.id}: stop active budget`, () => this.budgets.stop(execution.id))
        })())
      }
      cleanups.push(attemptCleanup(failures, `${runId}: cancel unresolved interactions`, () => this.interactions.cancelPendingForRun(runId)).then(() => undefined))
      const outcomes = await Promise.allSettled(cleanups)
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') failures.push(new Error('Unexpected execution cleanup failure.', { cause: outcome.reason }))
      }
      if (owner) for (const execution of executions ?? []) {
        if (execution.state === 'completed') continue
        await attemptCleanup(failures, `${execution.id}: settle execution`, () => this.runs.updateExecution(HarnessExecutionSchema.parse({
          ...execution, state: 'completed', result: { outcome: 'canceled' }, finishedAt: new Date().toISOString(),
        }), owner))
      }
      if (failures.length) throw new AggregateError(failures, 'Run cleanup was incomplete; native closure must not be assumed.')
      // Publish cleanup evidence only after every sibling's native closure and
      // revocation succeeded. A failed Stop keeps the durable intent retryable.
      await this.interactions.coordination.finishStoppedReviews(runId, Boolean(this.credentials), owner?.client)
      this.pendingCleanupRuns.delete(runId)
    })().finally(() => { this.cancellations.delete(runId) })
    this.cancellations.set(runId, task)
    return task
  }

  async ensureObserve(input: {
    candidate: HarnessExecution
    request: HarnessExecutionRequest
    approval?: WorkflowApprovalConfiguration | undefined
    workflowId: string
    graphThreadId: string
    owner: RunOwnership
    signal: AbortSignal
  }): Promise<ApprovalExecutionObservation> {
    const credentialFailure = new AbortController()
    let signal = AbortSignal.any([input.signal, credentialFailure.signal])
    let stopRenewal: (() => Promise<void>) | undefined
    signal.throwIfAborted()
    assertNativeWorkflowConfiguration(input.request.configuration.harness, input.approval,
      input.approval?.handler === 'orchestrator'
        && input.request.configuration.agentId === input.approval.designatedOrchestratorAgentId)
    const ensured = await this.runs.ensureExecution(input.candidate, input.owner)
    let execution = ensured.execution
    let context: NativeManagerResolutionContext | undefined
    let manager: SingleWriterSessionManager | undefined
    let resolved: (ResolvedNativeSessionManager & { manager: SingleWriterSessionManager }) | undefined
    let ownedSession: OwnedNativeSession | undefined
    let session: NativeSessionReference | undefined
    let budgetTimer: ReturnType<typeof setTimeout> | undefined
    const knownSecrets: string[] = []
    const watchCredential = () => {
      const credential = manager && this.managerCredentials.get(manager)
      if (!credential) return
      knownSecrets.push(...Object.values(credential.environment.variables))
    }
    const safeError = (error: unknown): unknown => {
      if (error instanceof AggregateError) return new AggregateError(
        [...error.errors].map(safeError), redactSecretText(error.message, knownSecrets),
      )
      if (error instanceof HarnessExecutionError) {
        return new HarnessExecutionError(error.result.error?.code ?? 'NATIVE_EXECUTION_FAILED',
          redactSecretText(error.message, knownSecrets), error.result.error?.retryable)
      }
      if (error instanceof DomainError) return new DomainError(error.code,
        redactSecretText(error.message, knownSecrets), error.status, redactKnownSecrets(error.details, knownSecrets))
      if (error instanceof Error) {
        const message = redactSecretText(error.message, knownSecrets)
        return error.cause === undefined ? new Error(message) : new Error(message, { cause: safeError(error.cause) })
      }
      return redactKnownSecrets(error, knownSecrets)
    }
    const startCredentialMaintenance = () => {
      watchCredential()
      if (!this.credentials || stopRenewal || !manager || !this.managerCredentials.has(manager)) return
      stopRenewal = maintainCredential({
        expiresAt: () => this.managerCredentials.get(manager!)?.expiresAt,
        signal,
        refresh: async () => {
          signal.throwIfAborted()
          input.owner.assertOwned()
          await this.validateContinuation?.(execution.id, signal)
          input.owner.assertOwned()
          const credential = this.managerCredentials.get(manager!)
          if (!credential) throw new Error('The execution lost its native credential lease.')
          if (Date.parse(credential.expiresAt) <= Date.now() + WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
            if (!this.credentials?.renew) throw new Error('This native credential cannot be renewed.')
            const expiresAt = await this.credentials.renew(context!.executionId, { principalId: credential.principalId })
            signal.throwIfAborted()
            input.owner.assertOwned()
            if (this.managerCredentials.get(manager!) !== credential || !Number.isFinite(Date.parse(expiresAt))
              || Date.parse(expiresAt) <= Date.now()) throw new Error('Native credential renewal lost its owner or returned an invalid expiry.')
            this.managerCredentials.set(manager!, { ...credential, expiresAt })
          }
          input.owner.assertOwned()
        },
        onFailure: () => credentialFailure.abort(new DomainError(
          'WORKER_CREDENTIAL_EXPIRING',
          'Execution stopped before its App credential expired. Active native work was not restarted.', 409,
        )),
      })
    }
    try {
      signal.throwIfAborted()
      input.owner.assertOwned()
      if (execution.state === 'completed') {
        if (!execution.result) throw new Error('The completed execution has no durable result.')
        const native = await this.interactions.coordination.workflowSession(execution.id)
        if (!native?.finalized) {
          await this.budgets.finish(execution.id, execution.finishedAt)
          const owned = this.ownedSessions.get(execution.id)
          if (owned) {
            const failures = await this.cleanupSession(owned, false)
            if (failures.length) throw new AggregateError(failures, 'Workflow finalization cleanup failed.')
          } else await this.credentials?.revokeForExecution(execution.id)
          await this.interactions.coordination.finalizeWorkflowSession(execution.id)
        }
        return { state: 'completed', execution, result: execution.result }
      }
      await this.budgets.ensure(execution.id, input.graphThreadId, this.activeTimeoutMs)
      if (execution.state === 'waiting') await this.budgets.resume(execution.id)
      const budgetStarted = performance.now()
      const remainingMs = await this.budgets.remaining(execution.id)
      const deadline = new AbortController()
      budgetTimer = setTimeout(() => deadline.abort(new DomainError('EXECUTION_ACTIVE_TIMEOUT', 'The execution exhausted its active-time budget.', 409)),
        Math.max(0, remainingMs - (performance.now() - budgetStarted)))
      budgetTimer.unref()
      signal = AbortSignal.any([signal, deadline.signal])
      // Read the durable reference before resolving a manager: a repository
      // failure must not evict a resident session still needed by run cleanup.
      const existing = execution.nativeSessionId ? await this.interactions.getForExecution(execution.id) : undefined
      context = this.managerContext(execution, input.request.configuration)
      const request = HarnessExecutionRequestSchema.parse({
        ...input.request, executionId: execution.id, runId: execution.runId,
        workflowNodeId: execution.workflowNodeId, workingDirectory: execution.workingDirectory,
        runtimeDirectory: execution.runtimeDirectory, input: execution.input,
      })
      await this.validateContinuation?.(execution.id, signal)
      resolved = this.resolveManager(context)
      if (resolved.processState === 'needs_start') resolved.beginStart?.()
      manager = resolved.manager
      ownedSession = this.ownSession(execution, context, manager)
      signal = AbortSignal.any([signal, ownedSession.controller.signal])

      const observePending = async (history: NativeHistory, sourceEvent?: NativeHarnessEvent,
        sourceLease?: WorkflowNativeLease): Promise<ApprovalExecutionObservation | undefined> => {
        history = { ...history, events: history.events.map((event) => normalizeNativeProducerEvent(
          redactKnownSecrets({ ...event, executionId: execution.id }, knownSecrets)).event) }
        signal.throwIfAborted()
        input.owner.assertOwned()
        if (history.canceledRequestIds?.length) await this.interactions.cancelPendingForExecution(execution.id, history.canceledRequestIds)
        const waiting: DurableInteraction[] = []
        if (history.pendingInteractions.length && input.approval?.handler === 'orchestrator'
          && input.approval.designatedOrchestratorAgentId === execution.agentId) {
          throw new DomainError('ORCHESTRATOR_BOOTSTRAP_APPROVAL_UNSUPPORTED',
            'The initial Orchestrator requested an approval it cannot review. Execution stopped without self-approval or changing the accepted handler.', 409)
        }
        for (const pending of history.pendingInteractions) {
          if (!input.approval) throw new DomainError(
            'NATIVE_APPROVAL_HANDLER_MISSING',
            'The native execution asked for a decision but this workflow has no routed approval handler. Reopen and save the workflow or Agent configuration. The request was not automatically approved.', 409,
          )
          this.assertSessionIdentity(session!, pending.session)
          await this.interactions.assertOrchestratorConnection({
            workspaceId: request.workspaceId, workflowId: input.workflowId, runId: execution.runId,
            executionId: execution.id, requestingAgentId: execution.agentId, approval: input.approval,
            harness: session!.harness, nativeSessionId: session!.nativeSessionId,
          })
          if (!pending.turn.nativeRequestId) throw new Error('Native approval request is missing its stable request identity.')
          const now = new Date().toISOString()
          // create() deduplicates by (harness, native session, native request),
          // not by execution. Persist the entire native snapshot before yielding.
          const created = await this.interactions.create(DurableInteractionSchema.parse({
            id: `interaction-${randomUUID()}`, revision: 0,
            workspaceId: request.workspaceId, workflowId: input.workflowId,
            runId: execution.runId, executionId: execution.id, requestingAgentId: execution.agentId,
            harness: session!.harness, providerVersion: session!.providerVersion,
            nativeSessionId: session!.nativeSessionId, nativeRequestId: pending.turn.nativeRequestId,
            nativeRequestType: pending.nativeRequestType, graphThreadId: input.graphThreadId,
            request: redactKnownSecrets(pending.request, knownSecrets), approval: input.approval, responseOptions: pending.responseOptions,
            reviewContext: redactKnownSecrets(nativeApprovalContext(pending, history.events), knownSecrets),
            status: 'pending', deliveryState: 'not_started', createdAt: now, updatedAt: now,
          }))
          if (sourceEvent && sourceLease) await this.runs.appendNativeEvent(
            redactKnownSecrets({ ...sourceEvent, executionId: execution.id }, knownSecrets), input.owner,
            sourceLease, { interaction: created.interaction, nativeTurnId: pending.turn.nativeTurnId })
          // A provider may briefly report an already-delivered request. Observe
          // its continuation; never offer that delivered interaction as a new ask.
          if (created.interaction.deliveryState !== 'delivered') waiting.push(created.interaction)
          if (created.created) {
            await this.runs.recordActivity(execution.runId, 'harness', 'harness_output', {
              nativeEventType: 'interaction_pending',
              interactionId: created.interaction.id, handler: created.interaction.approval.handler,
            }, execution.id, input.owner.client)
          }
          await this.enqueueReview(created.interaction)
        }
        if (!waiting.length) return undefined
        signal.throwIfAborted()
        execution = HarnessExecutionSchema.parse({ ...execution, state: 'waiting' })
        await this.runs.updateExecution(execution, input.owner)
        await this.budgets.beginWait(execution.id)
        return { state: 'waiting', execution, interaction: waiting[0]!, interactions: waiting }
      }

      if (!execution.nativeSessionId) {
        if (!ensured.created && !this.runs.consumeOneShotLaunch?.(execution.id, input.owner)) {
          throw new DomainError('NATIVE_SESSION_START_UNCERTAIN', 'The existing execution has no recorded native session. Native side effects will not be replayed.', 409)
        }
        const environment = await this.prepareEnvironment(context, resolved, signal)
        startCredentialMaintenance()
        await this.validateContinuation?.(execution.id, signal)
        signal.throwIfAborted()
        input.owner.assertOwned()
        await this.runs.assertOneShotNativeBoundary?.(execution.id, input.owner)
        session = await this.openingSession(ownedSession, manager.createSession({ request, ...(environment ? { environment } : {}) }, signal))
        if (session.harness !== context.harness) throw new Error('The created native session has the wrong harness.')
        resolved.markResident?.()
        await this.interactions.coordination.bindWorkflowSession(execution.id, session)
        execution = HarnessExecutionSchema.parse({ ...execution, nativeSessionId: session.nativeSessionId, state: 'running' })
        await this.runs.updateExecution(execution, input.owner)
        // Qualification and credential preparation may await external work.
        // Recheck accepted authority/location at the actual turn boundary.
        await this.validateContinuation?.(execution.id, signal)
        signal.throwIfAborted()
        input.owner.assertOwned()
        await this.runs.assertOneShotNativeBoundary?.(execution.id, input.owner)
        for await (const event of manager.startTurn(session, {
          prompt: buildHarnessPrompt(request), clientCorrelationId: `execution:${execution.id}`,
        }, signal)) {
          signal.throwIfAborted()
          await this.budgets.assertActive(execution.id)
          const lease = manager.currentProjectionLease(session)
          await this.runs.appendNativeEvent(redactKnownSecrets({ ...event, executionId: execution.id }, knownSecrets),
            input.owner, lease)
          const waiting = await observePending(await manager.history(session, signal), event, lease)
          if (waiting) return waiting
        }
      } else {
        session = await this.runs.exactOneShotSession?.(execution.id, input.owner) ?? {
          harness: context.harness,
          providerVersion: existing?.providerVersion ?? (await manager.capabilities(signal)).providerVersion,
          nativeSessionId: execution.nativeSessionId,
        }
        ownedSession.session = session
        if (existing) this.assertSessionIdentity(session, existing)
        const environment = await this.prepareEnvironment(context, resolved, signal)
        startCredentialMaintenance()
        await this.validateContinuation?.(execution.id, signal)
        signal.throwIfAborted()
        input.owner.assertOwned()
        await this.runs.assertOneShotNativeBoundary?.(execution.id, input.owner)
        if (resolved.processState === 'needs_start') {
          const attached = await this.openingSession(ownedSession, manager.attachSession(session, {
            kind: 'workflow', correlationId: `execution:${execution.id}`, request,
            ...(environment ? { environment } : {}),
          }, signal))
          this.assertSessionIdentity(session, attached)
          resolved.markResident?.()
        }
        // Resident sessions retain their original scoped process credentials.
        // history() below verifies the already-owned exact session, without a
        // redundant attachSession() requiring a newly supplied environment.
      }

      for (;;) {
        signal.throwIfAborted()
        input.owner.assertOwned()
        await this.budgets.assertActive(execution.id)
        const observed = await manager.withLane(session, `execution:${execution.id}`, signal, async (nativeManager, lane) => {
          const observed = await nativeManager.reconcile(session!, `execution:${execution.id}`, lane.guard.signal)
          const exactTerminal = observed.terminalTurn?.correlationId === `execution:${execution.id}`
            && (!observed.nativeTurnId || observed.terminalTurn.providerId === observed.nativeTurnId)
            && !observed.pendingInteraction && observed.pendingInteractions.length === 0
          if (exactTerminal) {
            lane.providerId = observed.terminalTurn!.providerId
          } else if (observed.correlationId === `execution:${execution.id}` && observed.nativeTurnId) {
            lane.providerId = observed.nativeTurnId
          }
          const lease = { ...lane.fence, ...(lane.providerId ? { providerId: lane.providerId } : {}), live: false as const }
          const continuation = exactTerminal ? { session: session!, providerId: observed.terminalTurn!.providerId,
            correlationId: `execution:${execution.id}`, responseDeliveries: observed.responseDeliveries ?? [] } : undefined
          for (const event of observed.events) {
            await lane.guard.check()
            await this.runs.appendNativeEvent(redactKnownSecrets({ ...event, executionId: execution.id }, knownSecrets),
              input.owner, lease, undefined, continuation)
          }
          return { history: observed, waiting: await observePending(observed, observed.events.at(-1), lease) }
        })
        const { history, waiting } = observed
        if (waiting) return waiting
        if (history.terminalTurn?.correlationId === `execution:${execution.id}`) {
          const result = redactKnownSecrets(history.terminalTurn.result, knownSecrets)
          execution = HarnessExecutionSchema.parse({
            ...execution, state: 'completed', result, finishedAt: new Date().toISOString(),
          })
          await this.runs.updateExecution(execution, input.owner)
          const failures: unknown[] = []
          try { await this.budgets.finish(execution.id, execution.finishedAt) }
          catch (error) { failures.push(error) }
          ownedSession.execution = execution
          failures.push(...await this.cleanupSession(ownedSession, false))
          if (failures.length) throw new AggregateError(failures, 'Terminal execution cleanup was incomplete.')
          await this.interactions.cancelPendingForExecution(execution.id)
          await this.interactions.coordination.finalizeWorkflowSession(execution.id)
          return { state: 'completed', execution, result }
        }
        // Approval delivery is not turn completion. Keep observing the same
        // native turn; neither startTurn nor native responses are replayed here.
        if (execution.state !== 'running') {
          execution = HarnessExecutionSchema.parse({ ...execution, state: 'running' })
          await this.runs.updateExecution(execution, input.owner)
        }
        await delay(100, undefined, { signal: signal })
      }
    } catch (rawError) {
      // A credential may have been issued just before an abort rejected setup.
      const credential = manager && this.managerCredentials.get(manager)
      if (credential) knownSecrets.push(...Object.values(credential.environment.variables))
      const error = safeError(signal.aborted && signal.reason instanceof DomainError
        && signal.reason.code === 'WORKER_CREDENTIAL_EXPIRING' ? signal.reason : rawError)
      if ((resolved && !manager) || isLeaseLost(rawError)
        || (error instanceof DomainError && error.code === 'SESSION_LANE_BUSY')) throw error
      if (execution.state === 'completed' && (!ownedSession || this.closedExecutions.has(execution.id))) throw error
      try {
        input.owner.assertOwned()
        if (execution.state !== 'completed') {
          const timedOut = signal.aborted && signal.reason instanceof DomainError
            && ['EXECUTION_ACTIVE_TIMEOUT', 'WORKER_CREDENTIAL_EXPIRING'].includes(signal.reason.code)
          const failure: unknown = timedOut ? safeError(signal.reason) : error
          const result: ExecutionResult = signal.aborted && !timedOut ? { outcome: 'canceled' }
            : failure instanceof HarnessExecutionError ? failure.result : {
              outcome: 'failed', error: {
                code: failure instanceof DomainError ? failure.code : 'WORKFLOW_EXECUTION_FAILED',
                message: failure instanceof Error ? failure.message : 'Unknown workflow execution failure.', retryable: false,
              },
            }
          execution = HarnessExecutionSchema.parse({
            ...execution, state: 'completed', result, finishedAt: new Date().toISOString(),
          })
          await this.runs.updateExecution(execution, input.owner)
          await this.runs.recordActivity(execution.runId, 'harness', 'harness_session_finished', {
            workflowNodeId: execution.workflowNodeId, outcome: result.outcome, error: result.error ?? null,
          }, execution.id, input.owner.client)
        }
      } finally {
        let owned = true
        try { input.owner.assertOwned() } catch { owned = false }
        // Losing ownership must not stop a replacement owner's budget or revoke
        // its newly issued credentials. Only close our local transport in that case.
        if (owned) await this.budgets.finish(execution.id, execution.finishedAt).catch(() => undefined)
        if (owned && ownedSession) {
          resolved?.markFailed?.()
          ownedSession.failed = true
          ownedSession.execution = execution
          await this.cleanupSession(ownedSession)
        } else if (owned) {
          await this.credentials?.revokeForExecution(execution.id).catch(() => undefined)
        } else if (manager && session) {
          // Ownership loss cannot revoke a replacement owner's credential.
          await attemptCleanup([], 'close lost-owner transport', () => manager!.close(session!))
        }
      }
      throw error
    } finally {
      await stopRenewal?.()
      if (budgetTimer) clearTimeout(budgetTimer)
    }
  }
}
