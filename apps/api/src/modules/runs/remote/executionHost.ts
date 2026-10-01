import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { HarnessExecutionRequestSchema, AgentConfigurationVersionSchema, ApprovalResponseOptionSchema, type NativeSessionReference, type HarnessExecutionRequest } from '@graphql/contracts'
import { canonicalGraphJson } from '@graphql/contracts/wave25'
import { DispatchIntentSchema, type AcceptedNodePlacement, type DispatchIntent } from '@graphql/contracts/node-placement'
import { RemoteOwnerControlSchema, type RemoteNativeIdentity, type RemoteTerminalEvidence, type RemoteOperationReceipt, type RemoteOwnerReconciliation, type RemoteApplicationAccess } from '@graphql/contracts/remote-execution'
import { RemoteExecutionRpcRequestSchema } from '@graphql/contracts/remote-execution-rpc'
import type { DeviceConnectionIdentity } from '@graphql/contracts/device-identity'
import type { NativeSessionManagerResolver } from '../../interactions/runtimePorts.js'
import type { NativeHarnessSessionManager, NativeHistory, ChildProcessEnvironment } from '../../harnesses/port.js'
import { assertRuntimeLeafPath, assertRuntimeLeafBinding, type RuntimeLeafAttestation } from './runtimeLeaf.js'
import { readPlacement } from '../../placement/binding.js'
import type { RemoteOperationJournal } from './operationJournal.js'

export interface RemoteExecutionHostPorts {
  journal: RemoteOperationJournal
  connection: DeviceConnectionIdentity
  incarnationId: string
  managers: NativeSessionManagerResolver
  authorize(intent: DispatchIntent, placement: AcceptedNodePlacement, action: 'start' | 'read' | 'control'): Promise<void>
  /** Host-local credentials and sandbox policy; never copied from main. */
  attestRuntimeLeaf(intent: DispatchIntent, placement: AcceptedNodePlacement, request: HarnessExecutionRequest): Promise<RuntimeLeafAttestation>
  preflight(request: HarnessExecutionRequest, applicationAccess?: RemoteApplicationAccess): Promise<ChildProcessEnvironment | void>
  nativeEvidence(intent: DispatchIntent, session: NativeSessionReference): Promise<RemoteNativeIdentity>
  /** W11/provider closure verification; terminal observation alone is insufficient. */
  verifyOwnerRenewal?(transition: RemoteOwnerReconciliation, receipt: RemoteOperationReceipt): Promise<void>
  verifyRecovery?(receipt: RemoteOperationReceipt, session: NativeSessionReference, evidenceDigest: string): Promise<void>
  settle(intent: DispatchIntent, history: NativeHistory, owner: { manager: NativeHarnessSessionManager; session: NativeSessionReference; request: HarnessExecutionRequest }): Promise<RemoteTerminalEvidence | null>
}
interface Resident { intent: DispatchIntent; placement: AcceptedNodePlacement; request: HarnessExecutionRequest; manager: NativeHarnessSessionManager; session: NativeSessionReference; controller: AbortController; turn?: Promise<void> }
/** Worker-only authenticated extension handler. No DB, scheduler, HTTP server or production composition. */
export class RemoteExecutionHost {
  private closing = false
  private shutdownTask: Promise<void> | undefined
  private readonly preparations = new Set<Promise<unknown>>()
  private readonly allocatedManagers = new Set<NativeHarnessSessionManager>()
  private readonly launchControllers = new Map<string, AbortController>()
  private readonly bindings = new Map<string, { intent: DispatchIntent; placement: AcceptedNodePlacement }>()
  private readonly residents = new Map<string, Resident>()
  constructor(private readonly ports: RemoteExecutionHostPorts) {}
  shutdown(): Promise<void> {
    return this.shutdownTask ??= this.shutdownOwned()
  }
  private async shutdownOwned(): Promise<void> {
    this.closing = true
    for (const controller of this.launchControllers.values()) controller.abort(new Error('Worker execution host is shutting down.'))
    await Promise.allSettled([...this.preparations])
    const active = [...this.residents.values()]
    for (const owned of active) owned.controller.abort(new Error('Worker execution host is shutting down.'))
    await Promise.allSettled(active.flatMap(owned => owned.turn ? [owned.turn] : []))
    const managers = new Set([...this.allocatedManagers, ...active.map(owned => owned.manager)])
    await Promise.all([...managers].map(async manager => {
      if (!manager.dispose) throw new Error('An actual worker native manager has no disposal contract.')
      await manager.dispose()
    }))
  }
  async handle(raw: unknown) {
    if (this.closing) throw new Error('Worker execution host is shutting down.')
    const frame = RemoteExecutionRpcRequestSchema.parse(raw)
    const placement = readPlacement(frame.placement)
    if (placement.hostRef.kind !== 'device' || placement.hostRef.deviceId !== this.ports.connection.deviceId
      || placement.mainId !== this.ports.connection.mainId || frame.intent.bindingHash !== placement.bindingHash
      || frame.intent.runId !== placement.runId || frame.intent.nodeId !== placement.nodeId) throw new Error('RPC ownership mismatch')
    const recorded = await this.ports.journal.status(frame.intent.operationId)
    if (frame.method === 'renew-owner') {
      if (recorded.status !== 'known' || !this.ports.verifyOwnerRenewal || !isDeepStrictEqual(frame.intent.owner, frame.transition.nextOwner)
        || !isDeepStrictEqual({ ...recorded.receipt.intent, owner: frame.transition.nextOwner }, frame.intent)) throw new Error('Original owner renewal binding mismatch')
      await this.ports.authorize(frame.intent, placement, 'control')
      await this.ports.verifyOwnerRenewal(frame.transition, recorded.receipt)
      await this.ports.journal.reconcileOwner(frame.transition)
      this.bindings.set(frame.intent.operationId, { intent: frame.intent, placement })
      const resident = this.residents.get(frame.intent.operationId)
      if (resident) resident.intent = frame.intent
      return this.ports.journal.status(frame.intent.operationId)
    }
    if (recorded.status === 'known' && !isDeepStrictEqual(recorded.receipt.intent, frame.intent)) throw new Error('RPC stale execution owner')
    await this.ports.authorize(frame.intent, placement, frame.method === 'control' ? 'control' : ['prepare', 'start-turn'].includes(frame.method) ? 'start' : 'read')
    if (frame.method === 'prepare') return this.prepare(frame)
    if (frame.method === 'capabilities' || frame.method === 'inspect-mcp') return this.inspect(frame, frame.method === 'capabilities' ? 'capabilities' : 'inspectMcp')
    if (frame.method === 'reconcile-response') { const resident = await this.resident(frame.intent.operationId, 'read'); if (!resident.manager.reconcileResponse) throw new Error('Exact native response recovery unavailable'); return { history: await resident.manager.reconcileResponse(resident.session, frame.response), status: await this.ports.journal.status(frame.intent.operationId) } }
    if (frame.method === 'control') return this.control(frame.command, frame)
    if (frame.method === 'start-turn') return this.startTurn(frame.intent.operationId, frame.prompt, frame.correlationId)
    if (frame.method === 'status') return this.status(frame.intent.operationId)
    return this.read(frame.intent.operationId, frame.method)
  }
  async inspect(raw: { intent: unknown; placement: unknown; configuration: unknown }, method: 'capabilities' | 'inspectMcp') {
    if (this.closing) throw new Error('Worker execution host is shutting down.')
    const intent = DispatchIntentSchema.parse(raw.intent), placement = readPlacement(raw.placement), configuration = AgentConfigurationVersionSchema.parse(raw.configuration)
    if (placement.hostRef.kind !== 'device' || placement.hostRef.deviceId !== this.ports.connection.deviceId || placement.mainId !== this.ports.connection.mainId
      || intent.bindingHash !== placement.bindingHash || placement.payload.kind !== 'agent' || placement.payload.agentId !== configuration.agentId
      || placement.payload.agentConfigurationVersionId !== configuration.id) throw new Error('Remote discovery binding mismatch')
    await this.ports.authorize(intent, placement, 'read')
    const resolved = this.ports.managers.resolve({ executionId: intent.executionId, agentId: configuration.agentId,
      harness: configuration.harness.harness, configuration, workingDirectory: placement.destination.canonicalCwd })
    if (this.closing) throw new Error('Worker execution host is shutting down.')
    this.allocatedManagers.add(resolved.manager)
    return resolved.manager[method]()
  }
  prepare(raw: { intent: unknown; placement: unknown; request: unknown; applicationAccess?: RemoteApplicationAccess | undefined }) {
    if (this.closing) return Promise.reject(new Error('Worker execution host is shutting down.'))
    const task = this.prepareOwned(raw)
    this.preparations.add(task)
    void task.then(() => this.preparations.delete(task), () => this.preparations.delete(task))
    return task
  }
  private async prepareOwned(raw: { intent: unknown; placement: unknown; request: unknown; applicationAccess?: RemoteApplicationAccess | undefined }) {
    const intent = DispatchIntentSchema.parse(raw.intent), placement = readPlacement(raw.placement), request = HarnessExecutionRequestSchema.parse(raw.request)
    if (placement.hostRef.kind !== 'device' || placement.hostRef.deviceId !== this.ports.connection.deviceId
      || placement.mainId !== this.ports.connection.mainId || placement.bindingHash !== intent.bindingHash
      || placement.runId !== intent.runId || placement.nodeId !== intent.nodeId || placement.payload.kind !== 'agent'
      || placement.payload.agentConfigurationVersionId !== request.configuration.id || placement.payload.agentId !== request.configuration.agentId
      || request.executionId !== intent.executionId || request.runId !== intent.runId || request.workflowNodeId !== intent.nodeId
      || request.workingDirectory !== placement.destination.canonicalCwd
      || intent.inputDigest !== `sha256:${createHash('sha256').update(canonicalGraphJson(request.input)).digest('hex')}`) throw new Error('Remote launch binding mismatch')
    await this.ports.authorize(intent, placement, 'start')
    assertRuntimeLeafPath(request.runtimeDirectory, placement)
    assertRuntimeLeafBinding(await this.ports.attestRuntimeLeaf(intent, placement, request), request.runtimeDirectory, intent, placement)
    this.bindings.set(intent.operationId, { intent, placement })
    await this.ports.journal.accept(intent, this.ports.connection, this.ports.incarnationId)
    const existing = this.residents.get(intent.operationId)
    if (existing) return { session: existing.session, status: await this.ports.journal.status(intent.operationId) }
    const reservation = await this.ports.journal.reserveEntry(intent.operationId)
    if (!reservation.reserved) throw new Error('Original native execution requires reconciliation')
    if (this.closing) throw new Error('Worker execution host is shutting down.')
    const controller = new AbortController()
    this.launchControllers.set(intent.operationId, controller)
    try {
      const access = raw.applicationAccess
      if (access && (access.executionId !== intent.executionId || access.agentId !== request.configuration.agentId || access.operationId !== intent.operationId
        || access.attemptId !== intent.attemptId || access.bindingHash !== intent.bindingHash)) throw new Error('Wrong main worker MCP lease binding')
      const environment = await this.ports.preflight(request, access)
      if ((environment?.variables.GRAPHQL_MCP_TOKEN ?? undefined) !== access?.token) throw new Error('Worker must reuse the exact main-owned application lease')
      if (environment && environment.agentId !== request.configuration.agentId) throw new Error('Wrong worker-local credential owner')
      await this.ports.authorize(intent, placement, 'start')
      const before = await this.ports.journal.status(intent.operationId)
      if (before.status !== 'known' || before.receipt.stopFence) throw new Error('Remote launch stopped before native submission')
      const resolved = this.ports.managers.resolve({ executionId: intent.executionId, agentId: request.configuration.agentId,
        harness: request.configuration.harness.harness, configuration: request.configuration, workingDirectory: request.workingDirectory })
      controller.signal.throwIfAborted()
      this.allocatedManagers.add(resolved.manager)
      resolved.beginStart?.()
      const session = await resolved.manager.createSession({ request, correlationId: `execution:${intent.executionId}`, ...(environment ? { environment } : {}) }, controller.signal)
      resolved.markResident?.()
      const native = await this.ports.nativeEvidence(intent, session)
      if (native.sessionId !== session.nativeSessionId) throw new Error('Native session attestation mismatch')
      const receipt = await this.ports.journal.acknowledgeStart(intent.operationId, native)
      const resident = { intent, placement, request, manager: resolved.manager, session, controller }
      this.residents.set(intent.operationId, resident)
      if (receipt.stopFence) await resident.manager.cancel(session)
      return { session, status: await this.ports.journal.status(intent.operationId) }
    } catch (error) { await this.ports.journal.uncertain(intent.operationId, 'Native session preparation acknowledgment unavailable'); throw error }
    finally { this.launchControllers.delete(intent.operationId) }
  }
  async recover(raw: { intent: DispatchIntent; placement: AcceptedNodePlacement; request: HarnessExecutionRequest; session: NativeSessionReference; evidenceDigest: string }) {
    const status = await this.ports.journal.status(raw.intent.operationId)
    if (status.status !== 'known' || !status.receipt.native || !this.ports.verifyRecovery
      || !isDeepStrictEqual(status.receipt.intent, raw.intent) || status.receipt.native.sessionId !== raw.session.nativeSessionId) throw new Error('Original native recovery evidence required')
    const placement = readPlacement(raw.placement), request = HarnessExecutionRequestSchema.parse(raw.request)
    if (placement.bindingHash !== raw.intent.bindingHash || placement.payload.kind !== 'agent' || placement.payload.agentConfigurationVersionId !== request.configuration.id
      || request.executionId !== raw.intent.executionId || request.workingDirectory !== placement.destination.canonicalCwd) throw new Error('Recovery binding mismatch')
    await this.ports.authorize(raw.intent, placement, 'read')
    assertRuntimeLeafPath(request.runtimeDirectory, placement)
    assertRuntimeLeafBinding(await this.ports.attestRuntimeLeaf(raw.intent, placement, request), request.runtimeDirectory, raw.intent, placement)
    await this.ports.verifyRecovery(status.receipt, raw.session, raw.evidenceDigest)
    const resolved = this.ports.managers.resolve({ executionId: raw.intent.executionId, agentId: request.configuration.agentId,
      harness: request.configuration.harness.harness, configuration: request.configuration, workingDirectory: request.workingDirectory })
    if (resolved.processState === 'needs_start') resolved.beginStart?.()
    const session = await resolved.manager.attachSession(raw.session, { request, correlationId: `execution:${raw.intent.executionId}`, instructionsDelivered: true })
    if (session.nativeSessionId !== raw.session.nativeSessionId) throw new Error('Recovery replaced original session')
    resolved.markResident?.()
    this.bindings.set(raw.intent.operationId, { intent: raw.intent, placement })
    this.residents.set(raw.intent.operationId, { intent: raw.intent, placement, request, manager: resolved.manager, session, controller: new AbortController() })
    await this.ports.journal.confirmRecovered(raw.intent.operationId, status.receipt.native)
    if (status.receipt.stopFence) await resolved.manager.cancel(session, undefined, status.receipt.native.turnId)
    return { session, status: await this.ports.journal.status(raw.intent.operationId) }
  }
  /** Invoke on credential policy refresh/revocation; offline requested cancellation stays non-terminal. */
  async refreshAuthority() {
    for (const resident of this.residents.values()) {
      try { await this.ports.authorize(resident.intent, resident.placement, 'start') }
      catch {
        await this.ports.journal.revokeFence(resident.intent.operationId)
        resident.controller.abort(); resident.manager.stopAutomaticResponses?.(resident.session)
        try { await resident.manager.cancel(resident.session); await this.settle(resident, `execution:${resident.intent.executionId}`) }
        catch { await this.ports.journal.uncertain(resident.intent.operationId, 'Revoked authority; original native cancellation unconfirmed') }
      }
    }
  }
  private async resident(operationId: string, action: 'start' | 'read' | 'control') {
    const resident = this.residents.get(operationId)
    if (!resident) throw new Error('Original native owner requires reconciliation')
    await this.ports.authorize(resident.intent, resident.placement, action)
    return resident
  }
  async startTurn(operationId: string, prompt: string, correlationId: string) {
    const resident = await this.resident(operationId, 'start')
    if (correlationId !== `execution:${resident.intent.executionId}` || !prompt || prompt.length > 1_000_000) throw new Error('Native turn correlation mismatch')
    const reserved = await this.ports.journal.reserveTurn(operationId, { correlationId, promptDigest: createHash('sha256').update(prompt).digest('hex') })
    if (!reserved.reserved) return this.ports.journal.status(operationId)
    resident.turn = (async () => {
      try {
        await this.ports.authorize(resident.intent, resident.placement, 'start')
        const status = await this.ports.journal.status(operationId)
        if (status.status !== 'known' || status.receipt.stopFence) return
        for await (const event of resident.manager.startTurn(resident.session, { prompt, clientCorrelationId: correlationId,
          onSubmitted: async turnId => { await this.ports.journal.acknowledgeTurn(operationId, turnId); const current = await this.ports.journal.status(operationId); if (current.status === 'known' && current.receipt.stopFence) await resident.manager.cancel(resident.session, undefined, turnId); else await this.ports.journal.markRunning(operationId) } }, resident.controller.signal)) { void event }
        await this.settle(resident, correlationId)
      } catch { try { await this.ports.journal.uncertain(operationId, 'Native turn acknowledgment or closure unavailable') } catch { /* A faulted journal already denies entry and requires recovery. */ } }
    })()
    return this.ports.journal.status(operationId)
  }
  private async settle(resident: Resident, correlationId: string) {
    const evidence = await this.ports.settle(resident.intent, await resident.manager.reconcile(resident.session, correlationId), resident)
    if (evidence) await this.ports.journal.terminal(resident.intent.operationId, evidence)
  }
  async read(operationId: string, method: 'history' | 'pending' | 'capabilities' | 'inspectMcp') {
    const resident = await this.resident(operationId, 'read')
    if (method === 'history') return { history: await resident.manager.reconcile(resident.session, `execution:${resident.intent.executionId}`), status: await this.ports.journal.status(operationId) }
    if (method === 'pending') return resident.manager.pending(resident.session)
    return resident.manager[method]()
  }
  async control(raw: unknown, binding?: { intent: DispatchIntent; placement: AcceptedNodePlacement }) {
    const command = RemoteOwnerControlSchema.parse(raw)
    if (binding) {
      const intent = DispatchIntentSchema.parse(binding.intent), placement = readPlacement(binding.placement)
      if (intent.operationId !== command.operationId || intent.bindingHash !== placement.bindingHash
        || placement.hostRef.kind !== 'device' || placement.hostRef.deviceId !== this.ports.connection.deviceId
        || placement.mainId !== this.ports.connection.mainId) throw new Error('Control placement mismatch')
      await this.ports.authorize(intent, placement, 'control')
      this.bindings.set(command.operationId, { intent, placement })
      await this.ports.journal.accept(intent, this.ports.connection, this.ports.incarnationId)
    }
    const owned = this.bindings.get(command.operationId)
    if (!owned) throw new Error('Original control owner requires reconciliation')
    await this.ports.authorize(owned.intent, owned.placement, 'control')
    const resident = this.residents.get(command.operationId)
    if (!resident) {
      if (command.action.kind !== 'stop') throw new Error('Original native question unavailable')
      await this.ports.journal.control(command)
      this.launchControllers.get(command.operationId)?.abort()
      return this.ports.journal.status(command.operationId)
    }
    const previous = await this.ports.journal.status(command.operationId)
    if (previous.status === 'known' && previous.receipt.controls.some(value => value.commandId === command.commandId)) { await this.ports.journal.control(command); return this.ports.journal.status(command.operationId) }
    if (command.action.kind === 'respond') {
      const pending = await resident.manager.pending(resident.session)
      if (!pending || pending.turn.nativeRequestId !== command.action.nativeInteractionId || pending.session.nativeSessionId !== command.native?.sessionId || pending.turn.nativeTurnId !== command.native?.turnId) throw new Error('Original native question no longer pending')
      const selectedOption = ApprovalResponseOptionSchema.parse(command.action.response)
      if (!pending.responseOptions.some(option => isDeepStrictEqual(option, selectedOption))) throw new Error('Response option is not offered by the original native question')
      await this.ports.journal.interaction(command.operationId, { interactionId: command.action.interactionId, interactionRevision: command.action.interactionRevision, nativeInteractionId: command.action.nativeInteractionId, native: command.native! })
    }
    const recorded = await this.ports.journal.control(command)
    if (!recorded.dispatch) return this.ports.journal.status(command.operationId)
    await this.ports.authorize(resident.intent, resident.placement, 'control')
    try {
      if (command.action.kind === 'stop') { resident.controller.abort(); resident.manager.stopAutomaticResponses?.(resident.session); await resident.manager.cancel(resident.session, undefined, recorded.receipt.native?.turnId) }
      else await resident.manager.respond(resident.session, command.action.nativeInteractionId, ApprovalResponseOptionSchema.parse(command.action.response))
      await this.settle(resident, `execution:${resident.intent.executionId}`)
    } catch { await this.ports.journal.uncertain(command.operationId, 'Native control acknowledgment unavailable') }
    return this.ports.journal.status(command.operationId)
  }
  async drain() { await Promise.all([...this.residents.values()].flatMap(resident => resident.turn ? [resident.turn] : [])) }
  status(operationId: string) { return this.ports.journal.status(operationId) }
}
