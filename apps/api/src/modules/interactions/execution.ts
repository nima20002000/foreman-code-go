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
  type NativeSessionReference,
} from '@graphql/contracts'

import type { NativeSessionManagerResolver } from './service.js'
import { buildHarnessPrompt } from '../harnesses/prompt.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { RunOwnership } from '../runs/ownership.js'
import { PostgresApprovalBudgetRepository } from './budget.js'
import { PostgresInteractionRepository } from './postgres.js'

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
  ) {}

  async attachInteraction(interaction: DurableInteraction): Promise<NativeSessionReference> {
    const execution = await this.runs.getExecution(interaction.executionId)
    if (!execution?.workingDirectory || !execution.runtimeDirectory) throw new Error('The durable execution cannot reconstruct its native session start input.')
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
    if (!configuration) throw new Error('The durable execution configuration is unavailable.')
    const request = HarnessExecutionRequestSchema.parse({
      executionId: execution.id, runId: execution.runId, workspaceId: interaction.workspaceId,
      workflowNodeId: execution.workflowNodeId, workingDirectory: execution.workingDirectory,
      runtimeDirectory: execution.runtimeDirectory, configuration, input: execution.input,
    })
    return this.managers.resolve(interaction.harness).attachSession({
      harness: interaction.harness, providerVersion: interaction.providerVersion,
      nativeSessionId: interaction.nativeSessionId,
    }, { kind: 'workflow', correlationId: `execution:${execution.id}`, request })
  }

  async cancelRun(runId: string): Promise<void> {
    for (const execution of await this.runs.listExecutions(runId)) {
      await this.budgets.stop(execution.id)
      if (!execution.nativeSessionId || execution.state === 'completed') continue
      const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
      if (!configuration) continue
      const manager = this.managers.resolve(configuration.harness.harness)
      await manager.cancel({
        harness: configuration.harness.harness,
        providerVersion: (await manager.capabilities()).providerVersion,
        nativeSessionId: execution.nativeSessionId,
      }).catch(() => false)
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
  }): Promise<ApprovalExecutionObservation> {
    const ensured = await this.runs.ensureExecution(input.candidate, input.owner)
    let execution = ensured.execution
    await this.budgets.ensure(execution.id, input.graphThreadId, this.activeTimeoutMs)
    await this.budgets.assertActive(execution.id)
    if (execution.state === 'completed') return { state: 'completed', execution, result: execution.result! }

    const existing = await this.interactions.getForExecution(execution.id)
    if (existing && existing.deliveryState !== 'delivered') return { state: 'waiting', execution, interaction: existing }

    const manager = this.managers.resolve(input.request.configuration.harness.harness)
    let createdSession = false
    if (!execution.nativeSessionId) {
      const session = await manager.createSession({ request: input.request })
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
    }

    const session = {
      harness: input.request.configuration.harness.harness,
      providerVersion: existing?.providerVersion ?? (await manager.capabilities()).providerVersion,
      nativeSessionId: execution.nativeSessionId!,
    }
    if (!createdSession) {
      try {
        await manager.attachSession(session, {
          kind: 'workflow', correlationId: `execution:${execution.id}`, request: input.request,
        })
      } catch (error) {
        if (existing) return { state: 'waiting', execution, interaction: existing }
        throw error
      }
    }
    const history = await manager.history(session)
    if (history.pendingInteractions.length) {
      const interaction = await this.interactions.getForExecution(execution.id)
      if (!interaction) throw new Error('Native pending request has no durable interaction.')
      return { state: 'waiting', execution, interaction }
    }
    if (!history.terminalResult) throw new Error('Native execution is neither waiting nor terminal.')
    execution = HarnessExecutionSchema.parse({
      ...execution, state: 'completed', result: history.terminalResult, finishedAt: new Date().toISOString(),
    })
    await this.runs.updateExecution(execution, input.owner)
    return { state: 'completed', execution, result: history.terminalResult }
  }
}
