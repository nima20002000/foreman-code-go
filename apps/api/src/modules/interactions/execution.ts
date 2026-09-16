import { randomUUID } from 'node:crypto'

import {
  DurableInteractionSchema,
  HarnessExecutionSchema,
  type DurableInteraction,
  type ExecutionResult,
  type HarnessExecution,
  type HarnessExecutionRequest,
  type WorkflowApprovalConfiguration,
  type AgentConfigurationVersion,
  HarnessExecutionRequestSchema,
} from '@graphql/contracts'

import { WORKER_CREDENTIAL_RENEWAL_WINDOW_MS, type IssuedWorkerCredential } from '../access/workerCredentials.js'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import { buildHarnessPrompt } from '../harnesses/prompt.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { RunOwnership } from '../runs/ownership.js'
import { PostgresApprovalBudgetRepository } from './budget.js'
import { PostgresInteractionRepository } from './postgres.js'
import type {
  AttachedInteractionSession,
  NativeManagerResolutionContext,
  NativeManagerOwnershipContext,
  NativeSessionManagerResolver,
  ResolvedNativeSessionManager,
} from './runtimePorts.js'
import type { ExecutionCredentialProvider } from '../harnesses/mcpDetection.js'

export type ApprovalExecutionObservation =
  | { state: 'waiting'; execution: HarnessExecution; interaction: DurableInteraction }
  | { state: 'completed'; execution: HarnessExecution; result: ExecutionResult }

/** Idempotent ensure/observe boundary called first on every LangGraph node entry. */
export class ApprovalExecutionCoordinator {
  private readonly managerCredentials = new WeakMap<NativeHarnessSessionManager, IssuedWorkerCredential>()

  constructor(
    private readonly runs: PostgresRunRepository,
    private readonly interactions: PostgresInteractionRepository,
    private readonly budgets: PostgresApprovalBudgetRepository,
    private readonly managers: NativeSessionManagerResolver,
    private readonly activeTimeoutMs: number,
    private readonly credentials?: ExecutionCredentialProvider,
  ) {}

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
    return resolved
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
      this.managers.release?.(context, resolved.manager, 'failed')
    }
  }

  async attachInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<AttachedInteractionSession> {
    const execution = await this.runs.getExecution(interaction.executionId)
    if (!execution?.workingDirectory || !execution.runtimeDirectory) throw new Error('The durable execution cannot reconstruct its native session start input.')
    if (execution.agentId !== interaction.requestingAgentId) throw new Error('The interaction requester does not own its durable execution.')
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
      || execution.workingDirectory !== context.workingDirectory) {
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
      const session = await resolved.manager.attachSession(sessionReference, {
        kind: 'workflow', correlationId: `execution:${execution.id}`, request,
        ...(environment ? { environment } : {}),
      }, signal)
      resolved.markResident?.()
      return { manager: resolved.manager, session }
    } catch (error) {
      await this.releaseFailedManager(resolutionContext, resolved, sessionReference).catch(() => undefined)
      throw error
    }
  }

  async cancelRun(runId: string): Promise<void> {
    for (const execution of await this.runs.listExecutions(runId)) {
      await this.budgets.stop(execution.id)
      try {
        if (!execution.nativeSessionId || execution.state === 'completed') continue
        const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
        if (!configuration) continue
        const context = this.managerContext(execution, configuration)
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
        this.managers.release?.(context)
      } finally {
        await this.credentials?.revokeForExecution(execution.id)
      }
    }
    await this.interactions.cancelPendingForRun(runId)
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
    await this.budgets.ensure(execution.id, input.graphThreadId, this.activeTimeoutMs)
    if (execution.state === 'completed') {
      try {
        await this.budgets.finish(execution.id, execution.finishedAt)
      } finally {
        await this.credentials?.revokeForExecution(execution.id)
      }
      return { state: 'completed', execution, result: execution.result! }
    }
    await this.budgets.assertActive(execution.id)

    const existing = await this.interactions.getForExecution(execution.id)
    if (existing && existing.deliveryState !== 'delivered') return { state: 'waiting', execution, interaction: existing }

    const context = this.managerContext(execution, input.request.configuration)
    const resolved = this.resolveManager(context)
    const manager = resolved.manager
    let createdSession = false
    if (!execution.nativeSessionId) {
      if (resolved.lifecycle === 'resident') throw new Error('A resident native process cannot create a replacement session.')
      resolved.beginStart?.()
      let session
      try {
        const environment = await this.prepareEnvironment(context, resolved, input.signal)
        session = await manager.createSession({ request: input.request, ...(environment ? { environment } : {}) }, input.signal)
        resolved.markResident?.()
        createdSession = true
        execution = HarnessExecutionSchema.parse({ ...execution, nativeSessionId: session.nativeSessionId, state: 'running' })
        await this.runs.updateExecution(execution, input.owner)
        for await (const event of manager.startTurn(session, {
          prompt: buildHarnessPrompt(input.request), clientCorrelationId: `execution:${execution.id}`,
        })) {
          await this.runs.appendNativeEvent({ ...event, executionId: execution.id }, input.owner)
          const pending = await manager.pending(session)
          if (!pending) continue
          if (!pending.turn.nativeRequestId) throw new Error('Native approval request is missing its stable request identity.')
          const now = new Date().toISOString()
          const created = await this.interactions.create(DurableInteractionSchema.parse({
            id: `interaction-${randomUUID()}`, revision: 0,
            workspaceId: input.request.workspaceId, workflowId: input.workflowId,
            runId: execution.runId, executionId: execution.id, requestingAgentId: execution.agentId,
            harness: session.harness, providerVersion: session.providerVersion,
            nativeSessionId: session.nativeSessionId, nativeRequestId: pending.turn.nativeRequestId,
            nativeRequestType: pending.nativeRequestType, graphThreadId: input.graphThreadId,
            request: pending.request, approval: input.approval, responseOptions: pending.responseOptions,
            status: 'pending', deliveryState: 'not_started', createdAt: now, updatedAt: now,
          }))
          execution = HarnessExecutionSchema.parse({ ...execution, state: 'waiting' })
          await this.runs.updateExecution(execution, input.owner)
          await this.budgets.beginWait(execution.id)
          return { state: 'waiting', execution, interaction: created.interaction }
        }
      } catch (error) {
        await this.releaseFailedManager(context, resolved, session).catch(() => undefined)
        throw error
      }
    }

    const session = {
      harness: input.request.configuration.harness.harness,
      providerVersion: existing?.providerVersion ?? (await manager.capabilities()).providerVersion,
      nativeSessionId: execution.nativeSessionId!,
    }
    if (!createdSession) {
      if (resolved.processState === 'needs_start') resolved.beginStart?.()
      try {
        const environment = await this.prepareEnvironment(context, resolved, input.signal)
        await manager.attachSession(session, {
          kind: 'workflow', correlationId: `execution:${execution.id}`, request: input.request,
          ...(environment ? { environment } : {}),
        }, input.signal)
        resolved.markResident?.()
      } catch (error) {
        await this.releaseFailedManager(context, resolved, session).catch(() => undefined)
        if (existing) return { state: 'waiting', execution, interaction: existing }
        throw error
      }
    }
    let history
    try {
      history = await manager.history(session)
      for (const event of history.events) await this.runs.appendNativeEvent({ ...event, executionId: execution.id }, input.owner)
    } catch (error) {
      await this.releaseFailedManager(context, resolved, session).catch(() => undefined)
      throw error
    }
    if (history.pendingInteractions.length) {
      const interaction = await this.interactions.getForExecution(execution.id)
      if (!interaction) throw new Error('Native pending request has no durable interaction.')
      return { state: 'waiting', execution, interaction }
    }
    if (!history.terminalResult) {
      await this.credentials?.revokeForExecution(execution.id)
      throw new Error('Native execution is neither waiting nor terminal.')
    }
    execution = HarnessExecutionSchema.parse({
      ...execution, state: 'completed', result: history.terminalResult, finishedAt: new Date().toISOString(),
    })
    await this.runs.updateExecution(execution, input.owner)
    try {
      await this.budgets.finish(execution.id, execution.finishedAt)
    } finally {
      try {
        await this.credentials?.revokeForExecution(execution.id)
      } finally {
        await manager.close(session).catch(() => undefined)
        this.managerCredentials.delete(manager)
        this.managers.release?.(context, manager)
      }
    }
    return { state: 'completed', execution, result: history.terminalResult }
  }
}
