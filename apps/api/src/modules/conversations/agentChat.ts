import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type pg from 'pg'
import type { z } from 'zod'

import {
  ExecutionLocationSchema, NativeSessionReferenceSchema, type AgentConfigurationVersion, type HarnessExecution, type ExecutionResult, type NativeHarnessEvent, type NativeSessionReference,
} from '@graphql/contracts'
import {
  AgentChatStateSchema, AgentChatStreamEventSchema, SendAgentChatMessageRequestSchema, AgentChatReadbackQuerySchema,
  InterruptAgentChatRequestSchema, CancelQueuedAgentChatTurnRequestSchema, RespondAgentChatInteractionRequestSchema,
  type AgentChatBlockedReason, type AgentChatCapabilities, type AgentChatContext, type AgentChatOrigin, type AgentChatQuery,
  type AgentChatSessionState, type AgentChatState, type AgentChatStreamEvent, type AgentChatTurn, type SendAgentChatMessageRequest,
} from '@graphql/contracts/agent-chat'
import type { ManagementAction, ManagementPrincipal } from '@graphql/contracts/management'
import { RepeatOccurrenceIdentityV1Schema } from '@graphql/contracts/wave25'

import { SelectedRunChatKeySchema } from '@graphql/contracts/run-snapshots'
import {
  ReadSelectedRunChatRequestSchema, ReadSelectedRunChatResponseSchema, SendSelectedRunChatRequestSchema,
  InterruptSelectedRunChatRequestSchema, type ReadSelectedRunChatResponse,
} from '@graphql/contracts/selected-run-chat'
import {
  assertRunChatConversation, findRunChatConversation, resolveRunChatSelection, runChatStorageKey,
  staleRunChat, withRunChatAuthority, type RunChatAuthorityCheck,
} from './selectedRunChat.js'
import { agentActivitySnapshot } from './activitySnapshot.js'
import { AgentChatCommands } from './agentChatCommands.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { NativeTurnNotActiveError } from '../harnesses/errors.js'
import type { NativeHarnessSessionManager, WorkflowNativeSessionStart } from '../harnesses/port.js'
import { nativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { legacySkillPrompt } from '../skills/instructions.js'
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
  retiring?: boolean
  disposal?: Promise<void>
  /** Detach only this turn's observer after its durable terminal settlement. */
  observer?: { requestId: string; controller: AbortController }
}

interface Resolution {
  context: AgentChatContext
  key?: string
  executionId?: string
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
  return { outcome: 'failed', error: { code: nativeErrorCode(error) ?? code,
    message: provider?.message ?? (error instanceof Error ? error.message : 'The native turn failed.'), retryable: true } }
}
function definiteRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('certainty' in error) return error.certainty === 'definite'
  return 'uncertain' in error && error.uncertain === false
}
/** Only the native creation boundary can prove that an unbound attempt created no session. */
class RejectedSessionCreation extends Error {
  constructor(readonly rejection: unknown) {
    super('Native session creation was definitely rejected and its owner was disposed.', { cause: rejection })
  }
}
function definiteNonCreation(error: unknown, row: AgentConversationRow): boolean {
  if (error && typeof error === 'object' && ('uncertain' in error && error.uncertain === true
    || 'certainty' in error && error.certainty === 'uncertain')) return false
  if (row.harness === 'codex') {
    // Model discovery is before thread/start/fork. A rejected later RPC (for example activation)
    // is NOT evidence that the earlier thread creation failed.
    if (nativeErrorCode(error) === 'CODEX_MODEL_CATALOG_UNAVAILABLE') return true
    return definiteRejection(error) && error !== null && typeof error === 'object' && 'method' in error
      && (error.method === 'initialize' || error.method === (row.record.origin.kind === 'fresh' ? 'thread/start' : 'thread/fork'))
  }
  // OpenCode fresh creation has no fallible native operation after POST /session succeeds.
  // Fork also applies/verifies the child's policy; a definite error there can leave a created child.
  return row.record.origin.kind === 'fresh' && definiteRejection(error)
}
const EPHEMERAL_SESSION_LOST = 'This ephemeral Codex session is no longer live and cannot be resumed after the API restarts. Start a separate conversation.'
function nativeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const nested = 'result' in error ? (error as { result?: ExecutionResult }).result?.error?.code : undefined
  return nested ?? ('code' in error && typeof error.code === 'string' ? error.code : undefined)
}
function nativeUnavailable(error: unknown): { reason: 'native_session_missing' | 'harness_unavailable'; message: string } | undefined {
  const code = nativeErrorCode(error)
  if (code === 'CODEX_SCOPED_ENVIRONMENT_REQUIRED' || code === 'CODEX_APP_MCP_UNAVAILABLE' || code === 'OPENCODE_APP_MCP_UNAVAILABLE') {
    return { reason: 'harness_unavailable', message: 'Chat could not verify that the scoped GraphQL App MCP server was disabled for its native session. GraphQL workflow tools are not available in chat, and chat never receives App MCP or workflow credentials.' }
  }
  if (code && ['CODEX_MCP_CONFIG_INVALID', 'CODEX_ENVIRONMENT_INVALID',
    'OPENCODE_CREDENTIAL_ENV_UNSUPPORTED', 'OPENCODE_CREDENTIAL_CONTEXT_MISMATCH'].includes(code)) {
    return { reason: 'harness_unavailable', message: 'Native App MCP/environment validation failed. Agent chat cannot use application or workflow credentials; check the native configuration.' }
  }
  if (code === 'AGENT_CHAT_EPHEMERAL_SESSION_LOST') return { reason: 'native_session_missing', message: EPHEMERAL_SESSION_LOST }
  if (code && (/SESSION_NOT_FOUND|THREAD_NOT_FOUND|SESSION_ID_MISMATCH|SETTING_UNSUPPORTED|VERSION_MISMATCH/.test(code)
    || code === 'AGENT_CHAT_FORK_UNAVAILABLE')) {
    return { reason: 'native_session_missing', message: 'The native session or Run source no longer exists or cannot be continued. No replacement session was created.' }
  }
  return undefined
}

export class AgentChatService {
  readonly events = new AgentChatEvents()
  private readonly runtimes = new Map<string, Runtime>()
  private readonly tasks = new Map<string, Promise<void>>()
  /** Live preparation is not orphan recovery, including the create-to-bind gap. */
  private readonly preparations = new Map<string, { requestId: string; done: Promise<void> }>()
  private readonly wakeups = new Set<string>()
  private readonly controls = new Map<string, Promise<unknown>>()
  private readonly reconciliationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inflightCommands = new Set<Promise<unknown>>()
  private recovery: Promise<void> | undefined
  private shutdownAttempt: Promise<void> | undefined
  private readonly activity: PostgresOperatorActivityRepository
  private readonly commands: AgentChatCommands
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
    this.commands = new AgentChatCommands(pool)
  }

  /** Publish command ownership before the first await so shutdown also drains admission/readback. */
  private command<T>(operation: () => Promise<T>): Promise<T> {
    const next = Promise.resolve().then(() => { this.assertOpen(); return operation() })
    this.inflightCommands.add(next)
    void next.finally(() => this.inflightCommands.delete(next)).catch(() => undefined)
    return next
  }

  /** Serialize native lifecycle decisions per conversation. */
  private control<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.controls.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => { this.assertOpen(); return operation() })
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
    // Commands return transcript/activity/approval state: check its authority
    // before command reservation or any native/database mutation, also on replay.
    if (action !== 'agent_chat:read') this.authorize(principal, 'agent_chat:read', { workspaceId, workflowId: row.workflow_id,
      ...(row.origin_run_id ? { runId: row.origin_run_id } : {}) })
    if (action !== 'agent_chat:read' && row.record.origin.kind === 'run_execution'
      && row.native_session_id === row.record.origin.sourceNativeSessionId) {
      throw new DomainError('AGENT_CHAT_UNAVAILABLE', 'A Run source session cannot be controlled as a chat session.', 409)
    }
    return row
  }

  // ---------------------------------------------------------------- context

  private async resolve(context: AgentChatContext, executionId?: string, selectedRun = false): Promise<Resolution> {
    let key = agentChatKey(context)
    let row = selectedRun && context.runId && executionId
      ? await findRunChatConversation(this.pool, context, executionId) : await this.repository.byKey(key)
    const blocked = (reason: AgentChatBlockedReason, message: string): Resolution => ({ context, key,
      ...(executionId ? { executionId } : {}), ...(row ? { row } : {}), blocked: { reason, message } })
    if (context.runId) {
      const run = await this.runs.getForWorkspace(context.workspaceId, context.runId).catch(() => undefined)
      if (!run || run.id !== context.runId || run.workflowId !== context.workflowId) return blocked('context_stale', 'The selected Run does not belong to this workflow.')
      const version = await this.workflows.getSavedVersion(run.workflowVersionId)
      if (!version?.definition.nodes.some((node) => node.id === context.workflowNodeId && node.agentId === context.agentId)) {
        return blocked('agent_missing', 'This Agent is not part of the selected Run.')
      }
      if (!selectedRun && !TERMINAL_RUN_STATES.has(run.executionState)) {
        return blocked('run_active', 'This Agent belongs to a Run that is still working. Chat opens when the Run finishes.')
      }
      if (row && !selectedRun) {
        const configuration = await this.workflows.getAgentConfiguration(row.agent_configuration_version_id)
        const unavailable = this.sessionUnavailable(row, configuration)
        return { context, key, row, ...(configuration ? { configuration } : {}), ...(unavailable ? { blocked: unavailable } : {}) }
      }
      if (row) {
        assertRunChatConversation(row, context, executionId)
        // A continued conversation stays on its original execution, including after another attempt.
        executionId ??= row.origin_execution_id ?? undefined
      }
      const block = version.definition.repeat?.blocks.find((entry) => entry.nodeIds.includes(context.workflowNodeId))
      let source: HarnessExecution | undefined
      let sourceOccurrence = 0
      for await (const page of this.runs.executionPages(run.id)) {
        for (const execution of page) {
          if (executionId && execution.id !== executionId) continue
          if (execution.runId !== run.id || execution.workflowNodeId !== context.workflowNodeId || execution.agentId !== context.agentId) {
            if (executionId) staleRunChat()
            continue
          }
          let occurrenceIndex = 0
          if (block) {
            const input = execution.input
            const occurrence = input && typeof input === 'object' && !Array.isArray(input) ? input.occurrence : undefined
            const parsed = RepeatOccurrenceIdentityV1Schema.safeParse(
              occurrence && typeof occurrence === 'object' && !Array.isArray(occurrence) ? occurrence.identity : undefined)
            if (!parsed.success || parsed.data.blockId !== block.id || parsed.data.scope.runId !== run.id
              || parsed.data.scope.workspaceId !== context.workspaceId || parsed.data.scope.workflowId !== context.workflowId
              || parsed.data.scope.workflowVersionId !== run.workflowVersionId) {
              return blocked('context_stale', 'The selected Run execution has no matching business occurrence identity.')
            }
            occurrenceIndex = parsed.data.occurrenceIndex
          }
          // The legacy unpinned entrypoint retains its latest-occurrence policy. SCH-06 always
          // supplies an explicit execution after snapshot resolution; it never takes this fallback.
          if (!source || occurrenceIndex > sourceOccurrence || occurrenceIndex === sourceOccurrence && execution.attempt > source.attempt) {
            source = execution; sourceOccurrence = occurrenceIndex
          }
        }
      }
      if (!source) {
        if (executionId) staleRunChat()
        return blocked('native_session_missing', 'This Run has no stored execution for this Agent.')
      }
      executionId = source.id
      row ??= await findRunChatConversation(this.pool, context, executionId)
      if (row) assertRunChatConversation(row, context, executionId, source)
      key = row?.agent_key ?? runChatStorageKey(context, executionId)
      const configuration = await this.workflows.getAgentConfiguration(row?.agent_configuration_version_id ?? source.agentConfigurationVersionId)
      if (!configuration) return blocked('agent_missing', 'The Agent configuration used by this Run is unavailable.')
      if (configuration.id !== source.agentConfigurationVersionId || configuration.agentId !== context.agentId
        || row && row.harness !== configuration.harness.harness) staleRunChat()
      if (!TERMINAL_RUN_STATES.has(run.executionState)) {
        return { ...blocked('run_active', 'This Agent belongs to a Run that is still working. Chat opens when the Run finishes.'), configuration }
      }
      if (row) {
        const unavailable = this.sessionUnavailable(row, configuration)
          ?? (!row.native_session_id && (!source.nativeSessionId || !source.workingDirectory || source.state !== 'completed'
            || configuration.harness.harness === 'codex' && configuration.harness.advanced?.sessionPersistence === 'ephemeral')
            ? { reason: 'native_session_missing' as const, message: 'The Run source cannot be forked. Stored chat messages remain readable; no replacement session will be created.' }
            : undefined)
        return { context, key, executionId, row, configuration, ...(unavailable ? { blocked: unavailable } : {}) }
      }
      if (!source.nativeSessionId || !source.workingDirectory || source.state !== 'completed') {
        return { ...blocked('native_session_missing', 'This execution has no resumable stored native session. No other execution was selected.'), configuration }
      }
      if (configuration.harness.harness === 'codex' && configuration.harness.advanced?.sessionPersistence === 'ephemeral') {
        return { ...blocked('native_session_missing', 'This Run used an ephemeral Codex session; a durable chat fork is unavailable.'), configuration }
      }
      return { context, key, executionId, configuration, create: {
        agentConfigurationVersionId: configuration.id, harness: configuration.harness.harness,
        origin: { kind: 'run_execution', runId: run.id, executionId, sourceNativeSessionId: source.nativeSessionId },
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
      const unavailable = this.sessionUnavailable(row, configuration)
      return { context, row, ...(configuration ? { configuration } : {}), ...(unavailable ? { blocked: unavailable } : {}) }
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
    const unavailable = row ? this.sessionUnavailable(row, configuration) : undefined
    if (harness === 'codex') {
      return { harness, providerVersion, steer: 'native_expected_turn', interruptAndSend: true, queueNextTurn: true, resume: !unavailable,
        unavailable: unavailable ? { resume: unavailable.message } : {} }
    }
    return { harness, providerVersion, steer: 'unavailable', interruptAndSend: true, queueNextTurn: true, resume: !unavailable,
      unavailable: { steer: OPENCODE_STEER_REASON, ...(unavailable ? { resume: unavailable.message } : {}) } }
  }

  private sessionUnavailable(row: AgentConversationRow, configuration: AgentConfigurationVersion | undefined): Resolution['blocked'] {
    if (!configuration) return { reason: 'agent_missing', message: 'The pinned Agent configuration is unavailable; the transcript remains readable.' }
    if (!row.native_session_id && (row.provider_version || row.record.startupDelivered || row.record.startupReceipt)) {
      return { reason: 'native_session_missing', message: 'This conversation lost its stored native session identity. The transcript remains readable; a replacement session will not be created.' }
    }
    if (row.native_session_id && !row.provider_version) return { reason: 'native_session_missing', message: 'The stored native session has no provider version and cannot be resumed.' }
    if (row.record.origin.kind === 'run_execution' && row.native_session_id === row.record.origin.sourceNativeSessionId) {
      return { reason: 'harness_unavailable', message: 'Chat cannot use the Run-owned native session directly. A separate native fork is required.' }
    }
    if (row.record.sessionUnavailable) return { reason: row.record.sessionUnavailableReason ?? 'native_session_missing', message: row.record.sessionUnavailable }
    const runtime = this.runtimes.get(row.id)
    if (runtime?.retiring) return { reason: 'harness_unavailable', message: 'Native cleanup is unconfirmed. This conversation cannot start more work until its owner is safely disposed.' }
    if (row.native_session_id && configuration?.harness.harness === 'codex'
      && configuration.harness.advanced?.sessionPersistence === 'ephemeral'
      && runtime?.session?.nativeSessionId !== row.native_session_id) {
      return { reason: 'native_session_missing', message: EPHEMERAL_SESSION_LOST }
    }
    return undefined
  }

  private async markNativeUnavailable(id: string, error: unknown): Promise<boolean> {
    const unavailable = nativeUnavailable(error)
    if (!unavailable) return false
    await this.repository.markSessionUnavailable(id, unavailable.message, unavailable.reason)
    this.events.publish(id, 'state', { sessionState: 'unavailable', reason: unavailable.reason })
    return true
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
    if (blocked && ['native_session_missing', 'harness_unavailable', 'agent_missing'].includes(blocked.reason)) {
      capabilities.resume = false; capabilities.queueNextTurn = false; capabilities.interruptAndSend = false
      capabilities.steer = 'unavailable'
      capabilities.unavailable = { resume: blocked.message, queueNextTurn: blocked.message,
        interruptAndSend: blocked.message, steer: blocked.message }
    }
    const availability = blocked ? { canSend: false, reason: blocked.reason, message: blocked.message } : { canSend: true, message: 'GraphQL workflow tools are not available in chat. The scoped GraphQL App MCP server is disabled for chat only; other accepted Agent settings are retained.' }
    if (!resolution.row) {
      return AgentChatStateSchema.parse({ context, conversation: null, sessionState: 'none', availability, capabilities,
        activeTurn: null, turns: [], messages: [], hasEarlierMessages: false, activities: [], revision: 0 })
    }
    const loaded = await this.repository.state(resolution.row.id, { recoverOverflow: true })
    if (!loaded) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
    const { row } = loaded
    if (loaded.hasMoreTurns) {
      availability.canSend = false
      availability.message = [availability.message,
        'This chat has more than 100 unfinished messages. Only a recovery window is shown. Cancel queued messages to free capacity; Stop chat also cancels all queued messages when available. Unconfirmed deliveries still require native evidence.']
        .filter(Boolean).join(' ')
    }
    const activities = loaded.activityPage.activities
    return AgentChatStateSchema.parse({
      context, conversation: agentConversation(row), sessionState: this.sessionUnavailable(row, resolution.configuration)
        || blocked && ['native_session_missing', 'harness_unavailable', 'agent_missing'].includes(blocked.reason)
        ? 'unavailable' : this.sessionState(row), availability, capabilities,
      activeTurn: row.active_request_id ? { requestId: row.active_request_id,
        ...(row.active_native_turn_id ? { nativeTurnId: row.active_native_turn_id } : {}), startedAt: loaded.activeStartedAt?.toISOString() ?? loaded.turns.find((turn) => turn.requestId === row.active_request_id)?.createdAt ?? row.created_at.toISOString() } : null,
      turns: loaded.turns, messages: loaded.messages, hasEarlierMessages: loaded.hasEarlierMessages, activities,
      ...(loaded.hasMoreTurns ? { hasMoreTurns: true } : {}),
      ...(row.pending_interaction ? { pendingInteraction: row.pending_interaction } : {}),
      ...(row.last_result ? { lastResult: row.last_result } : {}),
      revision: Number(row.revision), activitySnapshot: agentActivitySnapshot(loaded),
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
    const resolution = await this.resolve(context, row.origin_execution_id ?? undefined,
      !!context.runId && !!row.origin_execution_id && row.agent_key === runChatStorageKey(context, row.origin_execution_id))
    if (resolution.row?.id !== id) staleRunChat()
    return this.state(resolution)
  }
  async history(principal: ManagementPrincipal, workspaceId: string, id: string, before: string | undefined, limit: number) {
    await this.conversation(workspaceId, id, principal, 'agent_chat:read')
    const page = AgentChatReadbackQuerySchema.parse({ before, limit })
    return { conversationId: id, ...await this.repository.history(id, page.before, page.limit) }
  }
  async receipts(principal: ManagementPrincipal, workspaceId: string, id: string, before: string | undefined, limit: number) {
    await this.conversation(workspaceId, id, principal, 'agent_chat:read')
    const page = AgentChatReadbackQuerySchema.parse({ before, limit })
    return { conversationId: id, ...await this.repository.receipts(id, page.before, page.limit) }
  }
  async assertReadable(principal: ManagementPrincipal, workspaceId: string, id: string) {
    await this.conversation(workspaceId, id, principal, 'agent_chat:read')
  }

  /** Snapshot-selected read. It never creates, attaches, forks or probes a native session. */
  async readSelectedRun(principal: ManagementPrincipal, raw: unknown): Promise<ReadSelectedRunChatResponse> {
    const input = ReadSelectedRunChatRequestSchema.parse(raw)
    return withRunChatAuthority(this.pool, principal, input.selection, ['agent_chat:read'], async (client) => {
      const selected = await resolveRunChatSelection(client, this.runs, input.selection)
      if (selected.kind !== 'selected') return ReadSelectedRunChatResponseSchema.parse(selected)
      const resolution = await this.resolve(selected.context, selected.selection.executionId, true)
      if (resolution.blocked?.reason === 'context_stale') staleRunChat()
      const state = await this.state(resolution)
      const id = state.conversation?.id
      return ReadSelectedRunChatResponseSchema.parse({ kind: 'selected', selection: selected.selection, state,
        key: id ? SelectedRunChatKeySchema.parse({ ...selected.selection, agentId: selected.context.agentId, conversationId: id }) : null,
        ...(id && input.history ? { history: await this.history(principal, input.selection.workspaceId, id, input.history.before, input.history.limit) } : {}),
        ...(id && input.receipts ? { receipts: await this.receipts(principal, input.selection.workspaceId, id, input.receipts.before, input.receipts.limit) } : {}),
      })
    })
  }

  sendSelectedRun(principal: ManagementPrincipal, raw: unknown) {
    return this.command(async () => {
      const input = SendSelectedRunChatRequestSchema.parse(raw)
      return withRunChatAuthority(this.pool, principal, input.selection, ['agent_chat:read', 'agent_chat:write'], async (client, assertCurrent) => {
        const selected = await resolveRunChatSelection(client, this.runs, input.selection)
        if (selected.kind !== 'selected') throw new DomainError('AGENT_CHAT_UNAVAILABLE', 'The selected Run has no resolvable historical chat.', 409)
        const { workspaceId, ...context } = selected.context
        return this.sendMessage(principal, workspaceId, { ...input.message, context }, selected.selection.executionId, assertCurrent)
      })
    })
  }

  interruptSelectedRun(principal: ManagementPrincipal, raw: unknown, source: 'http' | 'mcp' = 'http'): Promise<AgentChatState> {
    return this.command(async () => {
      const input = InterruptSelectedRunChatRequestSchema.parse(raw)
      return withRunChatAuthority(this.pool, principal, input.key, ['agent_chat:read', 'agent_chat:cancel'], async (client, assertCurrent) => {
        const selected = await resolveRunChatSelection(client, this.runs, input.key)
        if (selected.kind !== 'selected' || selected.context.agentId !== input.key.agentId) staleRunChat()
        const row = await findRunChatConversation(client, selected.context, input.key.executionId)
        if (!row || row.id !== input.key.conversationId) staleRunChat()
        // Validate configuration/source identity too, before interrupt's durable command receipt.
        const resolution = await this.resolve(selected.context, input.key.executionId, true)
        if (resolution.row?.id !== row.id || resolution.blocked?.reason === 'context_stale') staleRunChat()
        if (row.record.origin.kind === 'run_execution' && row.native_session_id === row.record.origin.sourceNativeSessionId) {
          throw new DomainError('AGENT_CHAT_UNAVAILABLE', 'A Run source session cannot be controlled as a chat session.', 409)
        }
        await assertCurrent()
        return this.interrupt(principal, input.key.workspaceId, row.id, input.request, source)
      })
    })
  }

  // ---------------------------------------------------------------- commands

  send(principal: ManagementPrincipal, workspaceId: string, value: SendAgentChatMessageRequest) {
    return this.command(() => this.sendMessage(principal, workspaceId, value))
  }
  private async sendMessage(principal: ManagementPrincipal, workspaceId: string, value: SendAgentChatMessageRequest, executionId?: string, assertCurrent: RunChatAuthorityCheck = async () => {}) {
    this.assertOpen()
    const input = SendAgentChatMessageRequestSchema.parse(value)
    const context: AgentChatContext = { workspaceId, ...input.context }
    this.authorize(principal, 'agent_chat:write', context)
    this.authorize(principal, 'agent_chat:read', context)
    let selectedRun = executionId !== undefined
    if (input.expectedConversationId !== null) {
      const expected = await this.repository.get(input.expectedConversationId)
      if (!expected) staleRunChat()
      assertRunChatConversation(expected, context, executionId)
      selectedRun ||= !!context.runId && !!expected.origin_execution_id
        && expected.agent_key === runChatStorageKey(context, expected.origin_execution_id)
      executionId ??= expected.origin_execution_id ?? undefined
    }
    const resolution = await this.resolve(context, executionId, selectedRun)
    if (input.expectedConversationId !== null && resolution.row?.id !== input.expectedConversationId
      || resolution.blocked?.reason === 'context_stale') staleRunChat()
    const key = resolution.key ?? agentChatKey(context)
    await assertCurrent()
    if (resolution.row) {
      const prior = await this.repository.turn(resolution.row.id, input.requestId)
      if (prior) {
        // Same key and input returns the stored receipt; a different input is a conflict. Never re-sends.
        const admitted = await this.repository.admit({ key, request: input, context, delivery: 'queued', assertCurrent })
        return { state: await this.state(await this.resolve(context, resolution.executionId, selectedRun)), turn: admitted.turn, replayed: true,
          ...(admitted.replayWarning ? { replayWarning: admitted.replayWarning } : {}) }
      }
    }
    if (resolution.blocked) {
      throw new DomainError('AGENT_CHAT_UNAVAILABLE',
        resolution.blocked.message, 409, { reason: resolution.blocked.reason })
    }
    const row = resolution.row
    if (input.intent === 'steer') return this.steer(principal, context, key, input, resolution, selectedRun, assertCurrent)
    if (input.intent === 'interrupt_and_send' && !row) throw new DomainError('AGENT_CHAT_TURN_NOT_ACTIVE', 'There is no active turn to interrupt.', 409)
    const create = resolution.create ? { ...resolution.create, context } : undefined
    const admitted = await this.repository.admit({ key, request: input, context, delivery: 'queued', ownerPrincipalId: principal.id, assertCurrent,
      ...(create ? { create } : {}) })
    if (admitted.replayed) return { state: await this.state(await this.resolve(context, resolution.executionId, selectedRun)), turn: admitted.turn, replayed: true,
      ...(admitted.replayWarning ? { replayWarning: admitted.replayWarning } : {}) }
    this.events.publish(admitted.conversationId, 'turn', { requestId: input.requestId, delivery: admitted.turn.delivery })
    if (input.intent === 'interrupt_and_send') await this.interruptActive(admitted.conversationId, false, admitted.interruptTarget)
    this.pump(admitted.conversationId)
    return { state: await this.state(await this.resolve(context, resolution.executionId, selectedRun)), turn: admitted.turn, replayed: false }
  }

  private async steer(_principal: ManagementPrincipal, context: AgentChatContext, key: string, input: SendAgentChatMessageRequest, resolution: Resolution, selectedRun: boolean, assertCurrent: RunChatAuthorityCheck = async () => {}) {
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
      await assertCurrent()
      const admitted = await this.repository.admit({ key, request: input, context, delivery: 'submitting', targetNativeTurnId: target, assertCurrent })
      if (admitted.replayed) return { state: await this.state(await this.resolve(context, resolution.executionId, selectedRun)), turn: admitted.turn, replayed: true }
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
        this.scheduleReconcile(row.id)
      }
      this.events.publish(row.id, 'turn', { requestId: input.requestId })
      const turn = (await this.repository.turn(row.id, input.requestId))!
      return { state: await this.state(await this.resolve(context, resolution.executionId, selectedRun)), turn, replayed: false }
    })
  }

  interrupt(principal: ManagementPrincipal, workspaceId: string, id: string,
    value: z.infer<typeof InterruptAgentChatRequestSchema>, source: 'http' | 'mcp' = 'http'): Promise<AgentChatState> {
    return this.command(async () => {
      const input = InterruptAgentChatRequestSchema.parse(value)
      await this.conversation(workspaceId, id, principal, 'agent_chat:cancel')
      return this.commands.execute(principal, source, id, input.requestId, { kind: 'interrupt', workspaceId, ...input }, async () => {
        await this.conversation(workspaceId, id, principal, 'agent_chat:cancel')
        const target = await this.repository.interrupt(id, input.expectedNativeTurnId)
        await this.interruptActive(id, true, target)
        return this.readConversation(principal, workspaceId, id)
      })
    })
  }
  cancelQueued(principal: ManagementPrincipal, workspaceId: string, id: string, turnRequestId: string,
    value: z.infer<typeof CancelQueuedAgentChatTurnRequestSchema>, source: 'http' | 'mcp' = 'http'): Promise<AgentChatState> {
    return this.command(async () => {
      const input = CancelQueuedAgentChatTurnRequestSchema.parse(value)
      await this.conversation(workspaceId, id, principal, 'agent_chat:cancel')
      return this.commands.execute(principal, source, id, input.requestId, { kind: 'cancel_queued', workspaceId, turnRequestId, ...input }, async () => {
        if (!await this.repository.cancelQueued(id, turnRequestId)) {
          const turn = await this.repository.turn(id, turnRequestId)
          if (!turn) throw new DomainError('AGENT_CHAT_TURN_NOT_FOUND', 'That message was not found.', 404)
          if (turn.delivery !== 'canceled') throw new DomainError('AGENT_CHAT_TURN_STARTED', 'That message was already sent to the Agent.', 409)
        }
        this.events.publish(id, 'turn', { requestId: turnRequestId, delivery: 'canceled' })
        this.pump(id)
        return this.readConversation(principal, workspaceId, id)
      })
    })
  }
  respond(principal: ManagementPrincipal, workspaceId: string, id: string,
    value: z.infer<typeof RespondAgentChatInteractionRequestSchema>, source: 'http' | 'mcp' = 'http'): Promise<AgentChatState> {
    return this.command(async () => {
      const input = RespondAgentChatInteractionRequestSchema.parse(value)
      await this.conversation(workspaceId, id, principal, 'agent_chat:respond')
      return this.commands.execute(principal, source, id, input.requestId, { kind: 'respond', workspaceId, ...input }, async () => {
        await this.control(id, async () => {
          const row = await this.conversation(workspaceId, id, principal, 'agent_chat:respond')
          const pending = row.pending_interaction
          const runtime = this.runtimes.get(id)
          if (!pending || pending.turn.nativeRequestId !== input.nativeRequestId || !runtime?.session || !row.active_request_id) {
            throw new DomainError('AGENT_CHAT_INTERACTION_NOT_PENDING', 'This approval is no longer pending.', 409)
          }
          const option = pending.responseOptions.find((entry) => entry.optionId === input.optionId)
          if (!option) throw new DomainError('AGENT_CHAT_INTERACTION_OPTION_INVALID', 'That option was not offered.', 422)
          const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)])
          await runtime.manager.respond(runtime.session, input.nativeRequestId, option, signal)
          const next = await runtime.manager.pending(runtime.session, signal)
          await this.repository.pending(id, row.active_request_id, next)
          this.events.publish(id, 'state', { pending: Boolean(next) })
        })
        return this.readConversation(principal, workspaceId, id)
      })
    })
  }

  private async interruptActive(id: string, explicit: boolean, target: AgentChatInterruptTarget | undefined, controlled = false): Promise<void> {
    if (!target) return
    const interrupt = async () => {
      const row = await this.repository.get(id)
      if (!row || row.active_request_id !== target.requestId || !row.cancel_requested
        || (target.nativeTurnId && row.active_native_turn_id !== target.nativeTurnId)) return
      this.scheduleReconcile(id)
      this.events.publish(id, 'state', { requestId: target.requestId, sessionState: 'interrupting', explicit })
      const runtime = this.runtimes.get(id)
      if (!runtime?.session || runtime.retiring || runtime.session.nativeSessionId !== row.native_session_id
        || !row.active_native_turn_id) return // Submission or exact-history recovery will retry this durable intent.
      try {
        await runtime.manager.cancel(runtime.session, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]), row.active_native_turn_id)
      } catch (error) {
        this.events.publish(id, 'error', { message: error instanceof Error ? error.message : 'Interrupt delivery failed.' })
      }
    }
    if (controlled) await interrupt()
    else await this.control(id, interrupt)
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
          if (!row || row.active_request_id || row.record.sessionUnavailable) return
          // Only a selection that left the queue warrants an immediate rescan. An unchanged
          // queued receipt is fenced (for example by an orphan); let reconciliation repair it.
          if ((await this.repository.turn(id, next.requestId))?.delivery === 'queued') return
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
    // No environment/credential is borrowed from a workflow or issued for chat. Its App MCP entry is disabled at native launch.
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
    this.assertOpen()
    const unavailable = this.sessionUnavailable(row, configuration)
    if (unavailable) throw new DomainError(unavailable.message === EPHEMERAL_SESSION_LOST ? 'AGENT_CHAT_EPHEMERAL_SESSION_LOST' : 'AGENT_CHAT_UNAVAILABLE',
      unavailable.message, 409, { reason: unavailable.reason })
    const existing = this.runtimes.get(row.id)
    if (existing?.session) {
      if (existing.session.nativeSessionId !== row.native_session_id) {
        throw new DomainError('AGENT_CHAT_SESSION_UNBOUND', 'Native session creation has not been durably bound.', 409)
      }
      return existing
    }
    await mkdir(this.runtimeDirectory(row.id), { recursive: true })
    this.assertOpen()
    signal.throwIfAborted()
    const runtime: Runtime = existing ?? { manager: this.managers(row.id, configuration, row.record.workingDirectory), configuration }
    this.runtimes.set(row.id, runtime)
    if (row.native_session_id && row.provider_version) {
      // Resume the exact stored session. Its startup instructions are already in native history.
      const attached = await runtime.manager.attachSession({ harness: row.harness, providerVersion: row.provider_version,
        nativeSessionId: row.native_session_id }, this.startInput(row, configuration, correlationId, true), signal)
      if (attached.nativeSessionId !== row.native_session_id || attached.harness !== row.harness) {
        throw new DomainError('AGENT_CHAT_SESSION_ID_MISMATCH', 'The native adapter returned a different chat session. No turn was sent.', 409)
      }
      runtime.session = attached
    } else {
      if (!row.active_request_id || !await this.repository.beginSessionCreation(row.id, row.active_request_id)) {
        throw new DomainError('AGENT_CHAT_SESSION_CREATION_UNCERTAIN', 'A native session may already exist. A replacement will not be created.', 409)
      }
      try {
        if (row.record.origin.kind === 'run_execution') {
          const origin = row.record.origin
          if (!runtime.manager.forkSession) throw new DomainError('AGENT_CHAT_FORK_UNAVAILABLE', 'This harness cannot continue a Run session in chat.', 409)
          const providerVersion = await this.sourceProviderVersion(origin, runtime)
          const forked = await runtime.manager.forkSession({ harness: row.harness, providerVersion, nativeSessionId: origin.sourceNativeSessionId },
            this.startInput(row, configuration, correlationId, true), signal)
          if (forked.nativeSessionId === origin.sourceNativeSessionId || forked.harness !== row.harness) {
            // Do not adopt or close a returned source/foreign session, even during failure cleanup.
            throw new DomainError('AGENT_CHAT_FORK_UNAVAILABLE', 'The harness did not create an independent chat fork. The Run session will not be changed.', 409)
          }
          runtime.session = forked
          await this.repository.bindSession(row.id, runtime.session.providerVersion, runtime.session.nativeSessionId)
          await this.repository.markStartupDelivered(row.id)
        } else {
          runtime.session = await runtime.manager.createSession(this.startInput(row, configuration, correlationId, false), signal)
          await this.repository.bindSession(row.id, runtime.session.providerVersion, runtime.session.nativeSessionId)
        }
      } catch (error) {
        // Binding/activation failure after successful creation must never authorize a replacement.
        if (!runtime.session && !nativeUnavailable(error) && definiteNonCreation(error, row)) {
          await this.release(row.id) // A cleanup failure keeps the original durable fence.
          throw new RejectedSessionCreation(error)
        }
        throw error
      }
    }
    return runtime
  }
  private async sourceProviderVersion(origin: Extract<AgentChatOrigin, { kind: 'run_execution' }>, runtime: Runtime): Promise<string> {
    // Provider metadata belongs to the same physical Run execution, never an unrelated
    // lane with a colliding native id (nor an Agent's most recently updated session).
    const row = (await this.pool.query<{ reference: unknown }>(`
      select s.reference from execution_native_sessions s
      join harness_executions e on e.id=s.execution_id
      where s.execution_id=$1 and e.run_id=$2`, [origin.executionId, origin.runId])).rows[0]
    if (row) {
      const reference = NativeSessionReferenceSchema.safeParse(row.reference)
      if (!reference.success || reference.data.nativeSessionId !== origin.sourceNativeSessionId
        || reference.data.harness !== runtime.manager.harness) {
        throw new DomainError('AGENT_CHAT_SESSION_ID_MISMATCH', 'The stored Run source session does not match this execution.', 409)
      }
      return reference.data.providerVersion
    }
    // Legacy executions may predate the native reference table. The exact source id still
    // goes to forkSession, which must prove it exists; no replacement create is attempted.
    return (await runtime.manager.capabilities(this.lifetime.signal)).providerVersion
  }

  /** Earlier configurations send pinned skills with the first turn; native-v1 delivers them at session start. */
  private prompt(row: AgentConversationRow, configuration: AgentConfigurationVersion, content: string): { text: string; startup: boolean } {
    if (row.record.origin.kind !== 'fresh' || row.record.startupDelivered) return { text: content, startup: false }
    if (configuration.instructionDelivery === 'native-v1') return { text: content, startup: true }
    const skills = legacySkillPrompt(configuration)
    // Codex receives the system prompt as native developer instructions at thread/start.
    const system = configuration.harness.harness === 'opencode' && configuration.prompt.system
      ? ['AGENT SYSTEM PROMPT', configuration.prompt.system, ''] : []
    if (!system.length && !skills.length) return { text: content, startup: true }
    return { text: [...system, ...skills, '', 'USER MESSAGE', content].join('\n'), startup: true }
  }

  private async runTurn(id: string, turn: AgentChatTurn): Promise<void> {
    const correlationId = agentChatCorrelation(id, turn.requestId)
    const signal = this.lifetime.signal
    const observer = new AbortController()
    let submitted = false
    let creatingSession = false
    let runtime: Runtime | undefined
    let prepared!: () => void
    const preparation = { requestId: turn.requestId, done: new Promise<void>((resolve) => { prepared = resolve }) }
    this.preparations.set(id, preparation)
    const finishPreparation = () => {
      if (this.preparations.get(id) === preparation) this.preparations.delete(id)
      prepared()
    }
    try {
      const row = await this.repository.get(id)
      if (!row || row.active_request_id !== turn.requestId) return
      if (row.cancel_requested) { await this.settle(id, turn.requestId, { outcome: 'canceled' }); return }
      const configuration = await this.workflows.getAgentConfiguration(row.agent_configuration_version_id)
      if (!configuration) throw new DomainError('AGENT_CHAT_CONFIGURATION_MISSING', 'The pinned Agent configuration is unavailable.', 409)
      creatingSession = !row.native_session_id
      runtime = await this.runtime(row, configuration, correlationId, signal)
      creatingSession = false
      const session = runtime.session!
      const content = await this.repository.turnContent(id, turn.requestId)
      if (content === undefined) throw new Error('The accepted message content is missing.')
      const fresh = await this.repository.get(id)
      if (!fresh || fresh.active_request_id !== turn.requestId) return
      // Stop may have committed while the first session was being created/bound. No turn was sent.
      if (fresh.cancel_requested) { await this.settle(id, turn.requestId, { outcome: 'canceled' }); return }
      signal.throwIfAborted()
      const prompt = this.prompt(fresh, configuration, content)
      const partKinds = new Map<string, string>()
      let nativeTurnId: string | null = null
      const currentEvent = openCodeTurnEvents(session.nativeSessionId, () => nativeTurnId)
      const redact = nativePersistenceRedactor([])
      finishPreparation()
      runtime.observer = { requestId: turn.requestId, controller: observer }
      for await (const event of runtime.manager.startTurn(session, {
        prompt: prompt.text, clientCorrelationId: correlationId,
        onSubmitted: async (id_) => {
          nativeTurnId = id_; submitted = true
          await this.repository.accepted(id, turn.requestId, id_)
          this.scheduleReconcile(id)
          this.events.publish(id, 'turn', { requestId: turn.requestId, delivery: 'accepted', nativeTurnId: id_ })
          // Re-read the captured target under the control fence, also for a late callback.
          void this.interruptActive(id, false, { requestId: turn.requestId, nativeTurnId: id_ }).catch(() => undefined)
        },
      }, AbortSignal.any([signal, observer.signal]))) {
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
      if (error instanceof RejectedSessionCreation) {
        // Retire the matching creation marker and terminal receipt in ONE ownership-fenced commit.
        // finish() also honors a Stop that committed while disposal was being confirmed.
        await this.settle(id, turn.requestId, failure(error.rejection), undefined, true)
        return
      }
      // Reconciliation can prove completion while OpenCode's SSE stays alive. Its observer
      // is detached only after finish() commits; this is neither failed delivery nor cancel.
      if (this.closing || observer.signal.aborted) return // Restart recovery reconciles in-flight work.
      const unavailable = await this.markNativeUnavailable(id, error)
      if (!unavailable && creatingSession && (await this.repository.get(id))?.record.sessionCreation) {
        // No reliable identity/commit means read-only, not another create/fork attempt.
        await this.repository.markSessionUnavailable(id, 'Native session creation could not be confirmed. This conversation is read-only; no replacement session will be created automatically.')
        await this.repository.abandon(id, turn.requestId, 'Native session creation or binding is unconfirmed.')
        this.events.publish(id, 'state', { requestId: turn.requestId, delivery: 'unknown' })
        return
      }
      if (!submitted && (unavailable || definiteRejection(error) || error instanceof DomainError)) {
        const current = await this.repository.get(id)
        await this.settle(id, turn.requestId, current?.cancel_requested ? { outcome: 'canceled' } : failure(error))
        if (unavailable) await this.release(id)
      } else {
        await this.repository.abandon(id, turn.requestId, error instanceof Error ? error.message : 'Native delivery is unconfirmed.')
        // Retain the manager: it may still own a late acknowledgement or a live native turn.
        this.scheduleReconcile(id)
        this.events.publish(id, 'state', { requestId: turn.requestId, delivery: 'unknown' })
      }
    } finally {
      finishPreparation()
      if (runtime?.observer?.controller === observer) delete runtime.observer
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
      // Acceptance can be learned without onSubmitted (lost ACK or restart after Stop's commit).
      // A cancel acknowledgement is not terminal proof and never releases the queue.
      await this.interruptActive(id, false, { requestId, nativeTurnId: history.nativeTurnId }, controlled)
      this.scheduleReconcile(id)
      this.events.publish(id, 'state', { requestId, delivery: 'accepted' })
    }
  }

  private async settle(id: string, requestId: string, result: ExecutionResult, nativeMessageId?: string, rejectedSessionCreation = false): Promise<void> {
    if (await this.repository.finish(id, requestId, result, nativeMessageId, rejectedSessionCreation)) {
      const observer = this.runtimes.get(id)?.observer
      if (observer?.requestId === requestId) observer.controller.abort(new Error('Agent chat turn settled.'))
      this.events.publish(id, 'message', { requestId })
      // Rejected creation may have become canceled under the repository lock. Invalidate rather
      // than publishing an outcome chosen before that concurrent Stop committed.
      this.events.publish(id, 'state', { requestId,
        ...(rejectedSessionCreation ? {} : { delivery: result.outcome === 'succeeded' ? 'completed' : result.outcome }) })
    }
  }

  /** Poll exact native history even when the event stream or an interrupt notification is silent. */
  private scheduleReconcile(id: string): void {
    if (this.closing || this.reconciliationTimers.has(id)) return
    const timer = setTimeout(() => {
      this.reconciliationTimers.delete(id)
      // Own the complete repair, including its post-control SQL reads, until shutdown drains it.
      void this.command(() => this.repair(id)).catch((error: unknown) => {
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
      if (!row || row.record.sessionUnavailable) return
      if (row.active_request_id && this.preparations.get(id)?.requestId === row.active_request_id) {
        this.scheduleReconcile(id)
        return // The live owner must finish creation/binding; a temporarily null identity is not loss.
      }
      const steers = await this.repository.unconfirmedSteers(id)
      const requestId = row.active_request_id
      // A steer-only recovery attaches using its ORIGINAL turn, never the steer as an active turn.
      const target = steers.find((entry) => entry.targetRequestId && entry.targetNativeTurnId)
      const recoveryRequestId = requestId ?? target?.targetRequestId
      if (!recoveryRequestId) {
        for (const steer of steers) if (steer.delivery === 'submitting') {
          await this.repository.unknown(id, steer.requestId, 'The original steering target is not established. No input was resent.')
          this.events.publish(id, 'turn', { requestId: steer.requestId, delivery: 'unknown' })
        }
        if (steers.length) this.scheduleReconcile(id)
        return
      }
      const correlationId = agentChatCorrelation(id, recoveryRequestId)
      try {
        if (!row.native_session_id) {
          await this.repository.markSessionUnavailable(id, 'No native session identity was stored before recovery. This conversation is read-only; no replacement session will be created automatically.')
          if (requestId) await this.repository.abandon(id, requestId, 'Native session creation is unconfirmed.')
          this.events.publish(id, 'state', { delivery: 'unknown' })
          return
        }
        const configuration = await this.workflows.getAgentConfiguration(row.agent_configuration_version_id)
        if (!configuration) throw new Error('The pinned Agent configuration is unavailable.')
        const binding = requestId ? row : { ...row, active_native_turn_id: target!.targetNativeTurnId }
        const runtime = await this.runtime(binding, configuration, correlationId, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000)]))
        if (requestId) await this.observe(id, requestId, runtime, correlationId, true)
        if (steers.length) {
          const identities = steers.flatMap((entry) => entry.targetNativeTurnId
            ? [{ clientCorrelationId: agentChatCorrelation(id, entry.requestId), expectedTurnId: entry.targetNativeTurnId }] : [])
          // This read must not retarget the manager's active correlation, even when a later turn owns it.
          const evidence = await runtime.manager.reconcileSteers?.(runtime.session!, identities,
            AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)])).catch((error: unknown) => {
              // Failure to read an OLD steer is not loss of the independently proven active turn.
              this.events.publish(id, 'error', { message: error instanceof Error ? error.message : 'Steer receipt lookup failed.' })
              return []
            }) ?? []
          let unresolved = false
          for (const steer of steers) {
            const proven = evidence.some((entry) => entry.nativeSessionId === row.native_session_id
              && entry.correlationId === agentChatCorrelation(id, steer.requestId)
              && entry.nativeTurnId === steer.targetNativeTurnId)
            if (proven) {
              await this.repository.steerAccepted(id, steer.requestId, steer.targetNativeTurnId!)
              this.events.publish(id, 'turn', { requestId: steer.requestId })
            } else {
              unresolved = true
              await this.repository.unknown(id, steer.requestId, 'The provider has not proven this steering input. It will not be resent automatically.')
              if (steer.delivery === 'submitting') this.events.publish(id, 'turn', { requestId: steer.requestId, delivery: 'unknown' })
            }
          }
          if (unresolved) this.scheduleReconcile(id)
        }
      } catch (error) {
        const unavailable = await this.markNativeUnavailable(id, error)
        if (requestId) await this.repository.abandon(id, requestId,
          `Native delivery is not yet confirmed. ${error instanceof Error ? error.message : ''}`.trim())
        // Also convert a crash-left provisional steer; missing evidence never means acceptance.
        for (const steer of steers) await this.repository.unknown(id, steer.requestId, 'Steer delivery is not yet confirmed.')
        if (unavailable) await this.release(id)
        else this.scheduleReconcile(id)
        this.events.publish(id, 'state', { delivery: 'unknown' })
      }
    })
    const current = await this.repository.get(id)
    if (current && !current.active_request_id && !current.record.sessionUnavailable && await this.repository.nextQueued(id)) this.pump(id)
  }

  private async release(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    runtime.retiring = true
    const disposal = runtime.disposal ??= Promise.resolve().then(async () => {
      if (runtime.manager.dispose) await runtime.manager.dispose()
      else if (runtime.session) await runtime.manager.close(runtime.session)
      else throw new Error('The unbound Agent chat manager cannot prove native disposal.')
      // Both maps retain ownership until cleanup positively succeeds.
      this.managers.release?.(id)
      this.runtimes.delete(id)
    })
    try { await disposal } catch (error) {
      if (runtime.disposal === disposal) delete runtime.disposal
      throw error
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Recover exact stored sessions; unresolved work remains fenced and is polled without resubmission. */
  recover(): Promise<void> {
    if (this.closing) return Promise.resolve()
    if (this.recovery) return this.recovery
    const task = Promise.resolve().then(() => this.recoverConversations())
    this.recovery = task
    void task.finally(() => { if (this.recovery === task) this.recovery = undefined }).catch(() => undefined)
    return task
  }
  private async recoverConversations(): Promise<void> {
    if (this.closing) return
    for (const row of await this.repository.open()) {
      if (this.closing) return
      await this.repair(row.id)
    }
  }

  shutdown(): Promise<void> {
    this.closing = true
    for (const timer of this.reconciliationTimers.values()) clearTimeout(timer)
    this.reconciliationTimers.clear()
    this.lifetime.abort(new Error('Agent chat is shutting down.'))
    if (this.shutdownAttempt) return this.shutdownAttempt
    const attempt = Promise.resolve().then(async () => {
      // An admitted command/recovery pass may still be awaiting SQL or publishing control work.
      // Drain producers before disposing managers or allowing the production owner to unlock.
      while (this.inflightCommands.size || this.tasks.size || this.controls.size || this.preparations.size || this.recovery) {
        await Promise.allSettled([...this.inflightCommands, ...this.tasks.values(), ...this.controls.values(),
          ...[...this.preparations.values()].map((entry) => entry.done), ...(this.recovery ? [this.recovery] : [])])
      }
      await this.commands.drain()
      const results = await Promise.allSettled([...this.runtimes.keys()].map((id) => this.release(id)))
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Agent chat native cleanup was incomplete; ownership is retained for retry.')
    })
    this.shutdownAttempt = attempt
    void attempt.catch(() => { if (this.shutdownAttempt === attempt) this.shutdownAttempt = undefined })
    return attempt
  }
}
