import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type pg from 'pg'

import {
  ExecutionLocationSchema, type AgentConfigurationVersion, type HarnessExecution, type ExecutionResult, type NativeHarnessEvent, type NativeSessionReference,
} from '@graphql/contracts'
import {
  AgentChatStateSchema, AgentChatStreamEventSchema, SendAgentChatMessageRequestSchema,
  type AgentChatBlockedReason, type AgentChatCapabilities, type AgentChatContext, type AgentChatOrigin, type AgentChatQuery,
  type AgentChatSessionState, type AgentChatState, type AgentChatStreamEvent, type AgentChatTurn, type SendAgentChatMessageRequest,
} from '@graphql/contracts/agent-chat'
import type { ManagementAction, ManagementPrincipal } from '@graphql/contracts/management'

import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { NativeTurnNotActiveError } from '../harnesses/errors.js'
import type { NativeHarnessSessionManager, WorkflowNativeSessionStart } from '../harnesses/port.js'
import { nativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { resolvedSkillPrompt } from '../skills/prompt.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import { PostgresOperatorActivityRepository } from './operatorActivityRepository.js'
import { currentOperatorHistory, openCodeTurnEvents, operatorActivity } from './operatorActivity.js'
import type { PostgresOperatorConversationRepository } from './operatorChatRepository.js'
import { completedNativeAssistantMessage, nativeAssistantText } from './operatorText.js'
import {
  agentChatCorrelation, agentChatKey, agentConversation, type AgentConversationRow, type AgentChatInterruptTarget, type NewAgentConversation, PostgresAgentChatRepository,
} from './agentChatRepository.js'

/** One native manager per conversation; its process is owned by this service, never by a UI connection. */
export interface AgentChatManagerFactory {
  (conversationId: string, configuration: AgentConfigurationVersion, workingDirectory: string): NativeHarnessSessionManager
  release?(conversationId: string): void
}

export class AgentChatEvents {
  private sequence = 0
  private readonly listeners = new Map<string, Set<(event: AgentChatStreamEvent) => void>>()
  publish(conversationId: string, type: AgentChatStreamEvent['type'], data: Record<string, unknown>) {
    const event = AgentChatStreamEventSchema.parse({ id: this.sequence++, conversationId, type, data })
    for (const listener of this.listeners.get(conversationId) ?? []) {
      try { listener(event) } catch { /* A disconnected subscriber cannot fail a native turn. */ }
    }
  }
  subscribe(id: string, listener: (event: AgentChatStreamEvent) => void) {
    const listeners = this.listeners.get(id) ?? new Set()
    listeners.add(listener); this.listeners.set(id, listeners)
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id) }
  }
}

interface Runtime {
  manager: NativeHarnessSessionManager
  session?: NativeSessionReference
  configuration: AgentConfigurationVersion
}

interface Resolution {
  context: AgentChatContext
  row?: AgentConversationRow
  blocked?: { reason: AgentChatBlockedReason; message: string }
  /** How a first message would create its native session. */
  create?: Omit<NewAgentConversation, 'context'>
  configuration?: AgentConfigurationVersion
}

const TERMINAL_RUN_STATES = new Set(['completed', 'interrupted'])
const OPENCODE_STEER_REASON = 'OpenCode cannot add input to a running turn with a turn precondition. Queue it for the next turn or interrupt and send.'

function failure(error: unknown, code = 'AGENT_CHAT_TURN_FAILED'): ExecutionResult {
  const provider = error && typeof error === 'object' && 'result' in error ? (error as { result?: ExecutionResult }).result?.error : undefined
  return { outcome: 'failed', error: { code: provider?.code ?? code,
    message: provider?.message ?? (error instanceof Error ? error.message : 'The native turn failed.'), retryable: true } }
}
function definiteRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('certainty' in error) return error.certainty === 'definite'
  return 'uncertain' in error && error.uncertain === false
}
function sessionMissing(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'result' in error ? (error as { result?: ExecutionResult }).result?.error?.code : undefined
  return Boolean(code && /SESSION_NOT_FOUND|THREAD_NOT_FOUND|SESSION_ID_MISMATCH|SETTING_UNSUPPORTED|VERSION_MISMATCH/.test(code))
}

export class AgentChatService {
  readonly events = new AgentChatEvents()
  private readonly runtimes = new Map<string, Runtime>()
  private readonly tasks = new Map<string, Promise<void>>()
  private readonly wakeups = new Set<string>()
  private readonly controls = new Map<string, Promise<unknown>>()
  private readonly reconciliationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly activity: PostgresOperatorActivityRepository
  private readonly lifetime = new AbortController()
  private closing = false

  constructor(
    private readonly pool: pg.Pool,
    private readonly repository: PostgresAgentChatRepository,
    private readonly messages: PostgresOperatorConversationRepository,
    private readonly workflows: Pick<PostgresWorkflowRepository, 'getSavedVersion' | 'getCurrentSavedVersion' | 'getAgentConfiguration'>,
    /** Read-only: chat never writes Runs, executions or their native lanes. */
    private readonly runs: Pick<PostgresRunRepository, 'getForWorkspace' | 'executionPages'>,
    private readonly managers: AgentChatManagerFactory,
    private readonly runtimeRoot: string,
  ) {
    this.activity = new PostgresOperatorActivityRepository(pool)
  }

  /** Serialize native lifecycle decisions per conversation. */
  private control<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.controls.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.controls.set(id, next)
    void next.finally(() => { if (this.controls.get(id) === next) this.controls.delete(id) }).catch(() => undefined)
    return next
  }
  private assertOpen() {
    if (this.closing) throw new DomainError('AGENT_CHAT_CLOSING', 'Agent chat is shutting down.', 503)
  }
  private authorize(principal: ManagementPrincipal, action: ManagementAction, context: Pick<AgentChatContext, 'workspaceId' | 'workflowId' | 'runId'>) {
    requireAuthorization(principal, action, { workspaceId: context.workspaceId, workflowId: context.workflowId, ...(context.runId ? { runId: context.runId } : {}) })
  }
  private async conversation(workspaceId: string, id: string, principal: ManagementPrincipal, action: ManagementAction) {
    const row = await this.repository.get(id)
    if (!row || row.workspace_id !== workspaceId) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
    this.authorize(principal, action, { workspaceId, workflowId: row.workflow_id, ...(row.origin_run_id ? { runId: row.origin_run_id } : {}) })
    return row
  }

  // ---------------------------------------------------------------- context

  private async resolve(context: AgentChatContext): Promise<Resolution> {
    const key = agentChatKey(context)
    const row = await this.repository.byKey(key)
    const blocked = (reason: AgentChatBlockedReason, message: string): Resolution => ({ context, ...(row ? { row } : {}), blocked: { reason, message } })
    if (context.runId) {
      const run = await this.runs.getForWorkspace(context.workspaceId, context.runId).catch(() => undefined)
      if (!run || run.workflowId !== context.workflowId) return blocked('context_stale', 'The selected Run does not belong to this workflow.')
      const version = await this.workflows.getSavedVersion(run.workflowVersionId)
      if (!version?.definition.nodes.some((node) => node.id === context.workflowNodeId && node.agentId === context.agentId)) {
        return blocked('agent_missing', 'This Agent is not part of the selected Run.')
      }
      if (!TERMINAL_RUN_STATES.has(run.executionState)) {
        return blocked('run_active', 'This Agent belongs to a Run that is still working. Chat opens when the Run finishes.')
      }
      let source: HarnessExecution | undefined
      for await (const page of this.runs.executionPages(run.id)) {
        for (const execution of page) {
          if (execution.workflowNodeId === context.workflowNodeId && execution.agentId === context.agentId
            && execution.nativeSessionId && (!source || execution.attempt > source.attempt)) source = execution
        }
      }
      if (row) {
        const configuration = await this.workflows.getAgentConfiguration(row.agent_configuration_version_id)
        return { context, row, ...(configuration ? { configuration } : {}),
          ...(row.record.sessionUnavailable ? { blocked: { reason: 'native_session_missing' as const, message: row.record.sessionUnavailable } } : {}) }
      }
      if (!source?.nativeSessionId || !source.workingDirectory) {
        return blocked('native_session_missing', 'This Run has no stored native session for this Agent. Chat with the Agent outside the Run instead.')
      }
      const configuration = await this.workflows.getAgentConfiguration(source.agentConfigurationVersionId)
      if (!configuration) return blocked('agent_missing', 'The Agent configuration used by this Run is unavailable.')
      return { context, configuration, create: {
        agentConfigurationVersionId: configuration.id, harness: configuration.harness.harness,
        origin: { kind: 'run_execution', runId: run.id, executionId: source.id, sourceNativeSessionId: source.nativeSessionId },
        workingDirectory: source.workingDirectory, runtimeDirectory: '',
      } }
    }
    const version = await this.workflows.getCurrentSavedVersion(context.workspaceId, context.workflowId)
    if (!version) return blocked('context_stale', 'The workflow was not found.')
    if (!version.definition.nodes.some((node) => node.id === context.workflowNodeId && node.agentId === context.agentId)) {
      return blocked('agent_missing', 'This Agent is no longer part of the saved workflow.')
    }
    if (row) {
      const configuration = await this.workflows.getAgentConfiguration(row.agent_configuration_version_id)
      return { context, row, ...(configuration ? { configuration } : {}),
        ...(row.record.sessionUnavailable ? { blocked: { reason: 'native_session_missing' as const, message: row.record.sessionUnavailable } } : {}) }
    }
    const agent = (await this.pool.query<{ current_configuration_version_id: string | null; archived_at: Date | null }>(
      'select current_configuration_version_id,archived_at from agents where workspace_id=$1 and id=$2', [context.workspaceId, context.agentId])).rows[0]
    if (!agent || agent.archived_at || !agent.current_configuration_version_id) return blocked('agent_missing', 'This Agent has no saved configuration.')
    const configuration = await this.workflows.getAgentConfiguration(agent.current_configuration_version_id)
    if (!configuration) return blocked('agent_missing', 'This Agent has no saved configuration.')
    const workspace = (await this.pool.query<{ execution_location: unknown }>('select execution_location from workspaces where id=$1', [context.workspaceId])).rows[0]
    const location = ExecutionLocationSchema.safeParse(workspace?.execution_location)
    if (!location.success) return blocked('execution_location_missing', 'Set a workspace folder before chatting with this Agent.')
    return { context, configuration, create: {
      agentConfigurationVersionId: configuration.id, harness: configuration.harness.harness, origin: { kind: 'fresh' },
      workingDirectory: location.data.rootPath, runtimeDirectory: '',
    } }
  }

  private capabilities(configuration: AgentConfigurationVersion | undefined, row?: AgentConversationRow): AgentChatCapabilities {
    const harness = configuration?.harness.harness ?? row?.harness ?? 'codex'
    const providerVersion = row?.provider_version ?? null
    const ephemeral = configuration?.harness.harness === 'codex' && configuration.harness.advanced?.sessionPersistence === 'ephemeral'
    if (harness === 'codex') {
      return { harness, providerVersion, steer: 'native_expected_turn', interruptAndSend: true, queueNextTurn: true, resume: !ephemeral,
        unavailable: ephemeral ? { resume: 'This Agent uses ephemeral Codex sessions, which cannot continue after the API restarts.' } : {} }
    }
    return { harness, providerVersion, steer: 'unavailable', interruptAndSend: true, queueNextTurn: true, resume: true,
      unavailable: { steer: OPENCODE_STEER_REASON } }
  }

  private sessionState(row: AgentConversationRow | undefined): AgentChatSessionState {
    if (!row) return 'none'
    if (row.record.sessionUnavailable) return 'unavailable'
    switch (row.turn_state) {
      case 'starting': return row.native_session_id ? 'active' : 'creating'
      case 'active': return row.pending_interaction ? 'waiting_approval' : 'active'
      case 'canceling': return 'interrupting'
      case 'uncertain': return row.active_request_id ? 'uncertain' : 'idle'
      case 'error': return 'error'
      default: return 'idle'
    }
  }

  private async state(resolution: Resolution): Promise<AgentChatState> {
    const { context, blocked } = resolution
    const capabilities = this.capabilities(resolution.configuration, resolution.row)
    const availability = blocked ? { canSend: false, reason: blocked.reason, message: blocked.message } : { canSend: true }
    if (!resolution.row) {
      return AgentChatStateSchema.parse({ context, conversation: null, sessionState: 'none', availability, capabilities,
        activeTurn: null, turns: [], messages: [], hasEarlierMessages: false, activities: [], revision: 0 })
    }
    const loaded = await this.repository.state(resolution.row.id)
    if (!loaded) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
    const { row } = loaded
    const activities = (await this.activity.page(row.id, { limit: 100 })).activities
    return AgentChatStateSchema.parse({
      context, conversation: agentConversation(row), sessionState: this.sessionState(row), availability, capabilities,
      activeTurn: row.active_request_id ? { requestId: row.active_request_id,
        ...(row.active_native_turn_id ? { nativeTurnId: row.active_native_turn_id } : {}), startedAt: row.updated_at.toISOString() } : null,
      turns: loaded.turns, messages: loaded.messages, hasEarlierMessages: loaded.hasEarlierMessages, activities,
      ...(row.pending_interaction ? { pendingInteraction: row.pending_interaction } : {}),
      ...(row.last_result ? { lastResult: row.last_result } : {}),
      revision: Number(row.revision),
    })
  }

  async read(principal: ManagementPrincipal, workspaceId: string, query: AgentChatQuery): Promise<AgentChatState> {
    const context: AgentChatContext = { workspaceId, ...query }
    this.authorize(principal, 'agent_chat:read', context)
    return this.state(await this.resolve(context))
  }
  async readConversation(principal: ManagementPrincipal, workspaceId: string, id: string): Promise<AgentChatState> {
    const row = await this.conversation(workspaceId, id, principal, 'agent_chat:read')
    const context: AgentChatContext = { workspaceId, workflowId: row.workflow_id, workflowNodeId: row.workflow_node_id,
      agentId: row.agent_id, ...(row.origin_run_id ? { runId: row.origin_run_id } : {}) }
    return this.state(await this.resolve(context))
  }
  async history(principal: ManagementPrincipal, workspaceId: string, id: string, before: string | undefined, limit: number) {
    await this.conversation(workspaceId, id, principal, 'agent_chat:read')
    return { conversationId: id, ...await this.repository.history(id, before, limit) }
  }
  async assertReadable(principal: ManagementPrincipal, workspaceId: string, id: string) {
    await this.conversation(workspaceId, id, principal, 'agent_chat:read')
  }

  // ---------------------------------------------------------------- commands

  async send(principal: ManagementPrincipal, workspaceId: string, value: SendAgentChatMessageRequest) {
    this.assertOpen()
    const input = SendAgentChatMessageRequestSchema.parse(value)
    const context: AgentChatContext = { workspaceId, ...input.context }
    this.authorize(principal, 'agent_chat:write', context)
    const resolution = await this.resolve(context)
    const key = agentChatKey(context)
    if (resolution.row) {
      const prior = await this.repository.turn(resolution.row.id, input.requestId)
      if (prior) {
        // Same key and input returns the stored receipt; a different input is a conflict. Never re-sends.
        const admitted = await this.repository.admit({ key, request: input, context, delivery: 'queued' })
        return { state: await this.state(await this.resolve(context)), turn: admitted.turn, replayed: true }
      }
    }
    if (resolution.blocked) {
      throw new DomainError(resolution.blocked.reason === 'context_stale' ? 'AGENT_CHAT_CONTEXT_STALE' : 'AGENT_CHAT_UNAVAILABLE',
        resolution.blocked.message, 409, { reason: resolution.blocked.reason })
    }
    const row = resolution.row
    if (input.intent === 'steer') return this.steer(principal, context, key, input, resolution)
    if (input.intent === 'interrupt_and_send' && !row) throw new DomainError('AGENT_CHAT_TURN_NOT_ACTIVE', 'There is no active turn to interrupt.', 409)
    const create = resolution.create ? { ...resolution.create, context } : undefined
    const admitted = await this.repository.admit({ key, request: input, context, delivery: 'queued', ...(create ? { create } : {}) })
    if (admitted.replayed) return { state: await this.state(await this.resolve(context)), turn: admitted.turn, replayed: true }
    this.events.publish(admitted.conversationId, 'turn', { requestId: input.requestId, delivery: admitted.turn.delivery })
    if (input.intent === 'interrupt_and_send') await this.interruptActive(admitted.conversationId, false, admitted.interruptTarget)
    this.pump(admitted.conversationId)
    return { state: await this.state(await this.resolve(context)), turn: admitted.turn, replayed: false }
  }

  private async steer(_principal: ManagementPrincipal, context: AgentChatContext, key: string, input: SendAgentChatMessageRequest, resolution: Resolution) {
    const row = resolution.row
    const runtime = row ? this.runtimes.get(row.id) : undefined
    if (!row || !row.active_request_id || !row.active_native_turn_id || !runtime?.session) {
      throw new DomainError('AGENT_CHAT_TURN_NOT_ACTIVE', 'There is no active turn to steer. Send it as the next turn instead.', 409)
    }
    if (!runtime.manager.steerTurn) {
      throw new DomainError('AGENT_CHAT_STEER_UNAVAILABLE', OPENCODE_STEER_REASON, 409)
    }
    if (input.expectedNativeTurnId !== row.active_native_turn_id) {
      throw new DomainError('AGENT_CHAT_TURN_NOT_ACTIVE', 'The turn you steered already finished. Send it as the next turn instead.', 409)
    }
    const target = input.expectedNativeTurnId
    return this.control(row.id, async () => {
      const admitted = await this.repository.admit({ key, request: input, context, delivery: 'submitting', targetNativeTurnId: target })
      if (admitted.replayed) return { state: await this.state(await this.resolve(context)), turn: admitted.turn, replayed: true }
      try {
        const steered = await runtime.manager.steerTurn!(runtime.session!, {
          prompt: input.content, clientCorrelationId: agentChatCorrelation(row.id, input.requestId), expectedTurnId: target,
        }, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]))
        if (steered.nativeTurnId !== target) throw new Error('The provider acknowledged a different steer target.')
        await this.repository.steerAccepted(row.id, input.requestId, steered.nativeTurnId)
      } catch (error) {
        if (error instanceof NativeTurnNotActiveError || definiteRejection(error)) {
          await this.repository.discard(row.id, input.requestId)
          throw new DomainError('AGENT_CHAT_TURN_NOT_ACTIVE', 'The turn finished before the steer arrived. Send it as the next turn instead.', 409)
        }
        await this.repository.unknown(row.id, input.requestId, error instanceof Error ? error.message : 'Steer delivery is unconfirmed.')
      }
      this.events.publish(row.id, 'turn', { requestId: input.requestId })
      const turn = (await this.repository.turn(row.id, input.requestId))!
      return { state: await this.state(await this.resolve(context)), turn, replayed: false }
    })
  }

  async interrupt(principal: ManagementPrincipal, workspaceId: string, id: string, expectedNativeTurnId?: string): Promise<AgentChatState> {
    this.assertOpen()
    await this.conversation(workspaceId, id, principal, 'agent_chat:cancel')
    // Stop cancels the queue and captures the active target in one transaction.
    const target = await this.repository.interrupt(id, expectedNativeTurnId)
    await this.interruptActive(id, true, target)
    return this.readConversation(principal, workspaceId, id)
  }
  async cancelQueued(principal: ManagementPrincipal, workspaceId: string, id: string, turnRequestId: string): Promise<AgentChatState> {
    await this.conversation(workspaceId, id, principal, 'agent_chat:cancel')
    if (!await this.repository.cancelQueued(id, turnRequestId)) {
      const turn = await this.repository.turn(id, turnRequestId)
      if (!turn) throw new DomainError('AGENT_CHAT_TURN_NOT_FOUND', 'That message was not found.', 404)
      if (turn.delivery !== 'canceled') throw new DomainError('AGENT_CHAT_TURN_STARTED', 'That message was already sent to the Agent.', 409)
    }
    this.events.publish(id, 'turn', { requestId: turnRequestId, delivery: 'canceled' })
    this.pump(id)
    return this.readConversation(principal, workspaceId, id)
  }
  async respond(principal: ManagementPrincipal, workspaceId: string, id: string, nativeRequestId: string, optionId: string): Promise<AgentChatState> {
    this.assertOpen()
    await this.control(id, async () => {
      // Re-read after earlier controls: the displayed approval may already have been answered.
      const row = await this.conversation(workspaceId, id, principal, 'agent_chat:respond')
      const pending = row.pending_interaction
      const runtime = this.runtimes.get(id)
      if (!pending || pending.turn.nativeRequestId !== nativeRequestId || !runtime?.session || !row.active_request_id) {
        throw new DomainError('AGENT_CHAT_INTERACTION_NOT_PENDING', 'This approval is no longer pending.', 409)
      }
      const option = pending.responseOptions.find((entry) => entry.optionId === optionId)
      if (!option) throw new DomainError('AGENT_CHAT_INTERACTION_OPTION_INVALID', 'That option was not offered.', 422)
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)])
      await runtime.manager.respond(runtime.session, nativeRequestId, option, signal)
      // Other approvals may already be waiting without another native event to expose them.
      const next = await runtime.manager.pending(runtime.session, signal)
      await this.repository.pending(id, row.active_request_id, next)
      this.events.publish(id, 'state', { pending: Boolean(next) })
    })
    return this.readConversation(principal, workspaceId, id)
  }

  private async interruptActive(id: string, explicit: boolean, target: AgentChatInterruptTarget | undefined): Promise<void> {
    if (!target) return
    await this.control(id, async () => {
      const row = await this.repository.get(id)
      if (!row || row.active_request_id !== target.requestId || !row.cancel_requested
        || (target.nativeTurnId && row.active_native_turn_id !== target.nativeTurnId)) return
      this.scheduleReconcile(id)
      this.events.publish(id, 'state', { requestId: target.requestId, sessionState: 'interrupting', explicit })
      const runtime = this.runtimes.get(id)
      if (!runtime?.session || !row.active_native_turn_id) return // Submission path observes cancel_requested.
      try {
        await runtime.manager.cancel(runtime.session, AbortSignal.timeout(10_000), row.active_native_turn_id)
      } catch (error) {
        this.events.publish(id, 'error', { message: error instanceof Error ? error.message : 'Interrupt delivery failed.' })
      }
    })
  }

  // ---------------------------------------------------------------- turn execution

  /** Start the next queued turn when the conversation is idle. Safe to call repeatedly. */
  private pump(id: string): void {
    if (this.closing) return
    if (this.tasks.has(id)) { this.wakeups.add(id); return }
    const task = (async () => {
      for (;;) {
        if (this.closing) return
        this.wakeups.delete(id) // This queue scan services admissions already observed.
        const next = await this.repository.nextQueued(id)
        if (!next) return
        // Claims cannot overtake a fenced native interrupt. A canceled selection is not a busy queue.
        if (!await this.control(id, () => this.repository.claim(id, next.requestId))) {
          const row = await this.repository.get(id)
          if (!row || row.active_request_id) return
          continue
        }
        this.events.publish(id, 'turn', { requestId: next.requestId, delivery: 'submitting' })
        await this.runTurn(id, next)
      }
    })().catch((error: unknown) => {
      this.events.publish(id, 'error', { message: error instanceof Error ? error.message : 'Agent chat delivery failed.' })
    }).finally(() => {
      this.tasks.delete(id)
      this.scheduleReconcile(id)
      // An admission may have seen this task after its empty-queue read but before teardown.
      if (this.wakeups.delete(id)) this.pump(id)
    })
    this.tasks.set(id, task)
  }

  private startInput(row: AgentConversationRow, configuration: AgentConfigurationVersion, correlationId: string, delivered: boolean): WorkflowNativeSessionStart {
    // Native adapter descriptor only. The chat conversation id stands in for execution/Run binding; no Run row exists for it.
    return {
      kind: 'workflow', correlationId, instructionsDelivered: delivered,
      ...(row.active_native_turn_id ? { nativeTurnId: row.active_native_turn_id } : {}),
      request: {
        executionId: `agent-chat:${row.id}`, runId: `agent-chat:${row.id}`, workspaceId: row.workspace_id, workflowNodeId: row.workflow_node_id,
        workingDirectory: row.record.workingDirectory, runtimeDirectory: row.record.runtimeDirectory || this.runtimeDirectory(row.id),
        configuration, input: {},
      },
    }
  }
  private runtimeDirectory(id: string) { return join(resolve(this.runtimeRoot), 'agent-chat', id) }

  private async runtime(row: AgentConversationRow, configuration: AgentConfigurationVersion, correlationId: string, signal: AbortSignal): Promise<Runtime> {
    const existing = this.runtimes.get(row.id)
    if (existing?.session) {
      if (existing.session.nativeSessionId !== row.native_session_id) {
        throw new DomainError('AGENT_CHAT_SESSION_UNBOUND', 'Native session creation has not been durably bound.', 409)
      }
      return existing
    }
    await mkdir(this.runtimeDirectory(row.id), { recursive: true })
    const runtime: Runtime = existing ?? { manager: this.managers(row.id, configuration, row.record.workingDirectory), configuration }
    this.runtimes.set(row.id, runtime)
    if (row.native_session_id && row.provider_version) {
      // Resume the exact stored session. Its startup instructions are already in native history.
      runtime.session = await runtime.manager.attachSession({ harness: row.harness, providerVersion: row.provider_version,
        nativeSessionId: row.native_session_id }, this.startInput(row, configuration, correlationId, true), signal)
    } else {
      if (!row.active_request_id || !await this.repository.beginSessionCreation(row.id, row.active_request_id)) {
        throw new DomainError('AGENT_CHAT_SESSION_CREATION_UNCERTAIN', 'A native session may already exist. A replacement will not be created.', 409)
      }
      if (row.record.origin.kind === 'run_execution') {
        const origin = row.record.origin
        if (!runtime.manager.forkSession) throw new DomainError('AGENT_CHAT_FORK_UNAVAILABLE', 'This harness cannot continue a Run session in chat.', 409)
        const providerVersion = await this.sourceProviderVersion(origin, runtime)
        runtime.session = await runtime.manager.forkSession({ harness: row.harness, providerVersion, nativeSessionId: origin.sourceNativeSessionId },
          this.startInput(row, configuration, correlationId, true), signal)
        await this.repository.bindSession(row.id, runtime.session.providerVersion, runtime.session.nativeSessionId)
        await this.repository.markStartupDelivered(row.id)
      } else {
        runtime.session = await runtime.manager.createSession(this.startInput(row, configuration, correlationId, false), signal)
        await this.repository.bindSession(row.id, runtime.session.providerVersion, runtime.session.nativeSessionId)
      }
    }
    return runtime
  }
  private async sourceProviderVersion(origin: Extract<AgentChatOrigin, { kind: 'run_execution' }>, runtime: Runtime): Promise<string> {
    const lane = (await this.pool.query<{ record: { providerVersion?: string } }>(
      'select record from native_session_lanes where native_session_id=$1 order by updated_at desc limit 1', [origin.sourceNativeSessionId])).rows[0]
    if (lane?.record.providerVersion) return lane.record.providerVersion
    return (await runtime.manager.capabilities(this.lifetime.signal)).providerVersion
  }

  /** Accepted startup instructions and skills are sent exactly once, with the first turn of a fresh session. */
  private prompt(row: AgentConversationRow, configuration: AgentConfigurationVersion, content: string): { text: string; startup: boolean } {
    if (row.record.origin.kind !== 'fresh' || row.record.startupDelivered) return { text: content, startup: false }
    const skills = resolvedSkillPrompt(configuration)
    // Codex receives the system prompt as native developer instructions at thread/start.
    const system = configuration.harness.harness === 'opencode' && configuration.prompt.system
      ? ['AGENT SYSTEM PROMPT', configuration.prompt.system, ''] : []
    if (!system.length && !skills.length) return { text: content, startup: true }
    return { text: [...system, ...skills, '', 'USER MESSAGE', content].join('\n'), startup: true }
  }

  private async runTurn(id: string, turn: AgentChatTurn): Promise<void> {
    const correlationId = agentChatCorrelation(id, turn.requestId)
    const signal = this.lifetime.signal
    let submitted = false
    let creatingSession = false
    let runtime: Runtime | undefined
    try {
      const row = await this.repository.get(id)
      if (!row || row.active_request_id !== turn.requestId) return
      if (row.cancel_requested) { await this.settle(id, turn.requestId, { outcome: 'canceled' }); return }
      const configuration = await this.workflows.getAgentConfiguration(row.agent_configuration_version_id)
      if (!configuration) throw new DomainError('AGENT_CHAT_CONFIGURATION_MISSING', 'The pinned Agent configuration is unavailable.', 409)
      try {
        creatingSession = !row.native_session_id
        runtime = await this.runtime(row, configuration, correlationId, signal)
        creatingSession = false
      } catch (error) {
        if (row.native_session_id && sessionMissing(error)) {
          const reason = 'The native session for this chat no longer exists or cannot be resumed.'
          await this.repository.markSessionUnavailable(id, reason)
          await this.release(id)
          await this.settle(id, turn.requestId, failure(error, 'NATIVE_SESSION_MISSING'))
          return
        }
        throw error
      }
      const session = runtime.session!
      const content = await this.repository.turnContent(id, turn.requestId)
      if (content === undefined) throw new Error('The accepted message content is missing.')
      const fresh = (await this.repository.get(id))!
      const prompt = this.prompt(fresh, configuration, content)
      const partKinds = new Map<string, string>()
      let nativeTurnId: string | null = null
      const currentEvent = openCodeTurnEvents(session.nativeSessionId, () => nativeTurnId)
      const redact = nativePersistenceRedactor([])
      for await (const event of runtime.manager.startTurn(session, {
        prompt: prompt.text, clientCorrelationId: correlationId,
        onSubmitted: async (id_) => {
          nativeTurnId = id_; submitted = true
          await this.repository.accepted(id, turn.requestId, id_)
          this.scheduleReconcile(id)
          this.events.publish(id, 'turn', { requestId: turn.requestId, delivery: 'accepted', nativeTurnId: id_ })
          const current = await this.repository.get(id)
          if (current?.cancel_requested) {
            void this.control(id, () => runtime!.manager.cancel(session, AbortSignal.timeout(10_000), id_)).catch(() => undefined)
          }
        },
      }, signal)) {
        submitted = true
        if (runtime.manager.harness === 'opencode' && !currentEvent(event)) continue
        await this.record(id, turn.requestId, runtime, event, redact)
        for (const delta of nativeAssistantText(event, partKinds)) this.events.publish(id, 'delta', { ...delta, requestId: turn.requestId })
        if (event.type === 'interaction.pending' || event.type === 'permission.asked') {
          // Share the response lock so an older observation cannot overwrite its next approval.
          await this.control(id, async () => {
            const pending = await runtime!.manager.pending(session, signal)
            await this.repository.pending(id, turn.requestId, pending)
            this.events.publish(id, 'state', { requestId: turn.requestId, pending: Boolean(pending) })
          })
        }
      }
      await this.observe(id, turn.requestId, runtime!, correlationId)
    } catch (error) {
      if (this.closing) return // Restart recovery reconciles in-flight work.
      if (creatingSession && (await this.repository.get(id))?.record.sessionCreation) {
        // No reliable identity/commit means read-only, not another create/fork attempt.
        await this.repository.markSessionUnavailable(id, 'Native session creation could not be confirmed. This conversation is read-only; no replacement session will be created automatically.')
        await this.repository.abandon(id, turn.requestId, 'Native session creation or binding is unconfirmed.')
        this.events.publish(id, 'state', { requestId: turn.requestId, delivery: 'unknown' })
        return
      }
      if (!submitted && definiteRejection(error) || !submitted && error instanceof DomainError) {
        const current = await this.repository.get(id)
        await this.settle(id, turn.requestId, current?.cancel_requested ? { outcome: 'canceled' } : failure(error))
      } else {
        await this.repository.abandon(id, turn.requestId, error instanceof Error ? error.message : 'Native delivery is unconfirmed.')
        // Retain the manager: it may still own a late acknowledgement or a live native turn.
        this.scheduleReconcile(id)
        this.events.publish(id, 'state', { requestId: turn.requestId, delivery: 'unknown' })
      }
    }
  }

  private async record(id: string, requestId: string, runtime: Runtime, event: NativeHarnessEvent, redact: ReturnType<typeof nativePersistenceRedactor>) {
    const change = operatorActivity(event, runtime.manager.harness, requestId)
    if (change && change.kind !== 'thinking') {
      const accepted = await this.activity.append(id, requestId, redact.value(change))
      if (accepted) this.events.publish(id, 'activity', accepted)
    }
    const message = completedNativeAssistantMessage(event, runtime.manager.harness)
    if (message && await this.messages.appendAssistantMessage(id, requestId, message.id, message.text,
      message.parentMessageId ? { parentMessageId: message.parentMessageId, complete: message.complete === true } : undefined)) {
      this.events.publish(id, 'message', { requestId, nativeMessageId: message.id })
    }
  }

  /** Settle from native history: identity must match, and only terminal evidence completes a turn. */
  private async observe(id: string, requestId: string, runtime: Runtime, correlationId: string, controlled = false): Promise<void> {
    const row = await this.repository.get(id)
    if (!row || row.active_request_id !== requestId) return
    const history = await runtime.manager.reconcile(runtime.session!, correlationId, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]))
    if (runtime.session?.nativeSessionId !== row.native_session_id || history.correlationId !== correlationId || !history.nativeTurnId
      || row.active_native_turn_id && history.nativeTurnId !== row.active_native_turn_id
      || history.terminalTurn && (history.terminalTurn.correlationId !== correlationId || history.terminalTurn.providerId !== history.nativeTurnId)) {
      await this.repository.abandon(id, requestId, 'The provider has not proven this exact message and native turn. It will not be resent automatically.')
      this.scheduleReconcile(id)
      this.events.publish(id, 'state', { requestId, delivery: 'unknown' })
      return
    }
    await this.repository.accepted(id, requestId, history.nativeTurnId)
    const redact = nativePersistenceRedactor([])
    for (const event of currentOperatorHistory(history, runtime.manager.harness)) await this.record(id, requestId, runtime, event, redact)
    const pending = history.pendingInteraction ?? history.pendingInteractions[0]
    if (history.terminalResult && !pending) {
      await this.settle(id, requestId, history.terminalResult, history.nativeMessageId)
    } else {
      // Acknowledged but not terminal (including approvals) still owns the native session.
      if (controlled) await this.repository.pending(id, requestId, pending)
      else await this.control(id, () => this.repository.pending(id, requestId, pending))
      this.scheduleReconcile(id)
      this.events.publish(id, 'state', { requestId, delivery: 'accepted' })
    }
  }

  private async settle(id: string, requestId: string, result: ExecutionResult, nativeMessageId?: string): Promise<void> {
    if (await this.repository.finish(id, requestId, result, nativeMessageId)) {
      this.events.publish(id, 'message', { requestId })
      this.events.publish(id, 'state', { requestId, delivery: result.outcome === 'succeeded' ? 'completed' : result.outcome })
    }
  }

  /** Poll exact native history even when the event stream or an interrupt notification is silent. */
  private scheduleReconcile(id: string): void {
    if (this.closing || this.reconciliationTimers.has(id)) return
    const timer = setTimeout(() => {
      this.reconciliationTimers.delete(id)
      void this.repair(id).catch((error: unknown) => {
        this.events.publish(id, 'error', { message: error instanceof Error ? error.message : 'Native reconciliation failed.' })
        this.scheduleReconcile(id)
      })
    }, 1_000)
    timer.unref()
    this.reconciliationTimers.set(id, timer)
  }

  private async repair(id: string): Promise<void> {
    await this.control(id, async () => {
      const row = await this.repository.restoreUnsettled(id)
      if (!row?.active_request_id || row.record.sessionUnavailable) return
      const requestId = row.active_request_id
      const correlationId = agentChatCorrelation(id, requestId)
      try {
        if (!row.native_session_id) {
          await this.repository.markSessionUnavailable(id, 'No native session identity was stored before recovery. This conversation is read-only; no replacement session will be created automatically.')
          await this.repository.abandon(id, requestId, 'Native session creation is unconfirmed.')
          this.events.publish(id, 'state', { requestId, delivery: 'unknown' })
          return
        }
        const configuration = await this.workflows.getAgentConfiguration(row.agent_configuration_version_id)
        if (!configuration) throw new Error('The pinned Agent configuration is unavailable.')
        const runtime = await this.runtime(row, configuration, correlationId, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000)]))
        await this.observe(id, requestId, runtime, correlationId, true)
      } catch (error) {
        await this.repository.abandon(id, requestId,
          `Native delivery is not yet confirmed. ${error instanceof Error ? error.message : ''}`.trim())
        this.scheduleReconcile(id)
        this.events.publish(id, 'state', { requestId, delivery: 'unknown' })
      }
    })
    const current = await this.repository.get(id)
    if (current && !current.active_request_id && !current.record.sessionUnavailable && await this.repository.nextQueued(id)) this.pump(id)
  }

  private async release(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    this.runtimes.delete(id)
    try {
      if (runtime?.manager.dispose) await runtime.manager.dispose()
      else if (runtime?.session) await runtime.manager.close(runtime.session)
    } finally { this.managers.release?.(id) }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Recover exact stored sessions; unresolved work remains fenced and is polled without resubmission. */
  async recover(): Promise<void> {
    for (const row of await this.repository.open()) {
      if (this.closing) return
      await this.repair(row.id)
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true
    for (const timer of this.reconciliationTimers.values()) clearTimeout(timer)
    this.reconciliationTimers.clear()
    this.lifetime.abort(new Error('Agent chat is shutting down.'))
    await Promise.allSettled([...this.tasks.values()])
    await Promise.allSettled([...this.controls.values()])
    await Promise.allSettled([...this.runtimes.keys()].map((id) => this.release(id)))
  }
}
