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
  HarnessExecutionRequestSchema,
} from '@graphql/contracts'

import { WORKER_CREDENTIAL_RENEWAL_WINDOW_MS, type IssuedWorkerCredential } from '../access/workerCredentials.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../harnesses/port.js'
import { DomainError } from '../errors.js'
import { ReviewerDispatcher } from './reviewer.js'
import { coordinateSessionManager, isLeaseLost, type SingleWriterSessionManager } from './sessionWriter.js'
import { HarnessExecutionError } from '../harnesses/errors.js'
import { buildHarnessPrompt } from '../harnesses/prompt.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { RunOwnership } from '../runs/ownership.js'
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

/** Idempotent ensure/observe boundary called first on every LangGraph node entry. */
export class ApprovalExecutionCoordinator {
  private readonly managerCredentials = new WeakMap<NativeHarnessSessionManager, IssuedWorkerCredential>()

  readonly reviewers: ReviewerDispatcher
  private readonly writers = new WeakMap<NativeHarnessSessionManager, SingleWriterSessionManager>()
  private readonly rawManagers = new WeakMap<NativeHarnessSessionManager, NativeHarnessSessionManager>()
  constructor(
    private readonly runs: PostgresRunRepository,
    private readonly interactions: PostgresInteractionRepository,
    private readonly budgets: PostgresApprovalBudgetRepository,
    private readonly managers: NativeSessionManagerResolver,
    private readonly activeTimeoutMs: number,
    private readonly credentials?: ExecutionCredentialProvider,
  ) {
    this.reviewers = new ReviewerDispatcher(interactions.coordination, this)
  }

  /** Bind only an existing execution of the designated reviewer in this Run. Never spawn a substitute. */
  async enqueueReview(interaction: DurableInteraction): Promise<void> {
    if (interaction.status !== 'pending' || interaction.approval.handler !== 'orchestrator') return
    const agentId = interaction.approval.designatedOrchestratorAgentId
    if (!agentId || agentId === interaction.requestingAgentId) return
    if (await this.interactions.coordination.findReviewJob(interaction.id, agentId)) return
    const candidates = (await this.runs.listExecutions(interaction.runId))
      .filter((execution) => execution.agentId === agentId && execution.nativeSessionId
        && execution.workingDirectory && execution.runtimeDirectory)
    // No guessing between attempts/sessions. The pending interaction remains the recovery source.
    if (candidates.length !== 1) return
    const execution = candidates[0]!
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
    if (!configuration || configuration.productRole !== 'orchestrator') return
    const { manager } = this.resolveManager(this.managerContext(execution, configuration))
    const capability = await manager.capabilities()
    await this.reviewers.enqueue(interaction, agentId, {
      harness: configuration.harness.harness, providerVersion: capability.providerVersion,
      nativeSessionId: execution.nativeSessionId!,
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
  ) {
    if (!this.credentials) return undefined
    if (resolved.processState === 'resident') {
      const credential = this.managerCredentials.get(resolved.manager)
      if (!credential) throw new Error('The resident native process has no owned worker credential lease.')
      const expiresAt = Date.parse(credential.expiresAt)
      if (!Number.isFinite(expiresAt)) throw new Error('The worker credential expiry is invalid.')
      if (expiresAt <= Date.now() && !this.credentials.renew) {
        throw new Error('The resident worker credential cannot be renewed without replacing its process.')
      }
      if (this.credentials.renew && expiresAt <= Date.now() + WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
        const renewedExpiry = await this.credentials.renew(context.executionId, { principalId: credential.principalId })
        if (!Number.isFinite(Date.parse(renewedExpiry)) || Date.parse(renewedExpiry) <= Date.now()) {
          throw new Error('Worker credential renewal did not return a live lease.')
        }
        this.managerCredentials.set(resolved.manager, { ...credential, expiresAt: renewedExpiry })
      }
      signal?.throwIfAborted()
      // A resident process keeps its original token/environment, including across long waits.
      return undefined
    }
    const prepared = await this.credentials.prepare({
      executionId: context.executionId, harness: context.harness, workingDirectory: context.workingDirectory,
      ...(signal ? { signal } : {}),
    })
    const expiresAt = Date.parse(prepared.credential.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('The prepared worker credential is not live.')
    this.managerCredentials.set(resolved.manager, prepared.credential)
    signal?.throwIfAborted()
    return prepared.credential.environment
  }

  private async releaseFailedManager(
    context: NativeManagerResolutionContext,
    resolved: ResolvedNativeSessionManager,
    session?: AttachedInteractionSession['session'],
  ): Promise<void> {
    resolved.markFailed?.()
    try {
      if (session) await resolved.manager.close(session).catch(() => undefined)
      // This includes credentials issued by an earlier call to a resident manager.
      await this.credentials?.revokeForExecution(context.executionId)
    } finally {
      this.managerCredentials.delete(resolved.manager)
      this.managers.release?.(context, this.rawManagers.get(resolved.manager) ?? resolved.manager, 'failed')
    }
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
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
    if (!configuration || configuration.harness.harness !== context.harness) throw new Error('The durable execution configuration is unavailable or mismatched.')
    const resolutionContext = this.managerContext(execution, configuration)
    const request = HarnessExecutionRequestSchema.parse({
      executionId: execution.id, runId: execution.runId, workspaceId: run.workspaceId,
      workflowNodeId: execution.workflowNodeId, workingDirectory: execution.workingDirectory,
      runtimeDirectory: execution.runtimeDirectory, configuration, input: execution.input,
    })
    const resolved = this.resolveManager(resolutionContext)
    // Claim outside cleanup: losing a concurrent startup race does not own its credentials.
    if (resolved.processState === 'needs_start') resolved.beginStart?.()
    try {
      const environment = await this.prepareEnvironment(resolutionContext, resolved, signal)
      if (resolved.processState === 'resident') {
        await resolved.manager.history(sessionReference, signal)
        return { manager: resolved.manager, session: sessionReference }
      }
      const session = await resolved.manager.attachSession(sessionReference, {
        kind: 'workflow', correlationId: `execution:${execution.id}`, request,
        ...(environment ? { environment } : {}),
      }, signal)
      this.assertSessionIdentity(sessionReference, session)
      resolved.markResident?.()
      return { manager: resolved.manager, session }
    } catch (error) {
      if (isLeaseLost(error) || (error instanceof DomainError && error.code === 'SESSION_LANE_BUSY')) throw error
      await this.releaseFailedManager(resolutionContext, resolved, sessionReference).catch(() => undefined)
      throw error
    }
  }

  private assertSessionIdentity(expected: NativeSessionReference, actual: NativeSessionReference): void {
    if (expected.harness !== actual.harness || expected.providerVersion !== actual.providerVersion
      || expected.nativeSessionId !== actual.nativeSessionId) {
      throw new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'The native manager returned a different session identity.', 409)
    }
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

  async cancelRun(runId: string, owner?: RunOwnership): Promise<void> {
    owner?.assertOwned()
    const failures: unknown[] = []
    for (const execution of await this.runs.listExecutions(runId)) {
      let context: NativeManagerResolutionContext | undefined
      try { await this.budgets.stop(execution.id) } catch (error) { failures.push(error) }
      try {
        if (execution.nativeSessionId) {
          const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
          if (configuration) {
            context = this.managerContext(execution, configuration)
            const resolved = this.resolveManager(context)
            if (resolved.processState === 'resident') {
              const session = {
                harness: configuration.harness.harness,
                providerVersion: (await resolved.manager.capabilities()).providerVersion,
                nativeSessionId: execution.nativeSessionId,
              }
              await resolved.manager.cancel(session).catch(() => false)
              await resolved.manager.close(session).catch(() => undefined)
            }
          }
        }
      } catch (error) { failures.push(error) } finally {
        if (context) this.managers.release?.(context)
      }
      // Only the execution owner may settle a live attempt. The active node
      // handles its own abort when cancellation is requested without ownership.
      try {
        if (owner && execution.state !== 'completed') {
          await this.runs.updateExecution(HarnessExecutionSchema.parse({
            ...execution, state: 'completed', result: { outcome: 'canceled' }, finishedAt: new Date().toISOString(),
          }), owner)
        }
      } catch (error) { failures.push(error) }
      try { await this.credentials?.revokeForExecution(execution.id) } catch (error) { failures.push(error) }
    }
    try { await this.interactions.cancelPendingForRun(runId) } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Some native execution cleanup failed.')
  }

  async ensureObserve(input: {
    candidate: HarnessExecution
    request: HarnessExecutionRequest
    approval: WorkflowApprovalConfiguration
    workflowId: string
    graphThreadId: string
    owner: RunOwnership
    signal: AbortSignal
  }): Promise<ApprovalExecutionObservation> {
    const ensured = await this.runs.ensureExecution(input.candidate, input.owner)
    let execution = ensured.execution
    let context: NativeManagerResolutionContext | undefined
    let manager: NativeHarnessSessionManager | undefined
    let resolved: ResolvedNativeSessionManager | undefined
    let session: NativeSessionReference | undefined
    try {
      input.signal.throwIfAborted()
      input.owner.assertOwned()
      if (execution.state === 'completed') {
        if (!execution.result) throw new Error('The completed execution has no durable result.')
        try { await this.budgets.finish(execution.id, execution.finishedAt) }
        finally { await this.credentials?.revokeForExecution(execution.id) }
        return { state: 'completed', execution, result: execution.result }
      }
      await this.budgets.ensure(execution.id, input.graphThreadId, this.activeTimeoutMs)
      await this.budgets.assertActive(execution.id)
      // Read the durable reference before resolving a manager: a repository
      // failure must not evict a resident session still needed by run cleanup.
      const existing = execution.nativeSessionId ? await this.interactions.getForExecution(execution.id) : undefined
      context = this.managerContext(execution, input.request.configuration)
      const request = HarnessExecutionRequestSchema.parse({
        ...input.request, executionId: execution.id, runId: execution.runId,
        workflowNodeId: execution.workflowNodeId, workingDirectory: execution.workingDirectory,
        runtimeDirectory: execution.runtimeDirectory, input: execution.input,
      })
      resolved = this.resolveManager(context)
      if (resolved.processState === 'needs_start') resolved.beginStart?.()
      manager = resolved.manager

      const observePending = async (history: NativeHistory): Promise<ApprovalExecutionObservation | undefined> => {
        input.signal.throwIfAborted()
        input.owner.assertOwned()
        const waiting: DurableInteraction[] = []
        for (const pending of history.pendingInteractions) {
          this.assertSessionIdentity(session!, pending.session)
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
            request: pending.request, approval: input.approval, responseOptions: pending.responseOptions,
            status: 'pending', deliveryState: 'not_started', createdAt: now, updatedAt: now,
          }))
          // A provider may briefly report an already-delivered request. Observe
          // its continuation; never offer that delivered interaction as a new ask.
          if (created.interaction.deliveryState !== 'delivered') waiting.push(created.interaction)
          if (created.created) {
            await this.runs.recordActivity(execution.runId, 'harness', 'harness_output', {
              nativeEventType: 'interaction_pending',
              interactionId: created.interaction.id, handler: created.interaction.approval.handler,
            }, execution.id, input.owner.client)
          }
        }
        if (!waiting.length) return undefined
        input.signal.throwIfAborted()
        execution = HarnessExecutionSchema.parse({ ...execution, state: 'waiting' })
        await this.runs.updateExecution(execution, input.owner)
        await this.budgets.beginWait(execution.id)
        return { state: 'waiting', execution, interaction: waiting[0]!, interactions: waiting }
      }

      if (!execution.nativeSessionId) {
        if (!ensured.created) {
          throw new DomainError('NATIVE_SESSION_START_UNCERTAIN', 'The existing execution has no recorded native session. Native side effects will not be replayed.', 409)
        }
        const environment = await this.prepareEnvironment(context, resolved, input.signal)
        session = await manager.createSession({ request, ...(environment ? { environment } : {}) }, input.signal)
        if (session.harness !== context.harness) throw new Error('The created native session has the wrong harness.')
        resolved.markResident?.()
        execution = HarnessExecutionSchema.parse({ ...execution, nativeSessionId: session.nativeSessionId, state: 'running' })
        await this.runs.updateExecution(execution, input.owner)
        for await (const event of manager.startTurn(session, {
          prompt: buildHarnessPrompt(request), clientCorrelationId: `execution:${execution.id}`,
        }, input.signal)) {
          input.signal.throwIfAborted()
          await this.budgets.assertActive(execution.id)
          await this.runs.appendNativeEvent({ ...event, executionId: execution.id }, input.owner)
          const waiting = await observePending(await manager.history(session, input.signal))
          if (waiting) return waiting
        }
      } else {
        session = {
          harness: context.harness,
          providerVersion: existing?.providerVersion ?? (await manager.capabilities(input.signal)).providerVersion,
          nativeSessionId: execution.nativeSessionId,
        }
        if (existing) this.assertSessionIdentity(session, existing)
        const environment = await this.prepareEnvironment(context, resolved, input.signal)
        if (resolved.processState === 'needs_start') {
          const attached = await manager.attachSession(session, {
            kind: 'workflow', correlationId: `execution:${execution.id}`, request,
            ...(environment ? { environment } : {}),
          }, input.signal)
          this.assertSessionIdentity(session, attached)
          resolved.markResident?.()
        }
        // Resident sessions retain their original scoped process credentials.
        // history() below verifies the already-owned exact session, without a
        // redundant attachSession() requiring a newly supplied environment.
      }

      for (;;) {
        input.signal.throwIfAborted()
        input.owner.assertOwned()
        await this.budgets.assertActive(execution.id)
        const history = await manager.history(session, input.signal)
        for (const event of history.events) await this.runs.appendNativeEvent({ ...event, executionId: execution.id }, input.owner)
        const waiting = await observePending(history)
        if (waiting) return waiting
        if (history.terminalResult) {
          execution = HarnessExecutionSchema.parse({
            ...execution, state: 'completed', result: history.terminalResult, finishedAt: new Date().toISOString(),
          })
          await this.runs.updateExecution(execution, input.owner)
          try { await this.budgets.finish(execution.id, execution.finishedAt) }
          finally {
            try { await this.credentials?.revokeForExecution(execution.id) }
            finally {
              await manager.close(session).catch(() => undefined)
              this.managerCredentials.delete(manager)
              this.managers.release?.(context, this.rawManagers.get(manager) ?? manager)
            }
          }
          return { state: 'completed', execution, result: history.terminalResult }
        }
        // Approval delivery is not turn completion. Keep observing the same
        // native turn; neither startTurn nor native responses are replayed here.
        if (execution.state !== 'running') {
          execution = HarnessExecutionSchema.parse({ ...execution, state: 'running' })
          await this.runs.updateExecution(execution, input.owner)
          await this.budgets.resume(execution.id)
        }
        await delay(100, undefined, { signal: input.signal })
      }
    } catch (error) {
      if ((resolved && !manager) || isLeaseLost(error)
        || (error instanceof DomainError && error.code === 'SESSION_LANE_BUSY')) throw error
      try {
        input.owner.assertOwned()
        if (execution.state !== 'completed') {
          const result: ExecutionResult = input.signal.aborted ? { outcome: 'canceled' }
            : error instanceof HarnessExecutionError ? error.result : {
              outcome: 'failed', error: {
                code: error instanceof DomainError ? error.code : 'WORKFLOW_EXECUTION_FAILED',
                message: error instanceof Error ? error.message : 'Unknown workflow execution failure.', retryable: false,
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
        if (manager && session) {
          if (owned) await manager.cancel(session).catch(() => false)
          await manager.close(session).catch(() => undefined)
        }
        if (manager) this.managerCredentials.delete(manager)
        if (context && manager) {
          resolved?.markFailed?.()
          this.managers.release?.(context, this.rawManagers.get(manager) ?? manager, 'failed')
        }
        if (owned) await this.credentials?.revokeForExecution(execution.id).catch(() => undefined)
      }
      throw error
    }
  }
}
