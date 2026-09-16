import { randomUUID } from 'node:crypto'

import {
  DurableInteractionSchema,
  HarnessExecutionSchema,
  type DurableInteraction,
  type ExecutionResult,
  type HarnessExecution,
  type HarnessExecutionRequest,
  type WorkflowApprovalConfiguration,
  HarnessExecutionRequestSchema,
} from '@graphql/contracts'

import { buildHarnessPrompt } from '../harnesses/prompt.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { RunOwnership } from '../runs/ownership.js'
import { PostgresApprovalBudgetRepository } from './budget.js'
import { PostgresInteractionRepository } from './postgres.js'
import type {
  AttachedInteractionSession,
  ExecutionCredentialProvider,
  NativeManagerResolutionContext,
  NativeSessionManagerResolver,
} from './runtimePorts.js'

export type ApprovalExecutionObservation =
  | { state: 'waiting'; execution: HarnessExecution; interaction: DurableInteraction }
  | { state: 'completed'; execution: HarnessExecution; result: ExecutionResult }

/** Idempotent ensure/observe boundary called first on every LangGraph node entry. */
export class ApprovalExecutionCoordinator {
  constructor(
    private readonly runs: PostgresRunRepository,
    private readonly interactions: PostgresInteractionRepository,
    private readonly budgets: PostgresApprovalBudgetRepository,
    private readonly managers: NativeSessionManagerResolver,
    private readonly activeTimeoutMs: number,
    private readonly credentials?: ExecutionCredentialProvider,
  ) {}

  private managerContext(execution: HarnessExecution, harness: NativeManagerResolutionContext['harness']): NativeManagerResolutionContext {
    if (!execution.workingDirectory) throw new Error('The durable execution has no accepted working directory.')
    return {
      harness, executionId: execution.id, agentId: execution.agentId,
      workingDirectory: execution.workingDirectory,
    }
  }

  private resolveManager(context: NativeManagerResolutionContext) {
    const resolved = this.managers.resolve(context)
    if (resolved.manager.harness !== context.harness) {
      throw new Error('The resolved native manager does not match the durable execution harness.')
    }
    return resolved
  }

  private async prepareEnvironment(context: NativeManagerResolutionContext, signal?: AbortSignal) {
    if (!this.credentials) return undefined
    const prepared = await this.credentials.prepare({
      executionId: context.executionId, harness: context.harness, workingDirectory: context.workingDirectory,
      ...(signal ? { signal } : {}),
    })
    return prepared.credential.environment
  }

  async attachInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<AttachedInteractionSession> {
    const execution = await this.runs.getExecution(interaction.executionId)
    if (!execution?.workingDirectory || !execution.runtimeDirectory) throw new Error('The durable execution cannot reconstruct its native session start input.')
    if (execution.agentId !== interaction.requestingAgentId) throw new Error('The interaction requester does not own its durable execution.')
    const context = this.managerContext(execution, interaction.harness)
    return this.attachOwnedSession(context, {
      harness: interaction.harness, providerVersion: interaction.providerVersion,
      nativeSessionId: interaction.nativeSessionId,
    }, signal)
  }

  async attachOwnedSession(
    context: NativeManagerResolutionContext,
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
    const request = HarnessExecutionRequestSchema.parse({
      executionId: execution.id, runId: execution.runId, workspaceId: run.workspaceId,
      workflowNodeId: execution.workflowNodeId, workingDirectory: execution.workingDirectory,
      runtimeDirectory: execution.runtimeDirectory, configuration, input: execution.input,
    })
    const resolved = this.resolveManager(context)
    const environment = resolved.processState === 'needs_start'
      ? await this.prepareEnvironment(context, signal) : undefined
    try {
      const session = await resolved.manager.attachSession(sessionReference, {
        kind: 'workflow', correlationId: `execution:${execution.id}`, request,
        ...(environment ? { environment } : {}),
      }, signal)
      return { manager: resolved.manager, session }
    } catch (error) {
      if (environment) await this.credentials?.revokeForExecution(execution.id).catch(() => undefined)
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
        const resolved = this.resolveManager(this.managerContext(execution, configuration.harness.harness))
        if (resolved.processState === 'resident') {
          const session = {
            harness: configuration.harness.harness,
            providerVersion: (await resolved.manager.capabilities()).providerVersion,
            nativeSessionId: execution.nativeSessionId,
          }
          await resolved.manager.cancel(session).catch(() => false)
          await resolved.manager.close(session).catch(() => undefined)
        }
        this.managers.release?.(this.managerContext(execution, configuration.harness.harness))
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
    await this.budgets.assertActive(execution.id)
    if (execution.state === 'completed') {
      await this.credentials?.revokeForExecution(execution.id)
      return { state: 'completed', execution, result: execution.result! }
    }

    const existing = await this.interactions.getForExecution(execution.id)
    if (existing && existing.deliveryState !== 'delivered') return { state: 'waiting', execution, interaction: existing }

    const context = this.managerContext(execution, input.request.configuration.harness.harness)
    const resolved = this.resolveManager(context)
    const manager = resolved.manager
    let createdSession = false
    if (!execution.nativeSessionId) {
      const environment = await this.prepareEnvironment(context, input.signal)
      let session
      try {
        session = await manager.createSession({ request: input.request, ...(environment ? { environment } : {}) }, input.signal)
        createdSession = true
        execution = HarnessExecutionSchema.parse({ ...execution, nativeSessionId: session.nativeSessionId, state: 'running' })
        await this.runs.updateExecution(execution, input.owner)
        for await (const event of manager.startTurn(session, {
          prompt: buildHarnessPrompt(input.request), clientCorrelationId: `execution:${execution.id}`,
        })) {
          await this.runs.recordActivity(execution.runId, 'harness', 'harness_output', {
            nativeEventType: event.type, ...event.payload,
          }, execution.id, input.owner.client)
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
          await this.runs.recordActivity(execution.runId, 'harness', 'harness_output', {
            nativeEventType: 'interaction_pending',
            interactionId: created.interaction.id, handler: created.interaction.approval.handler,
          }, execution.id, input.owner.client)
          return { state: 'waiting', execution, interaction: created.interaction }
        }
      } catch (error) {
        if (environment) await this.credentials?.revokeForExecution(execution.id).catch(() => undefined)
        throw error
      }
    }

    const session = {
      harness: input.request.configuration.harness.harness,
      providerVersion: existing?.providerVersion ?? (await manager.capabilities()).providerVersion,
      nativeSessionId: execution.nativeSessionId!,
    }
    if (!createdSession) {
      const environment = resolved.processState === 'needs_start'
        ? await this.prepareEnvironment(context, input.signal) : undefined
      try {
        await manager.attachSession(session, {
          kind: 'workflow', correlationId: `execution:${execution.id}`, request: input.request,
          ...(environment ? { environment } : {}),
        }, input.signal)
      } catch (error) {
        if (environment) await this.credentials?.revokeForExecution(execution.id).catch(() => undefined)
        if (existing) return { state: 'waiting', execution, interaction: existing }
        throw error
      }
    }
    let history
    try {
      history = await manager.history(session)
    } catch (error) {
      await this.credentials?.revokeForExecution(execution.id).catch(() => undefined)
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
    await this.credentials?.revokeForExecution(execution.id)
    await manager.close(session).catch(() => undefined)
    this.managers.release?.(context)
    return { state: 'completed', execution, result: history.terminalResult }
  }
}
