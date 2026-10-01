import { AcceptedChatResponseControlSchema, type ChatResponseAcknowledgment } from '@graphql/contracts/interaction-activity'
import type { OperatorChatCommands } from './operatorChatCommands.js'
import { pendingInteractionAfterHistory } from './pendingInteractionReadback.js'
import { qualifyChatActivity } from './qualifiedActivity.js'
import { reconcileKnownActivities } from './reconcileKnownActivities.js'
import { knownNativeActivity } from './knownNativeActivity.js'
import { committedNativeText } from './committedNativeText.js'
import { activityTextEnvelope } from './activityTextEnvelope.js'
import { nativeInteractionAvailability } from './interactionAvailability.js'
import { commandInputHash } from '../commands/postgres.js'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { access, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import {
  CodexSessionCompatibilitySchema, ConversationSchema, OperatorConversationStreamEventSchema, SendOperatorMessageRequestSchema,
  type NativeHarnessEvent, type OperatorActivityQuery, type OperatorConfigurationVersion, type OperatorConversationStreamEvent, type NativeSessionReference,
  type ExecutionResult, type SendOperatorMessageRequest, type RespondOperatorInteractionRequest, type OperatorChatSetup, type OperatorChatSetupQuery,
} from '@graphql/contracts'
import type { ManagementAction, ManagementPrincipal } from '@graphql/contracts/management'
import type { OperatorConversationHistoryQuery } from '@graphql/contracts/operator-chat'

import { DomainError } from '../errors.js'
import { requireAuthorization, isAuthorized } from '../access/policy.js'
import type { ChildProcessEnvironment, NativeHarnessSessionManager, NativeHistory } from '../harnesses/port.js'
import type { PostgresOperatorRepository } from '../operators/postgres.js'
import { withFilesystemDeadline } from '../workspaces/filesystem.js'
import { nativeCorrelation, PostgresOperatorConversationRepository, type ConversationRow } from './operatorChatRepository.js'
import { nativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { currentOperatorHistory, openCodeTurnEvents, operatorActivity } from './operatorActivity.js'
import { completedNativeAssistantMessage } from './operatorText.js'
import { nativeActivityFence } from './nativeActivityFence.js'
import { createNativeTextStream } from './nativeTextStream.js'

export { PostgresOperatorConversationRepository } from './operatorChatRepository.js'

/** Dedicated native cwd; it is neither a workspace nor an authority scope. */
export async function ensureOperatorRuntimeDirectory(managedRuntimeRoot: string): Promise<string> {
  const root = resolve(managedRuntimeRoot)
  return withFilesystemDeadline(async (check) => {
    await check(() => mkdir(root, { recursive: true }))
    const canonicalRoot = await check(() => realpath(root))
    const candidate = resolve(canonicalRoot, 'operator')
    await check(() => mkdir(candidate, { recursive: true }))
    const canonical = await check(() => realpath(candidate))
    const child = relative(canonicalRoot, canonical)
    if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
      throw new DomainError('OPERATOR_RUNTIME_DIRECTORY_INVALID', 'The Operator runtime directory must remain inside managed runtime storage.', 422)
    }
    await check(() => access(canonical, constants.R_OK | constants.W_OK | constants.X_OK))
    return canonical
  })
}

export class OperatorConversationEvents {
  private sequence = 0
  private readonly listeners = new Map<string, Set<(event: OperatorConversationStreamEvent) => void>>()
  publish(conversationId: string, type: OperatorConversationStreamEvent['type'], data: Record<string, unknown>) {
    const event = OperatorConversationStreamEventSchema.parse({ id: this.sequence++, conversationId, type, data })
    for (const listener of this.listeners.get(conversationId) ?? []) {
      try { listener(event) } catch { /* A disconnected subscriber cannot fail a native turn. */ }
    }
  }
  subscribe(id: string, listener: (event: OperatorConversationStreamEvent) => void) {
    const listeners = this.listeners.get(id) ?? new Set()
    listeners.add(listener); this.listeners.set(id, listeners)
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id) }
  }
}

export interface NativeManagerResolver {
  (configuration: OperatorConfigurationVersion, conversationId: string, fileInputs?: boolean): NativeHarnessSessionManager
  /** Resolve the accepted receipt, not the caller's current route or upload owner. */
  hasFileInputs?(conversationId: string, requestId: string): Promise<boolean>
  /** After durable native acknowledgement, before either file bridge issues authority. */
  recordFileSubmission?(conversationId: string, requestId: string, nativeTurnId: string): Promise<void>
  release?(conversationId: string): void
}
export interface OperatorChatAuthority {
  current(principalId: string): Promise<ManagementPrincipal>
  assertConfiguration(configuration: OperatorConfigurationVersion): void
  setup(manager: NativeHarnessSessionManager, signal: AbortSignal, configuration?: OperatorConfigurationVersion): Promise<OperatorChatSetup>
  prepare(manager: NativeHarnessSessionManager, configuration: OperatorConfigurationVersion, conversationId: string,
    principalId: string, signal: AbortSignal): Promise<ChildProcessEnvironment>
  release(conversationId: string): Promise<void>
}
interface Runtime {
  fileInputs?: boolean
  configuration?: OperatorConfigurationVersion
  manager: NativeHarnessSessionManager
  session?: NativeSessionReference
  environment?: ChildProcessEnvironment
  disposal?: Promise<void>
  /** Dummy-credential attachment: inspection/responses only, never launch another turn. */
  observationOnly?: boolean
}
function failure(error: unknown): ExecutionResult {
  const provider = error && typeof error === 'object' && 'result' in error
    ? (error as { result?: ExecutionResult }).result?.error : undefined
  return { outcome: 'failed', error: { code: provider?.code ?? (error && typeof error === 'object'
    && 'code' in error && typeof error.code === 'string' ? error.code : 'OPERATOR_SETUP_FAILED'),
    message: provider?.message ?? (error instanceof Error ? error.message : 'Operator setup failed.'), retryable: true } }
}

/** Only evidence about the attempted prompt, never a later history/approval error. */
function definitePromptRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('certainty' in error) return error.certainty === 'definite'
  // Codex's RPC contract predates NativeDeliveryCertainty. A rejected read or
  // interrupt is not evidence that turn/start was rejected.
  return 'method' in error && error.method === 'turn/start'
    && 'uncertain' in error && error.uncertain === false
}
function definiteCreationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('certainty' in error) return error.certainty === 'definite'
  if ('uncertain' in error && error.uncertain === true) return false
  const code = 'result' in error ? (error as { result?: ExecutionResult }).result?.error?.code : undefined
  return Boolean(code && /(?:AUTH_|VERSION_|CONFIGURATION_|SETTING_|SCOPED_ENVIRONMENT_|OWNER_MISMATCH|MCP_|REQUEST_FAILED)/.test(code))
}

export class OperatorChatService {
  readonly events = new OperatorConversationEvents()
  private readonly runtimes = new Map<string, Runtime>()
  private readonly tasks = new Map<string, { requestId: string; controller: AbortController; promise: Promise<void> }>()
  private readonly accepting = new Set<Promise<unknown>>()
  private readonly acceptanceControllers = new Set<AbortController>()
  private readonly controls = new Map<string, Promise<unknown>>()
  private readonly responding = new Set<string>()
  private readonly lifetime = new AbortController()
  private reconciliation: Promise<void> | undefined
  private closing = false
  private shutdownTask: Promise<void> | undefined
  private commandReceipts: OperatorChatCommands | undefined
  private setupCheck: { configurationId: string; promise: Promise<OperatorChatSetup> } | undefined

  constructor(
    private readonly repository: PostgresOperatorConversationRepository,
    private readonly operators: PostgresOperatorRepository,
    private readonly managers: NativeManagerResolver,
    private readonly workingDirectory: string,
    private readonly authority: OperatorChatAuthority,
  ) {}

  private receipts() { return this.commandReceipts ??= this.repository.createControlCommands() }
  private async controlRead(id: string, principal: ManagementPrincipal, action: 'operator_chat:cancel' | 'operator_chat:respond') {
    await this.assertAccess(id, principal, action)
    return this.get(id, principal)
  }

  private control<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.controls.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.controls.set(id, next)
    void next.finally(() => { if (this.controls.get(id) === next) this.controls.delete(id) }).catch(() => undefined)
    return next
  }
  private assertOpen(): void {
    if (this.closing) throw new DomainError('OPERATOR_CHAT_CLOSING', 'Operator chat is shutting down.', 503)
  }
  private validate(configuration: OperatorConfigurationVersion): void {
    if (configuration.harness.harness === 'codex') {
      CodexSessionCompatibilitySchema.parse({ configuration: configuration.harness, requiresResume: true })
    }
    this.authority.assertConfiguration(configuration)
  }
  async setup(principal: ManagementPrincipal, input: OperatorChatSetupQuery = {}): Promise<OperatorChatSetup> {
    this.assertOpen(); requireAuthorization(principal, 'harnesses:read')
    const row = input.conversationId ? await this.assertAccess(input.conversationId, principal) : undefined
    const accepted = row && input.requestId ? await this.repository.acceptedConfiguration(row.id, input.requestId) : undefined
    let configuration = accepted ?? (input.configurationVersionId
      ? await this.repository.configuration(input.configurationVersionId) : undefined)
    if (input.configurationVersionId && !configuration) throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'The pending command configuration is unavailable.', 409)
    // Legacy pending payloads did not include a pin. Prefer their matching idle
    // conversation configuration, never a different current harness's defaults.
    if (!configuration && row && (!input.harness || input.harness === row.harness)) {
      configuration = await this.repository.configuration(row.operator_configuration_version_id)
    }
    configuration ??= await this.operators.inspectionConfiguration(input.expectedDefaultsRevision)
    if ((input.harness && configuration.harness.harness !== input.harness)
      || (row && configuration.operatorId !== 'application-operator')) {
      throw new DomainError('OPERATOR_CONFIGURATION_CONFLICT', 'The requested message configuration does not match its Operator harness.', 409)
    }
    const selected = configuration
    const configurationId = `${selected.id}:${selected.contentHash}`
    if (this.setupCheck?.configurationId === configurationId) return this.setupCheck.promise
    const check = (async () => {
      const id = `operator-setup:${randomUUID()}`
      const manager = this.managers(selected, id)
      try {
        const result = await this.authority.setup(manager, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]), selected)
        return { ...result, ...(selected.id === 'application-operator-inspection' ? {} : { configurationVersionId: selected.id }) }
      } finally { try { await manager.dispose?.() } finally { this.managers.release?.(id) } }
    })()
    this.setupCheck = { configurationId, promise: check }
    this.accepting.add(check)
    void check.finally(() => { if (this.setupCheck?.promise === check) this.setupCheck = undefined; this.accepting.delete(check) }).catch(() => undefined)
    return check
  }
  async assertAccess(id: string, principal: ManagementPrincipal, action: ManagementAction = 'operator_chat:read', includeDeleted = false) {
    requireAuthorization(principal, action)
    requireAuthorization(await this.authority.current(principal.id), action)
    const row = await this.repository.active(id)
    if (!row || (!includeDeleted && row.deleted_at) || row.owner_principal_id !== principal.id) {
      throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
    }
    return row
  }
  async create(principal: ManagementPrincipal, title?: string) {
    this.assertOpen(); requireAuthorization(principal, 'operator_chat:write')
    const { operator, configuration } = await this.operators.ensure()
    this.assertOpen()
    return this.repository.create(operator.id, configuration, principal.id, title)
  }
  async setDeleted(id: string, principal: ManagementPrincipal, deleted: boolean) {
    this.assertOpen()
    return this.control(id, async () => {
      const row = await this.assertAccess(id, principal, 'operator_chat:write', true)
      await this.repository.setDeleted(id, row.owner_principal_id!, deleted)
      return { conversationId: id }
    })
  }
  list(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'operator_chat:read')
    return this.repository.list(principal.id)
  }
  summaries(principal: ManagementPrincipal, limit?: number, attentionOnly = false) {
    requireAuthorization(principal, 'operator_chat:read')
    return this.repository.summaries(principal.id, limit, attentionOnly)
  }
  async get(id: string, principal: ManagementPrincipal) {
    await this.assertAccess(id, principal)
    const state = await this.repository.getWithActivity(id)
    if (!state) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
    const current = await this.authority.current(principal.id)
    requireAuthorization(current, 'operator_chat:read')
    const runtime = this.runtimes.get(id)
    const responseAvailability = state.pendingInteraction ? await nativeInteractionAvailability(state.pendingInteraction,
      isAuthorized(current, 'operator_chat:respond'), runtime?.session ? { manager: runtime.manager, session: runtime.session } : undefined,
      { signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5_000)]),
        isCurrent: () => this.runtimes.get(id) === runtime && !!runtime?.session && !runtime.disposal && !this.closing }) : undefined
    const finalPrincipal = await this.authority.current(principal.id)
    requireAuthorization(finalPrincipal, 'operator_chat:read')
    const qualifiedResponse = responseAvailability && !isAuthorized(finalPrincipal, 'operator_chat:respond')
      ? { ...responseAvailability, available: false, status: 'unavailable' as const, path: null,
        reason: 'unauthorized' as const, message: 'Your current grants do not allow responding to this interaction.' } : responseAvailability
    const activitySnapshot = qualifyChatActivity(state.activitySnapshot, qualifiedResponse)
    return { ...state, activitySnapshot, ...(qualifiedResponse ? { responseAvailability: qualifiedResponse } : {}),
      qualificationKey: commandInputHash({ principal: finalPrincipal, revision: state.revision, sourceRevisions: state.activitySnapshot.sourceRevisions,
        responseAvailability: qualifiedResponse ?? null }).slice(7) }
  }

  async history(id: string, principal: ManagementPrincipal, query: Partial<OperatorConversationHistoryQuery> = {}) {
    // Read-only recovery uses the same owner boundary as the live transcript.
    // A recovered request ID is never submitted or approved by this endpoint.
    await this.assertAccess(id, principal)
    const page = await this.repository.history(id, query)
    if (!page) throw new DomainError('CONVERSATION_NOT_FOUND', 'Conversation was not found.', 404)
    return page
  }

  async handoffHistory(principal: ManagementPrincipal, sourceConversationId?: string, before?: string) {
    this.assertOpen(); requireAuthorization(principal, 'operator_handoff:read')
    return this.repository.handoffHistory(principal.id, sourceConversationId, before)
  }

  async activityPage(id: string, principal: ManagementPrincipal, input: Partial<OperatorActivityQuery>) {
    await this.assertAccess(id, principal)
    return this.repository.activity.page(id, input)
  }

  private async recordActivity(id: string, requestId: string, runtime: Runtime, event: NativeHarnessEvent, nativeTurnId: string | null, authoritativeReconciliation = false) {
    const known = knownNativeActivity(event, runtime.manager.harness)
    if (known) {
      const settled = await this.repository.activity.settleKnownByNative(id, known.change, known.native)
      if (settled) { this.events.publish(id, 'activity', settled); return }
      if (known.native.sessionId !== runtime.session?.nativeSessionId || known.native.turnId !== nativeTurnId) return
    }
    const change = operatorActivity(event, runtime.manager.harness, requestId)
    if (!change) return
    const showThinking = runtime.configuration?.harness.harness === 'opencode'
      ? runtime.configuration.harness.thinking : runtime.configuration?.showThinking === true
    if (change.kind === 'thinking' && !showThinking) return
    const safe = nativePersistenceRedactor(Object.values(runtime.environment?.variables ?? {})).value(change)
    if (!runtime.session || !nativeTurnId) {
      this.events.publish(id, 'state', { requestId, snapshotRequired: true })
      void this.control(id, () => this.observe(id, requestId, runtime)).catch(() => undefined)
      return
    }
    const accepted = await this.repository.activity.append(id, requestId, safe, {
      ...nativeActivityFence(runtime.session, nativeTurnId, event, authoritativeReconciliation),
      onReconciliationRequired: () => {
        this.events.publish(id, 'state', { requestId, snapshotRequired: true })
        void this.control(id, () => this.observe(id, requestId, runtime)).catch(() => undefined)
      },
    })
    if (accepted) this.events.publish(id, 'activity', accepted)
  }
  private async recordAssistantMessage(id: string, requestId: string, runtime: Runtime, event: NativeHarnessEvent, precedingActivityId?: string | null) {
    const message = completedNativeAssistantMessage(event, runtime.manager.harness)
    if (!message) return true
    if (await this.repository.appendAssistantMessage(id, requestId, message.id, message.text,
      message.parentMessageId ? { parentMessageId: message.parentMessageId, complete: message.complete === true } : undefined,
      precedingActivityId)) {
      this.events.publish(id, 'message', { requestId, nativeMessageId: message.id })
      return true
    }
    return false
  }

  send(id: string, value: SendOperatorMessageRequest, principal: ManagementPrincipal) {
    this.assertOpen()
    const controller = new AbortController()
    this.acceptanceControllers.add(controller)
    const promise = this.accept(id, value, principal, controller).finally(() => {
      this.accepting.delete(promise); this.acceptanceControllers.delete(controller)
    })
    this.accepting.add(promise)
    return promise
  }
  private async accept(id: string, value: SendOperatorMessageRequest, principal: ManagementPrincipal, controller: AbortController) {
    const input = SendOperatorMessageRequestSchema.parse(value)
    const row = await this.assertAccess(id, principal, 'operator_chat:write')
    // Resolve receipts before reading mutable defaults or validating a native
    // installation. A recovered receipt is not a request for a new native turn.
    const sourceReceipt = await this.repository.hasTurn(id, input.requestId)
    const childId = `operator-fork:${input.requestId}`
    const child = sourceReceipt ? undefined : await this.repository.active(childId)
    const childReceipt = child?.parent_conversation_id === id && child.owner_principal_id === row.owner_principal_id
      && child.fork_request_id === input.requestId && await this.repository.hasTurn(childId, input.requestId)
    const receiptId = sourceReceipt ? id : childReceipt ? childId : undefined
    if (input.recovery === 'receipt') {
      if (!receiptId) throw new DomainError('OPERATOR_RECEIPT_NOT_FOUND', 'No receipt is currently visible for this command.', 404)
      // This branch cannot call validate, setup, prepare, or runTurn, even for
      // a retryable receipt. A missing receipt is not evidence of non-delivery.
      return this.control(receiptId, () => this.repository.beginTurn(receiptId, input, row.owner_principal_id!, undefined, undefined, true))
    }
    if (ConversationSchema.parse(row.record).status === 'archived') {
      throw new DomainError('CONVERSATION_ARCHIVED', 'This conversation is read-only.', 409)
    }
    const configuration = receiptId ? undefined : await this.repository.configuration(row.operator_configuration_version_id)
    if (!receiptId && !configuration) throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'Pinned Operator configuration was not found.', 409)
    const harness = configuration ? await this.repository.harnessForMessage(configuration, input) : undefined
    const fork = Boolean(harness && harness.harness !== row.harness && await this.repository.hasMessages(id))
    const admit = () => this.control(id, async () => {
      this.assertOpen(); controller.signal.throwIfAborted()
      requireAuthorization(await this.authority.current(row.owner_principal_id!), 'operator_chat:write')
      const begun = receiptId
        ? await this.repository.beginTurn(receiptId, input, row.owner_principal_id!, undefined, undefined, false,
            (accepted) => this.validate(accepted))
        : fork
          ? await this.repository.beginForkTurn(id, input, row.owner_principal_id!, harness!, configuration!.id,
              (accepted) => this.validate(accepted))
          : await this.repository.beginTurn(id, input, row.owner_principal_id!, input.settings ? harness : undefined,
              configuration!.id, false, (accepted) => this.validate(accepted))
      if (begun.replayed) return begun
      const targetId = begun.state.conversation.id
      const acceptedId = begun.state.conversation.operatorConfigurationVersionId!
      let accepted: OperatorConfigurationVersion
      try {
        const saved = await this.repository.configuration(acceptedId)
        if (!saved) throw new Error('Accepted Operator configuration disappeared.')
        accepted = saved
        this.validate(accepted)
        const resident = this.runtimes.get(targetId)
        if (resident && resident.configuration?.id !== accepted.id) await this.release(targetId)
        if (this.closing || controller.signal.aborted) throw new Error('Operator chat stopped before native submission.')
      } catch (error) {
        await this.repository.finish(targetId, input.requestId, failure(error), undefined, true)
        throw error
      }
      const taskController = new AbortController()
      const promise = this.runTurn(targetId, input, accepted, row.owner_principal_id!, taskController.signal)
        .finally(() => { if (this.tasks.get(targetId)?.promise === promise) this.tasks.delete(targetId) })
      this.tasks.set(targetId, { requestId: input.requestId, controller: taskController, promise })
      void promise.catch(() => undefined) // Persistence failure leaves the accepted identity fenced.
      return begun
    })
    return fork || childReceipt ? this.control(childId, admit) : admit()
  }

  private async runtime(id: string, row: ConversationRow, configuration: OperatorConfigurationVersion, signal: AbortSignal,
    fileInputs: boolean): Promise<Runtime> {
    signal.throwIfAborted()
    const resident = this.runtimes.get(id)
    if (resident && (resident.observationOnly || Boolean(resident.fileInputs) !== fileInputs)) await this.release(id)
    const existing = this.runtimes.get(id)
    if (existing?.session) {
      if (!fileInputs && (await this.authority.setup(existing.manager, signal, configuration)).status !== 'configured') {
        throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'Install and enable the graphql MCP connection in the selected harness before chatting.', 409)
      }
      existing.configuration = configuration; return existing
    }
    const runtime: Runtime = existing ?? { manager: this.managers(configuration, id, fileInputs), fileInputs }
    runtime.configuration = configuration
    this.runtimes.set(id, runtime) // Includes managers still starting; shutdown must see them.
    // File turns never acquire the management token, including on an existing
    // native session. Fence an older token before attaching a file-only child.
    if (fileInputs) await this.authority.release(id)
    const environment = fileInputs ? { agentId: configuration.operatorId, variables: {} }
      : await this.authority.prepare(runtime.manager, configuration, id, row.owner_principal_id!, signal)
    runtime.environment = environment
    signal.throwIfAborted(); this.assertOpen()
    if (row.native_session_id) {
      runtime.session = await runtime.manager.attachSession({ harness: row.harness,
        providerVersion: row.provider_version ?? 'unknown', nativeSessionId: row.native_session_id }, {
        kind: 'operator', correlationId: nativeCorrelation(id, row.active_request_id!), configuration,
        workingDirectory: this.workingDirectory, environment,
        ...(row.active_native_turn_id ? { nativeTurnId: row.active_native_turn_id } : {}),
      }, signal)
    }
    return runtime
  }

  /** No setup check, delegated credential issuance, new session, or new prompt. */
  private async observationRuntime(id: string, row: ConversationRow, configuration: OperatorConfigurationVersion,
    signal: AbortSignal): Promise<Runtime> {
    signal.throwIfAborted()
    const resident = this.runtimes.get(id)
    if (resident?.session) { resident.configuration = configuration; return resident }
    return this.cleanupRuntime(id, row, configuration, signal)
  }

  /** Existing owned work can be inspected/stopped without authority to launch new work. */
  private async cleanupRuntime(id: string, row: ConversationRow, configuration: OperatorConfigurationVersion,
    signal: AbortSignal): Promise<Runtime> {
    if (!row.native_session_id || !row.active_request_id) throw new Error('Cleanup requires a durable native session and request.')
    const fileInputs = await this.managers.hasFileInputs?.(id, row.active_request_id) ?? false
    if (this.runtimes.has(id) && !this.runtimes.get(id)?.session) {
      // A failed credentialed attach may have left a bound manager. Dispose that
      // context before a cleanup-only attach; the durable request stays fenced.
      await this.release(id)
    }
    const runtime: Runtime = this.runtimes.get(id) ?? { manager: this.managers(configuration, id, fileInputs), fileInputs }
    this.runtimes.set(id, runtime)
    if (!runtime.session) {
      runtime.session = await runtime.manager.attachSession({ harness: row.harness,
        providerVersion: row.provider_version ?? 'unknown', nativeSessionId: row.native_session_id }, {
        kind: 'operator', correlationId: nativeCorrelation(id, row.active_request_id), configuration,
        workingDirectory: this.workingDirectory,
        // Required native environment references still need a value on attach.
        // This is deliberately NOT an issued credential: the App rejects it.
        // Do not mint fresh owner authority merely to inspect/stop old work.
        environment: { agentId: configuration.operatorId,
          variables: fileInputs ? {} : { GRAPHQL_MCP_TOKEN: 'operator-cleanup-disabled' } },
        ...(row.active_native_turn_id ? { nativeTurnId: row.active_native_turn_id } : {}),
      }, signal)
    }
    runtime.configuration = configuration
    // A detached, dummy-credential attach cannot be reused to launch another turn.
    runtime.observationOnly = true
    // OpenCode history reads can consume automatic permissions. Stop that local
    // responder before any cleanup read, including immediately after reattachment.
    if (configuration.harness.harness === 'opencode'
      && (configuration.harness.autoApprove || configuration.harness.advanced?.permissionHandling === 'native_auto')
      && !runtime.manager.stopAutomaticResponses) {
      throw new Error('The native manager does not support approval-free cleanup.')
    }
    runtime.manager.stopAutomaticResponses?.(runtime.session)
    return runtime
  }

  private async runTurn(id: string, input: SendOperatorMessageRequest, configuration: OperatorConfigurationVersion, ownerId: string, signal: AbortSignal) {
    let creating = false
    let submitting = false
    let submitted = false
    let textStream: ReturnType<typeof createNativeTextStream> | undefined
    try {
      let row = await this.repository.active(id)
      if (!row || row.active_request_id !== input.requestId) return
      const fileInputs = Boolean(input.attachments?.length)
      const admittedFiles = await this.managers.hasFileInputs?.(id, input.requestId) ?? false
      if (fileInputs !== admittedFiles || fileInputs && !this.managers.recordFileSubmission) throw new DomainError(
        'OPERATOR_FILE_DELIVERY_UNAVAILABLE', 'The accepted Operator attachments have no native delivery binding.', 409)
      const runtime = await this.runtime(id, row, configuration, signal, fileInputs)
      if (!runtime.session) {
        if (!await this.repository.phase(id, input.requestId, 'creating')) {
          await this.control(id, () => this.complete(id, input.requestId, { outcome: 'canceled' })); return
        }
        const environment = runtime.environment
        if (!environment || row.owner_principal_id !== ownerId) throw new Error('Operator launch authority is unavailable.')
        signal.throwIfAborted(); this.assertOpen()
        creating = true
        runtime.session = await runtime.manager.createSession({ kind: 'operator', correlationId: nativeCorrelation(id, input.requestId),
          configuration, workingDirectory: this.workingDirectory, environment }, signal)
        // Save the returned identity even when cancellation arrived during creation.
        await this.repository.bind(id, input.requestId, runtime.session.providerVersion, runtime.session.nativeSessionId)
        creating = false
      }
      signal.throwIfAborted(); this.assertOpen()
      row = await this.repository.active(id)
      if (!row || row.active_request_id !== input.requestId) { await this.release(id); return }
      requireAuthorization(await this.authority.current(ownerId), 'operator_chat:write')
      signal.throwIfAborted(); this.assertOpen()
      const includeHandoff = Boolean(row.handoff_context
        && !await this.repository.handoffInitialized(id, runtime.session.nativeSessionId))
      if (!await this.repository.phase(id, input.requestId, 'submitting', includeHandoff)) {
        await this.control(id, () => this.complete(id, input.requestId, { outcome: 'canceled' })); return
      }
      signal.throwIfAborted(); this.assertOpen()
      submitting = true
      const correlationId = nativeCorrelation(id, input.requestId)
      const hint = input.context && Object.values(input.context).some(Boolean)
        ? `\n\n[Non-authoritative route context: ${JSON.stringify(input.context)}]` : ''
      let submittedTurnId = row.active_native_turn_id
      const textOwner = () => ({ scope: { kind: 'operator_chat' as const, conversationId: id },
        requestId: input.requestId, sessionId: runtime.session!.nativeSessionId,
        ...(submittedTurnId ? { turnId: submittedTurnId } : {}) })
      const redactText = nativePersistenceRedactor(Object.values(runtime.environment?.variables ?? {}))
      const committed = committedNativeText({ id, requestId: input.requestId, repository: this.repository,
        harness: runtime.manager.harness, session: runtime.session, owner: textOwner, sanitize: (operation) => redactText.value(operation),
        reconcile: () => { void this.control(id, () => this.observe(id, input.requestId, runtime)).catch(() => undefined) } })
      textStream = createNativeTextStream({
        signal, harness: runtime.manager.harness,
        owner: textOwner,
        publish: (operation) => {
          // Raw reasoning is never promoted to a public assistant answer; safe summaries use activity records.
          if (operation.identity.channel !== 'assistant') return
          this.events.publish(id, 'delta', { requestId: input.requestId, activityChange: activityTextEnvelope(redactText.value(operation), runtime.manager.harness),
            ...(committed.revision() ? { scopeRevision: committed.revision() } : {}) })
        },
        reconcile: () => this.events.publish(id, 'state', { requestId: input.requestId, snapshotRequired: true }),
      })
      const currentEvent = openCodeTurnEvents(runtime.session.nativeSessionId, () => submittedTurnId)
      for await (const event_ of runtime.manager.startTurn(runtime.session, {
        prompt: `${includeHandoff ? `${row.handoff_context}\n\nCurrent user message:\n` : ''}${input.content}${hint}`, clientCorrelationId: correlationId,
        onSubmitted: async (nativeTurnId) => {
          submittedTurnId = nativeTurnId
          // A callback is native evidence even when saving its identity fails.
          // No subsequent definite error can make this prompt safe to replay.
          submitted = true
          const cancelRequested = await this.control(id, async () => {
            if (!await this.repository.submitted(id, input.requestId, nativeTurnId)) throw new Error('Native turn ownership was lost.')
            if (runtime.fileInputs) await this.managers.recordFileSubmission!(id, input.requestId, nativeTurnId)
            const current = await this.repository.active(id)
            textStream?.flush()
            this.events.publish(id, 'state', { requestId: input.requestId, activeRequestId: input.requestId,
              revision: Number(current?.revision), turnState: current?.cancel_requested ? 'canceling' : 'active' })
            return Boolean(current && current.active_request_id === input.requestId && current.cancel_requested)
          })
          if (cancelRequested) {
            // OpenCode invokes this callback under its native lifecycle lock.
            // Persist identity before acknowledging submission, but NEVER await
            // a native operation here. The tracked control queue owns delivery
            // after this callback returns and releases that native lock.
            void this.control(id, async () => {
              const current = await this.repository.active(id)
              if (!current || current.active_request_id !== input.requestId || !current.cancel_requested) return
              try {
                await this.interrupt(id, current, runtime)
                await this.observe(id, input.requestId, runtime, AbortSignal.timeout(5_000))
              } catch (error) {
                await this.repository.uncertain(id, input.requestId,
                  error instanceof Error ? error.message : 'Cancellation delivery is uncertain.')
                this.events.publish(id, 'error', { requestId: input.requestId, turnState: 'uncertain' })
              } finally {
                // Native completion was checked above. Detach a silent SSE reader
                // so an unproven result remains recoverable by durable reconciliation.
                const task = this.tasks.get(id)
                if (task && task.requestId === input.requestId) task.controller.abort()
              }
            }).catch(() => undefined) // Persistence failure leaves the accepted request fenced.
          }
        },
      }, signal)) {
        // After native output, errors from pending/history reads are not prompt rejections.
        submitted = true
        for (const event of runtime.manager.harness === 'opencode' ? currentEvent(event_) : [event_]) {
          textStream.before(event)
          await this.recordActivity(id, input.requestId, runtime, event, submittedTurnId)
          const text = await committed.record(event, submittedTurnId)
          if (text.allowed && (text.handled || await this.recordAssistantMessage(id, input.requestId, runtime, event))) textStream.push(event)
          else textStream.rejected(event)
          if (text.final) this.events.publish(id, 'message', { requestId: input.requestId, snapshotRequired: true,
            scopeRevision: committed.revision() })
          if (event.type === 'interaction.pending' || event.type === 'permission.asked') {
            const pending = await runtime.manager.pending(runtime.session, signal)
            if (pending) {
              await this.repository.pending(id, input.requestId, pending)
              this.events.publish(id, 'state', { requestId: input.requestId, pending: true })
              return // Native request stays resident. The periodic reconciler observes its continuation.
            }
          }
        }
      }
      textStream.flush()
      submitted = true
      await this.control(id, () => this.observe(id, input.requestId, runtime))
    } catch (error) {
      if (signal.aborted) textStream?.dispose(); else textStream?.flush()
      if (submitted || (submitting && !definitePromptRejection(error)) || (creating && !definiteCreationFailure(error))) {
        await this.repository.uncertain(id, input.requestId, error instanceof Error ? error.message : 'Native delivery is uncertain.')
      } else {
        await this.control(id, async () => {
          const current = await this.repository.active(id)
          if (!current || current.active_request_id !== input.requestId) return
          await this.complete(id, input.requestId, current.cancel_requested ? { outcome: 'canceled' } : failure(error),
            undefined, !current.cancel_requested)
        })
      }
      this.events.publish(id, 'error', { requestId: input.requestId, message: error instanceof Error ? error.message : 'Operator turn failed.' })
    } finally { textStream?.dispose() }
  }

  private async complete(id: string, requestId: string, result: ExecutionResult, nativeMessageId?: string, retryable = false) {
    // Callers serialize terminal decisions with cancel/response delivery through control().
    await this.release(id)
    if (await this.repository.finish(id, requestId, result, nativeMessageId, retryable)) {
      this.events.publish(id, 'message', { requestId })
      this.events.publish(id, 'state', { requestId, turnState: result.outcome === 'failed' ? 'error' : 'idle' })
    }
  }
  private async stopRuntime(id: string, runtime: Runtime | undefined): Promise<void> {
    // Start revocation first, but a database failure must not skip native disposal.
    const revoking = this.authority.release(id)
    if (runtime && !runtime.disposal) {
      const disposal = (async () => {
        if (runtime.manager.dispose) await runtime.manager.dispose()
        else if (runtime.session) await runtime.manager.close(runtime.session)
      })()
      runtime.disposal = disposal
      void disposal.catch(() => { if (runtime.disposal === disposal) delete runtime.disposal })
    }
    const results = await Promise.allSettled([revoking, ...(runtime?.disposal ? [runtime.disposal] : [])])
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Operator native disposal or credential revocation failed.')
  }
  private async release(id: string) {
    await this.stopRuntime(id, this.runtimes.get(id))
    this.runtimes.delete(id); this.managers.release?.(id)
  }
  private async observe(id: string, requestId: string, runtime: Runtime, signal = this.lifetime.signal): Promise<void> {
    if (!runtime.session) return
    const row = await this.repository.active(id)
    if (!row || row.active_request_id !== requestId) return
    const correlationId = nativeCorrelation(id, requestId)
    const history: NativeHistory = await runtime.manager.reconcile(runtime.session, correlationId, signal)
    if (runtime.session.nativeSessionId !== row.native_session_id || history.correlationId !== correlationId || !history.nativeTurnId
      || (row.active_native_turn_id && row.active_native_turn_id !== history.nativeTurnId)) {
      await this.repository.uncertain(id, requestId, 'The provider has not proven the identity of this request. No new turn will be submitted.')
      return
    }
    if (!await this.repository.submitted(id, requestId, history.nativeTurnId)) return
    if (runtime.fileInputs) await this.managers.recordFileSubmission!(id, requestId, history.nativeTurnId)
    let precedingActivityId: string | null = null
    const showThinking = runtime.configuration?.harness.harness === 'opencode'
      ? runtime.configuration.harness.thinking : runtime.configuration?.showThinking === true
    for (const event of currentOperatorHistory(history, runtime.manager.harness)) {
      await this.recordActivity(id, requestId, runtime, event, history.nativeTurnId, true)
      const change = operatorActivity(event, runtime.manager.harness, requestId)
      if (change && (change.kind !== 'thinking' || showThinking)) precedingActivityId = change.id
      await this.recordAssistantMessage(id, requestId, runtime, event,
        runtime.manager.harness === 'opencode' ? precedingActivityId : undefined)
    }
    const currentOwner = await this.repository.active(id)
    if (!currentOwner || currentOwner.active_request_id !== requestId || currentOwner.native_session_id !== row.native_session_id) return
    const pending = pendingInteractionAfterHistory(currentOwner.pending_interaction, history)
    await this.repository.pending(id, requestId, pending)
    if (history.terminalResult && !pending) {
      await this.complete(id, requestId, history.terminalResult, history.nativeMessageId)
    } else {
      const current = await this.repository.active(id)
      if (!current || current.active_request_id !== requestId) return
      if (current.cancel_requested) {
        await this.interrupt(id, { ...current, active_native_turn_id: history.nativeTurnId }, runtime)
        return
      }
      this.events.publish(id, 'state', { requestId, turnState: 'active', pending: Boolean(pending) })
    }
  }
  private async interrupt(id: string, row: ConversationRow, runtime: Runtime): Promise<void> {
    if (!runtime.session || !row.active_native_turn_id || !row.active_request_id) return
    const acknowledged = await runtime.manager.cancel(runtime.session, AbortSignal.timeout(5_000), row.active_native_turn_id)
    // Neither false nor an interrupt ACK establishes terminal completion.
    if (!acknowledged) await this.repository.uncertain(id, row.active_request_id, 'The provider did not acknowledge cancellation; reconciliation will continue.')
    this.events.publish(id, 'state', { requestId: row.active_request_id, turnState: 'canceling' })
  }

  async cancel(id: string, requestId: string, principal: ManagementPrincipal, commandId?: string, source: 'http' | 'mcp' = 'http') {
    this.assertOpen()
    await this.assertAccess(id, principal, 'operator_chat:cancel')
    const key = commandId ?? `operator-cancel:${commandInputHash([requestId]).slice(7)}`
    return this.receipts().execute(principal, source, id, key, { kind: 'cancel', requestId },
      (markDispatchAttempt) => this.cancelNative(id, requestId, principal, markDispatchAttempt), () => this.controlRead(id, principal, 'operator_chat:cancel'))
  }

  private async cancelNative(id: string, requestId: string, principal: ManagementPrincipal, markDispatchAttempt: () => void) {
    this.assertOpen()
    await this.assertAccess(id, principal, 'operator_chat:cancel')
    // Intent is a request-fenced database transition, not a native write. Do not
    // queue it behind a slow approval response. Native delivery stays serialized.
    if (!await this.repository.requestCancel(id, requestId)) return this.get(id, principal)
    const task = this.tasks.get(id)
    if (task?.requestId === requestId) task.controller.abort(new Error('Operator cancellation requested.'))
    const responseInFlight = this.responding.has(id)
    const delivery = this.control(id, async () => {
      const row = await this.repository.active(id)
      if (!row || row.active_request_id !== requestId || !row.cancel_requested) return
      if (['accepted', 'ready'].includes(row.active_phase ?? '') && !this.tasks.has(id)) {
        await this.complete(id, requestId, { outcome: 'canceled' }); return
      }
      try {
        const runtime = this.runtimes.get(id)
        if (runtime && row.active_native_turn_id) {
          markDispatchAttempt()
          await this.interrupt(id, row, runtime)
          await this.observe(id, requestId, runtime, AbortSignal.timeout(5_000))
        }
      } catch (error) {
        await this.repository.uncertain(id, requestId, error instanceof Error ? error.message : 'Cancellation delivery is uncertain.')
        this.events.publish(id, 'error', { requestId, turnState: 'uncertain' })
      } finally {
        // Once submission identity is durable, a silent event stream must not
        // pin the task forever after cancellation. Recovery still requires
        // exact provider evidence; detaching observation never finishes a turn.
        if (row.active_native_turn_id) {
          const task = this.tasks.get(id)
          if (task && task.requestId === requestId) task.controller.abort()
        }
      }
    })
    // Preserve the ordinary immediate-cancel response, but never wait behind
    // an approval delivery just to acknowledge durable cancellation intent.
    void delivery.catch(() => undefined)
    if (!responseInFlight) await delivery
    return this.get(id, principal)
  }

  async respond(id: string, input: RespondOperatorInteractionRequest, principal: ManagementPrincipal, source: 'http' | 'mcp' = 'http') {
    this.assertOpen()
    await this.assertAccess(id, principal, 'operator_chat:respond')
    let providerAcknowledgment: ChatResponseAcknowledgment | undefined
    const observed = await this.get(id, principal), pending = observed.pendingInteraction
    const option = pending?.responseOptions.find((choice) => choice.optionId === input.optionId)
    const acceptedControl = pending && option && observed.activeRequestId === input.requestId
      && pending.turn.nativeRequestId === input.nativeRequestId && observed.activitySnapshot
      ? AcceptedChatResponseControlSchema.parse({ schemaVersion: 1, kind: 'respond', conversationId: id,
        modelRequestId: input.requestId, scope: observed.activitySnapshot.scope,
        native: { harness: pending.session.harness, providerVersion: pending.session.providerVersion,
          sessionId: pending.session.nativeSessionId, turnId: pending.turn.nativeTurnId,
          requestId: input.nativeRequestId, requestType: pending.nativeRequestType },
        choice: { optionId: option.optionId, semantic: option.semantic } }) : undefined
    const key = input.commandId ?? `operator-respond:${commandInputHash([input.requestId, input.nativeRequestId]).slice(7)}`
    return this.receipts().execute(principal, source, id, key,
      { kind: 'respond', requestId: input.requestId, nativeRequestId: input.nativeRequestId, optionId: input.optionId },
      (markDispatchAttempt) => this.respondNative(id, input, principal, markDispatchAttempt, (proof) => { providerAcknowledgment = proof }),
      () => this.controlRead(id, principal, 'operator_chat:respond'), acceptedControl, () => providerAcknowledgment)
  }

  private async respondNative(id: string, input: RespondOperatorInteractionRequest, principal: ManagementPrincipal, markDispatchAttempt: () => void,
    recordEvidence: (proof: ChatResponseAcknowledgment) => void) {
    this.assertOpen()
    await this.assertAccess(id, principal, 'operator_chat:respond')
    await this.control(id, async () => {
      const row = await this.repository.active(id)
      const pending = row?.pending_interaction
      const option = pending?.responseOptions.find((item) => item.optionId === input.optionId)
      if (!row || row.active_request_id !== input.requestId || row.pending_interaction?.turn.nativeRequestId !== input.nativeRequestId || !option) {
        throw new DomainError('NATIVE_RESPONSE_UNKNOWN_REQUEST', 'This approval is no longer offered for this turn.', 409)
      }
      const configuration = await this.repository.configuration(row.operator_configuration_version_id)
      if (!configuration) throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'Pinned Operator configuration was not found.', 409)
      const owner = await this.authority.current(row.owner_principal_id!)
      requireAuthorization(owner, 'operator_chat:write')
      requireAuthorization(owner, 'operator_chat:respond')
      const runtime = await this.observationRuntime(id, row, configuration, this.lifetime.signal)
      if (!runtime.session || !await this.repository.claimResponse(id, input.requestId, input.nativeRequestId)) {
        throw new DomainError('NATIVE_RESPONSE_UNCERTAIN', 'A response was already submitted. Reconcile it before retrying.', 409)
      }
      let delivered = false
      this.responding.add(id)
      try {
        markDispatchAttempt()
        await runtime.manager.respond(runtime.session, input.nativeRequestId, option, this.lifetime.signal)
        delivered = true
        if (runtime.manager.reconcileResponse && pending) {
          const history = await runtime.manager.reconcileResponse(runtime.session, { nativeRequestId: input.nativeRequestId,
            nativeRequestType: pending.nativeRequestType, option }, this.lifetime.signal)
          const proofs = (history.responseDeliveries ?? []).filter((proof) => proof.nativeSessionId === runtime.session!.nativeSessionId
            && proof.nativeRequestId === input.nativeRequestId)
          if (proofs.length && proofs.every((proof) => proof.harness === runtime.session!.harness
            && proof.providerVersion === runtime.session!.providerVersion && proof.nativeRequestType === pending.nativeRequestType
            && proof.optionId === option.optionId && proof.semantic === option.semantic)) recordEvidence(proofs[0]!)
        }
        await this.repository.pending(id, input.requestId)
        await this.observe(id, input.requestId, runtime)
      } catch (error) {
        const code = error && typeof error === 'object' && 'result' in error
          ? (error as { result?: ExecutionResult }).result?.error?.code : undefined
        const definite = !delivered && ((error && typeof error === 'object' && 'certainty' in error && error.certainty === 'definite')
          || ['NATIVE_RESPONSE_DELIVERY_FAILED', 'NATIVE_RESPONSE_OPTION_INVALID', 'NATIVE_RESPONSE_UNKNOWN_REQUEST'].includes(code ?? ''))
        if (definite) await this.repository.responseFailed(id, input.requestId, input.nativeRequestId)
        else await this.repository.responseUncertain(id, input.requestId)
        throw error
      } finally { this.responding.delete(id) }
    })
    return this.get(id, principal)
  }

  reconcileActive(): Promise<void> {
    if (this.reconciliation) return this.reconciliation
    if (this.closing) return Promise.resolve()
    const promise = this.reconcile().finally(() => { this.reconciliation = undefined })
    this.reconciliation = promise
    return promise
  }
  /** This preflight does no native writes and must not wait for a response lane. */
  private async recoveryAuthority(row: ConversationRow): Promise<boolean> {
    if (!row.owner_principal_id || !row.active_request_id) return false
    try {
      requireAuthorization(await this.authority.current(row.owner_principal_id), 'operator_chat:write')
      return false
    } catch (error) {
      if (!(error instanceof DomainError) || !/AUTH_|ACCESS_DENIED/.test(error.code)) throw error
      if (!await this.repository.requestCancel(row.id, row.active_request_id)) return true
      const resident = this.runtimes.get(row.id)
      if (resident?.session) resident.manager.stopAutomaticResponses?.(resident.session)
      const task = this.tasks.get(row.id)
      if (task?.requestId === row.active_request_id) task.controller.abort(new Error('Operator owner authority ended.'))
      await this.authority.release(row.id)
      return true
    }
  }

  private async reconcile() {
    await reconcileKnownActivities({ kind: 'operator', activity: this.repository.activity,
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5_000)]),
      runtimeFor: (id) => {
        const runtime = this.runtimes.get(id)
        return runtime?.session && !runtime.disposal ? { manager: runtime.manager, session: runtime.session } : undefined
      }, publish: (id, settled) => this.events.publish(id, 'activity', settled) })
    for (const candidate of await this.repository.unfinished()) {
      if (this.closing) break
      let revoked = false
      try { revoked = await this.recoveryAuthority(candidate) } catch (error) {
        await this.repository.uncertain(candidate.id, candidate.active_request_id!,
          error instanceof Error ? error.message : 'Owner recovery authority is unavailable.')
        continue
      }
      // A response/cancel already owns this conversation's native write lane.
      // Do not wait behind it and starve recovery for unrelated conversations.
      if (this.controls.has(candidate.id)) continue
      await this.control(candidate.id, async () => {
        const row = await this.repository.active(candidate.id)
        if (!row?.active_request_id || row.active_request_id !== candidate.active_request_id) return
        const requestId = row.active_request_id
        try {
          if (!row.owner_principal_id) throw new Error('This legacy conversation needs an explicit owner assignment before recovery.')
          if (this.tasks.has(row.id)) return
          if (row.active_phase === 'accepted' || row.active_phase === 'ready') {
            await this.complete(row.id, requestId, row.cancel_requested ? { outcome: 'canceled' }
              : failure(new Error('The server stopped before native submission. Retry the same request.')), undefined, !row.cancel_requested)
            return
          }
          if (!row.native_session_id) {
            // Recover a returned identity whose original bind failed while this process stayed alive.
            const resident = this.runtimes.get(row.id)
            if (!resident?.session || row.active_phase !== 'creating') {
              throw new Error('Native session creation is uncertain; a replacement will not be created automatically.')
            }
            await this.repository.bind(row.id, requestId, resident.session.providerVersion, resident.session.nativeSessionId)
            await this.complete(row.id, requestId, row.cancel_requested ? { outcome: 'canceled' }
              : failure(new Error('Session binding recovered before prompt submission. Retry the same request.')), undefined, !row.cancel_requested)
            return
          }
          const configuration = await this.repository.configuration(row.operator_configuration_version_id)
          if (!configuration) throw new Error('Pinned Operator configuration was not found.')
          const cleanup = revoked || row.cancel_requested
          // Existing-turn observation is not new-work qualification. Native attach still verifies its protocol.
          const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5_000)])
          const runtime = cleanup ? await this.cleanupRuntime(row.id, row, configuration, signal)
            : await this.observationRuntime(row.id, row, configuration, signal)
          if (cleanup && row.active_native_turn_id) await this.interrupt(row.id, row, runtime)
          await this.observe(row.id, requestId, runtime, signal)
        } catch (error) {
          await this.repository.uncertain(row.id, requestId, error instanceof Error ? error.message : 'Native recovery is uncertain.')
          // Revoked authority must not leave a resident model running with native tools.
          if (error instanceof DomainError && /AUTH_|ACCESS_DENIED/.test(error.code)) {
            const runtime = this.runtimes.get(row.id)
            await this.repository.requestCancel(row.id, requestId)
            if (runtime) await this.interrupt(row.id, row, runtime).catch(() => undefined)
          }
          this.events.publish(row.id, 'error', { requestId, turnState: 'uncertain' })
        }
      })
    }
  }

  shutdown(): Promise<void> {
    this.closing = true
    this.lifetime.abort(new Error('Operator chat is shutting down.'))
    for (const controller of this.acceptanceControllers) controller.abort()
    for (const task of this.tasks.values()) task.controller.abort()
    this.shutdownTask ??= (async () => {
      // Dispose before waiting for stream consumers. Creation-time managers are already registered.
      const first = await Promise.allSettled([
        ...[...this.runtimes.entries()].map(([id, runtime]) => this.stopRuntime(id, runtime)),
        ...this.accepting, ...this.controls.values(),
        ...[...this.tasks.values()].map((task) => task.promise),
        ...(this.reconciliation ? [this.reconciliation] : []),
      ])
      const second = await Promise.allSettled([...this.runtimes.keys()].map((id) => this.release(id)))
      const errors = [...first, ...second].flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      await this.commandReceipts?.drain()
      if (errors.length) throw new AggregateError(errors, 'Operator chat shutdown was incomplete.')
    })()
    return this.shutdownTask
  }
}
