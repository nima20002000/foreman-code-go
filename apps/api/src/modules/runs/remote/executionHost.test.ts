import { pendingSessionControls } from '../../harnesses/sessionControlDefaults.js'
import { SessionPreferencesSchema } from '@foreman-code/contracts'
import { createRemoteExecutionHandler } from './executionRouter.js'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import type { RemoteJobDispatchIntent } from '@foreman-code/contracts/remote-job-execution'
import { RemoteOwnerControlSchema } from '@foreman-code/contracts/remote-execution'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, CODEX_APPROVAL_OPTIONS_FIXTURE, withInteractionResponse,
  type ApprovalResponseOption, type AgentConfigurationVersion } from '@foreman-code/contracts'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { freezePlacement, deriveDispatch } from '../../placement/binding.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../interactions/runtimePorts.js'
import type { NativeHarnessSessionManager } from '../../harnesses/port.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteNativeSessionManager } from './nativeManagerProxy.js'
import { RemoteExecutionHost, type RemoteExecutionHostPorts } from './executionHost.js'
const roots: string[] = []
const journals: RemoteOperationJournal[] = []
const hosts: RemoteExecutionHost[] = []
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.drain())); await Promise.all(journals.splice(0).map(journal => journal.close())); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup(expectedToken?: string) {
  const root = await mkdtemp(join(tmpdir(), 'w08-host-')); roots.push(root)
  const journalPath = join(root, 'journal')
  const journal = await RemoteOperationJournal.open(journalPath, { initializeNewInstallation: true })
  journals.push(journal)
  const mainId = randomUUID(), deviceId = randomUUID(), installationId = randomUUID(), digest = 'a'.repeat(64)
  const configuration: AgentConfigurationVersion = { id: 'configuration', agentId: 'agent', workspaceId: 'workspace', version: 1, prompt: { system: 'test' }, assignedSkills: [], harness: DEFAULT_HARNESS_DEFAULTS.codex, contentHash: 'sha256:test', createdAt: '2026-10-01T00:00:00.000Z' }
  const placement = freezePlacement({ schemaVersion: 1, mainId, runId: 'run', nodeId: 'node', hostRef: { kind: 'device', mainId, deviceId }, registration: { workerInstallationId: installationId, keyRevision: 1, authorizationRevision: 1 }, mainInstallationId: 'main-installation',
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime', directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: digest }, source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness', installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  const input = { value: 'accepted' }, inputDigest = `sha256:${createHash('sha256').update(canonicalGraphJson(input)).digest('hex')}`
  const intent = deriveDispatch(placement, { executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', inputDigest, owner: { grantId: 'grant', epoch: '1' } })
  const request = { executionId: 'execution', runId: 'run', workspaceId: 'workspace', workflowNodeId: 'node', workingDirectory: '/project', runtimeDirectory: '/runtime/execution', configuration, input }
  const state = { starts: 0, turns: 0, cancels: 0, responds: 0, allowed: true }
  const session = { harness: 'codex' as const, providerVersion: 'test', nativeSessionId: 'native-session' }
  const manager: NativeHarnessSessionManager = { harness: 'codex', capabilities: async () => { throw new Error('unused') }, inspectMcp: async () => { throw new Error('unused') }, createSession: async () => { state.starts++; return session }, attachSession: async () => session,
    startTurn: async function* (_session, turn) { state.turns++; await turn.onSubmitted?.('native-turn'); yield { sequence: 1, type: 'event', occurredAt: '2026-10-01T00:00:00.000Z', payload: {} } }, pending: async () => undefined, respond: async () => { state.responds++ }, cancel: async () => { state.cancels++; return false }, history: async () => ({ events: [], pendingInteractions: [] }), reconcile: async () => ({ events: [], pendingInteractions: [] }), close: async () => {} }
  const ports: RemoteExecutionHostPorts = { journal, connection: { mainId, deviceId, workerInstallationId: installationId, bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }, incarnationId: randomUUID(), managers: new ExecutionScopedNativeSessionManagerResolver(() => manager), authorize: async () => { if (!state.allowed) throw new Error('revoked') }, attestRuntimeLeaf: async (intent, placement, request) => { if (!placement.source.materializationId || !placement.source.materializationDigest) throw new Error('Original fixture has no materialized source'); return ({ executionId: intent.executionId, attemptId: intent.attemptId, operationId: intent.operationId, bindingHash: intent.bindingHash, canonicalRuntimeDirectory: request.runtimeDirectory, directoryIdentityHash: digest, materializationId: placement.source.materializationId, materializationDigest: placement.source.materializationDigest }) }, preflight: async (_request,access) => { if (expectedToken) { expect(access?.token).toBe(expectedToken); return {agentId:'agent',variables:{GRAPHQL_MCP_TOKEN:expectedToken}} } }, nativeEvidence: async () => ({ sessionId: 'native-session', processIdentityDigest: digest }), settle: async () => null }
  const host = new RemoteExecutionHost(ports)
  hosts.push(host)
  return { host, manager, session, journal, journalPath, intent, placement, request, state, ports }
}
describe('actual worker native-port adapter', () => {
  it.each(['questions', 'form'] as const)('delivers validated %s values once and recovers the complete response', async kind => {
    const f = await setup()
    await f.host.prepare(f)
    await f.host.startTurn('operation', 'prompt', 'execution:execution')
    await f.host.drain()
    const offered: ApprovalResponseOption = { ...CODEX_APPROVAL_OPTIONS_FIXTURE[0]!, input: kind === 'form'
      ? { kind, schema: { type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 1 } } } }
      : { kind, questions: [{ id: 'answer', header: 'Answer', question: 'Enter a value', isSecret: false,
        isOther: true, options: null }] } }
    const response = kind === 'form' ? { count: 2 } : { answer: { answers: ['Entered'] } }
    const selected = withInteractionResponse(offered, response)
    f.manager.pending = async () => ({ session: f.session,
      turn: { nativeTurnId: 'native-turn', nativeRequestId: 'question' },
      nativeRequestType: 'input', request: {}, responseOptions: [offered] })
    const respond = vi.fn(async () => {})
    f.manager.respond = respond
    const status = await f.journal.status('operation')
    if (status.status !== 'known') throw new Error('Missing receipt')
    const command = RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1, commandId: 'response', operationId: f.intent.operationId,
      attemptId: f.intent.attemptId, executionId: f.intent.executionId, bindingHash: f.intent.bindingHash,
      owner: f.intent.owner, native: status.receipt.native, action: { kind: 'respond', interactionId: 'interaction',
        interactionRevision: '1', nativeInteractionId: 'question', response: selected } })
    await expect(f.host.control({ ...command, action: { ...command.action,
      response: { ...selected, response: {} } } })).rejects.toThrow()
    expect(respond).not.toHaveBeenCalled()
    await f.host.control(command)
    await f.host.control(command)
    expect(respond).toHaveBeenCalledTimes(1)
    expect(respond).toHaveBeenCalledWith(f.session, 'question', selected)
    await f.journal.close()
    const reopened = await RemoteOperationJournal.open(f.journalPath)
    journals.push(reopened)
    expect((await reopened.control(command)).dispatch).toBe(false)
    expect((await reopened.status('operation'))).toMatchObject({ receipt: { controls: [command] } })
  })

  it('forwards controls and usage with journaled compact retries without settling the workflow', async () => {
    const f = await setup()
    let compactions = 0
    Object.assign(f.manager, {
      sessionControlCapabilities: async () => pendingSessionControls(f.request.configuration.harness),
      contextSnapshot: () => ({ nativeSessionId: f.session.nativeSessionId, model: f.request.configuration.harness.model,
        generation: 'worker', sequence: 1, observedAt: new Date().toISOString(), source: 'codex', accuracy: 'native',
        usedTokens: 120, capacityTokens: 1000, lifetimeTokens: 300, cost: null, stale: false }),
      appliedSessionPreferences: () => SessionPreferencesSchema.parse({}),
      compactSession: async (_session: unknown, input: { requestId: string }) => {
        compactions++
        return { requestId: input.requestId, nativeSessionId: f.session.nativeSessionId, nativeOperationId: 'native-boundary',
          status: 'completed', message: 'Context compacted.', beforeTokens: 120, observedAt: new Date().toISOString() }
      },
    })
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement, harness: 'codex',
      configuration: f.request.configuration, transport: { request: async (_method, frame) => f.host.handle(frame) },
      observeReceipt: async () => {}, controlFor: async () => { throw new Error('Stop/response was not requested') } })
    const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution' })
    await proxy.sessionControlCapabilities(session)
    expect(proxy.contextSnapshot(session)?.usedTokens).toBe(120)
    const input = { requestId: 'compact-worker-request', clientCorrelationId: 'compact-worker-correlation', onProgress: async () => {} }
    expect((await proxy.compactSession(session, input)).status).toBe('completed')
    expect((await proxy.compactSession(session, input)).status).toBe('completed')
    expect(compactions).toBe(1)
    const status = await f.journal.status(f.intent.operationId)
    expect(status.status === 'known' && status.receipt.phase).not.toBe('confirmed_terminal')
    f.state.allowed = false
    await expect(proxy.sessionControlCapabilities(session)).rejects.toThrow('revoked')
  })

  it('reuses a streamed history and acknowledges a refreshed turn before its next event', async () => {
    const f = await setup()
    const events = [1, 2].map(sequence => ({ sequence, type: 'native.notification',
      occurredAt: '2026-10-01T00:00:00.000Z', payload: { sequence } }))
    const submitted: string[] = []
    const observedEvents: Array<{ sequence: number; turnId: string | undefined; submitted: string[] }> = []
    let historyReads = 0
    const proxy = new RemoteNativeSessionManager({
      intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: async (method, frame) => {
        if (method === 'start-turn') {
          await f.journal.reserveTurn(f.intent.operationId, {
            correlationId: 'execution:execution', promptDigest: createHash('sha256').update('prompt').digest('hex'),
          })
          return f.journal.status(f.intent.operationId)
        }
        if (method !== 'history') return f.host.handle(frame)
        historyReads++
        const status = await f.journal.status(f.intent.operationId)
        if (status.status !== 'known') throw new Error('Original receipt is unavailable')
        const turnId = status.receipt.native?.turnId
        return { status, history: { events, pendingInteractions: [], correlationId: 'execution:execution',
          ...(turnId ? { nativeTurnId: turnId } : {}) } }
      } },
      observeReceipt: async () => {},
      observeOriginalSource: async (receipt, source) => {
        if (source.type === 'event') {
          observedEvents.push({ sequence: source.event.sequence, turnId: receipt.native?.turnId,
            submitted: [...submitted] })
        }
      },
      controlFor: async () => { throw new Error('No control is requested') },
    })
    const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution' })
    const stream = proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: 'execution:execution',
      onSubmitted: async id => { submitted.push(id) } })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      expect((await stream.next()).value).toEqual(events[0])
      expect((await proxy.history(session)).events).toEqual(events)
      expect((await proxy.history(session)).events).toEqual(events)
      expect(historyReads).toBe(1)
      await f.journal.acknowledgeTurn(f.intent.operationId, 'native-turn')
      clock.mockReturnValue(now + 30_001)
      expect((await proxy.history(session)).nativeTurnId).toBe('native-turn')
      expect(historyReads).toBe(2)
      expect((await stream.next()).value).toEqual(events[1])
      expect(observedEvents).toEqual([
        { sequence: 1, turnId: undefined, submitted: [] },
        { sequence: 2, turnId: 'native-turn', submitted: ['native-turn'] },
      ])
      await stream.return(undefined)
      await proxy.history(session)
      expect(historyReads).toBe(3)
      expect(f.state.starts).toBe(1)
    } finally {
      await stream.return(undefined)
      clock.mockRestore()
    }
  })

  it('retains the real terminal provider history when an authoritative closure callback disposes the manager', async () => {
    const { host, manager, ports, intent, placement, request } = await setup()
    const history = { events: [], pendingInteractions: [], correlationId: 'execution:execution', terminalResult: { outcome: 'succeeded' as const, output: { answer: 'original provider result' } } }
    const reconcile = vi.fn(async () => history)
    manager.reconcile = reconcile
    ports.settle = vi.fn(async () => {
      manager.reconcile = async () => { throw new Error('Original native runtime already closed') }
      manager.pending = async () => { throw new Error('Closed native runtime must not be re-entered') }
      return { kind: 'completed' as const, closureEvidenceDigest: 'a'.repeat(64), result: history.terminalResult }
    })
    await host.prepare({ intent, placement, request })
    await host.startTurn('operation', 'accepted prompt', 'execution:execution')
    await host.drain()
    expect(await host.read('operation', 'history')).toMatchObject({ history, status: { status: 'known', receipt: { phase: 'confirmed_terminal' } } })
    expect(await host.read('operation', 'pending')).toBeUndefined()
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(ports.settle).toHaveBeenCalledTimes(1)
  })

  it('keeps a workflow-only host available without substituting it for the missing OCI Job runtime', async () => {
    const { host } = await setup()
    const execution = jobExecution()
    const intent: RemoteJobDispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId: execution.acceptedSpec.target.mainId,
      subject: { kind: 'manual-job', workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: execution.acceptedSpec.definitionId },
      executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId,
      bindingHash: execution.acceptedSpec.bindingHash, inputDigest: `sha256:${execution.acceptedSpec.specDigest}`, owner: execution.owner }
    const called = vi.spyOn(host, 'handle')
    const handler = createRemoteExecutionHandler(host)
    expect(() => handler({ method: 'job-status', intent })).toThrow('no installed Job runtime')
    expect(called).not.toHaveBeenCalled()
  })

  it('joins a pending native allocation and disposes its actual manager before shutdown returns', async () => {
    const { host, manager, session, intent, placement, request, state } = await setup()
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), released = new Promise<void>(resolve => { release = resolve })
    manager.createSession = async (_input, signal) => { enter(); await released; signal?.throwIfAborted(); state.starts++; return session }
    manager.dispose = vi.fn(async () => {})
    const pending = host.prepare({ intent, placement, request })
    await entered
    let closed = false
    const closing = host.shutdown().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    release()
    await expect(pending).rejects.toThrow()
    await closing
    await host.shutdown()
    expect(manager.dispose).toHaveBeenCalledTimes(1)
    expect(state.starts).toBe(0)
    await expect(host.prepare({ intent, placement, request })).rejects.toThrow('shutting down')
  })

  it.each(['physical-readout', 'physical-ack'] as const)('refuses generic %s without claiming installed physical evidence', async method => {
    const f = await setup()
    await expect(f.host.handle({ method, intent: f.intent, placement: f.placement, receiptSequence: 1, sourceDigest: 'a'.repeat(64) })).rejects.toThrow('generic execution host')
    expect(f.state.starts).toBe(0)
  })
  it('retains authenticated receipt before observing the actual source and returning its session', async () => {
    const f = await setup(), order: string[] = []
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: (_method, frame) => f.host.handle(frame) },
      observeReceipt: async receipt => { order.push(`receipt:${receipt.phase}`) },
      observeOriginalSource: async (_receipt, source) => { expect(f.state.starts).toBe(1); order.push(`source:${source.type}`) },
      controlFor: async () => { throw new Error('unused') } })
    const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution' }); order.push('returned')
    expect(order).toEqual(['receipt:start_acknowledged', 'source:session_created', 'returned'])
    order.length = 0
    await proxy.observeBoundary(session)
    await proxy.observeBoundary(session)
    expect(order).toEqual(['receipt:start_acknowledged', 'source:boundary',
      'receipt:start_acknowledged', 'source:boundary'])
    expect(f.state.starts).toBe(1)
    expect(f.state.turns).toBe(0)
  })
  it('retains uncertainty when physical source verification fails after the worker created its session', async () => {
    const f = await setup()
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: (_method, frame) => f.host.handle(frame) }, observeReceipt: async () => {},
      observeOriginalSource: async () => { throw new Error('original physical source unavailable') },
      controlFor: async () => { throw new Error('unused') } })
    await expect(proxy.createSession({ request: f.request, correlationId: 'execution:execution' })).rejects.toThrow('original physical source unavailable')
    await expect(proxy.dispose()).rejects.toThrow('disposal is unconfirmed')
    expect(f.state.starts).toBe(1)
  })
  it('uses the native manager once across duplicated delivery and turn requests', async () => { const { host, intent, placement, request, state } = await setup(); await host.prepare({ intent, placement, request }); await host.prepare({ intent, placement, request }); expect(state.starts).toBe(1); await host.startTurn('operation', 'accepted prompt', 'execution:execution'); await host.startTurn('operation', 'accepted prompt', 'execution:execution'); expect(state.turns).toBe(1); await host.drain() })
  it('routes the main native port through the shared bound RPC and observes requested cancellation', async () => {
    const { host, intent, placement, request, state } = await setup()
    const observed: string[] = []
    const proxy = new RemoteNativeSessionManager({ intent, placement, harness: 'codex', configuration: request.configuration,
      transport: { request: (_method, frame) => host.handle(frame) }, observeReceipt: async receipt => { observed.push(receipt.phase) },
      controlFor: async ({ native }) => ({ schemaVersion: 1, protocolVersion: 1, commandId: 'proxy-stop', operationId: intent.operationId, attemptId: intent.attemptId, executionId: intent.executionId, bindingHash: intent.bindingHash, owner: intent.owner, native, action: { kind: 'stop' } }) })
    const session = await proxy.createSession({ request, correlationId: 'execution:execution' })
    expect(await proxy.cancel(session)).toBe(false)
    expect(state.starts).toBe(1); expect(state.cancels).toBe(1); expect(observed).toEqual(['start_acknowledged', 'stop_requested', 'stop_requested'])
  })
  it('reuses only the exact ephemeral main worker MCP lease without journaling it', async () => {
    const token = 'test-exact-main-lease', { host, intent, placement, request, journal, state } = await setup(token)
    const proxy = new RemoteNativeSessionManager({ intent, placement, harness: 'codex', configuration: request.configuration,
      transport: { request: (_method, frame) => host.handle(frame) }, observeReceipt: async () => {},
      controlFor: async ({ native }) => ({ schemaVersion:1,protocolVersion:1,commandId:'stop',operationId:intent.operationId,attemptId:intent.attemptId,executionId:intent.executionId,bindingHash:intent.bindingHash,owner:intent.owner,native,action:{kind:'stop'} }) })
    await expect(proxy.createSession({request,correlationId:'execution:execution',environment:{agentId:'agent',variables:{GRAPHQL_MCP_TOKEN:token,OPENAI_API_KEY:'must-stay-host-local'}}})).rejects.toThrow('Only the exact scoped')
    expect(state.starts).toBe(0)
    await proxy.createSession({request,correlationId:'execution:execution',environment:{agentId:'agent',variables:{GRAPHQL_MCP_TOKEN:token}}})
    expect(state.starts).toBe(1);expect(JSON.stringify(await journal.status(intent.operationId))).not.toContain(token)
  })
  it('Stop delivered before Start persists a negative fence before any native manager launch', async () => { const { host, intent, placement, request, state } = await setup(); await host.control({ schemaVersion: 1, protocolVersion: 1, commandId: 'stop', operationId: intent.operationId, attemptId: intent.attemptId, executionId: intent.executionId, bindingHash: intent.bindingHash, owner: intent.owner, action: { kind: 'stop' } }, { intent, placement }); await expect(host.prepare({ intent, placement, request })).rejects.toThrow('reconciliation'); expect(state.starts).toBe(0) })
  it('Stop during delayed native creation aborts the owned launch signal and retains uncertainty', async () => {
    const { host, manager, session, journal, intent, placement, request, state } = await setup()
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), released = new Promise<void>(resolve => { release = resolve })
    manager.createSession = async (_input, signal) => { enter(); await released; signal?.throwIfAborted(); state.starts++; return session }
    const pending = host.prepare({ intent, placement, request }); await entered
    await host.control({ schemaVersion: 1, protocolVersion: 1, commandId: 'stop-during-start', operationId: intent.operationId, attemptId: intent.attemptId, executionId: intent.executionId, bindingHash: intent.bindingHash, owner: intent.owner, action: { kind: 'stop' } })
    release(); await expect(pending).rejects.toThrow()
    expect(state.starts).toBe(0)
    const status = await journal.status('operation'); expect(status.status === 'known' && status.receipt.phase).toBe('uncertain'); expect(status.status === 'known' && status.receipt.stopFence).toBe(true)
  })
  it('validates native offered responses before reserving one exact idempotent answer', async () => {
    const { host, manager, session, journal, intent, placement, request, state } = await setup()
    await host.prepare({ intent, placement, request }); await host.startTurn('operation', 'prompt', 'execution:execution'); await host.drain()
    const option = CODEX_APPROVAL_OPTIONS_FIXTURE[0]!
    manager.pending = async () => ({ session, turn: { nativeTurnId: 'native-turn', nativeRequestId: 'native-question' }, nativeRequestType: 'question', request: {}, responseOptions: [option] })
    const status = await journal.status('operation')
    if (status.status !== 'known') throw new Error('missing receipt')
    const command = { schemaVersion: 1, protocolVersion: 1, commandId: 'response', operationId: intent.operationId, attemptId: intent.attemptId, executionId: intent.executionId, bindingHash: intent.bindingHash, owner: intent.owner,
      native: status.receipt.native, action: { kind: 'respond', interactionId: 'interaction', interactionRevision: '1', nativeInteractionId: 'native-question', response: option } }
    await expect(host.control({ ...command, action: { ...command.action, response: { ...option, optionId: 'unoffered' } } })).rejects.toThrow('not offered')
    expect(state.responds).toBe(0)
    await host.control(command); await host.control(command)
    expect(state.responds).toBe(1)
  })
  it('revocation fences and requests physical cancellation without inventing closure', async () => { const { host, journal, intent, placement, request, state } = await setup(); await host.prepare({ intent, placement, request }); state.allowed = false; await host.refreshAuthority(); expect(state.cancels).toBe(1); const status = await journal.status('operation'); expect(status.status === 'known' && status.receipt.stopFence).toBe(true); expect(status.status === 'known' && status.receipt.phase).toBe('stop_requested') })
  it.each(['/runtime','/runtime/../other','/project/runtime','/another/runtime'])('rejects unbound runtime leaf %s before native work', async runtimeDirectory => { const { host, intent, placement, request, state } = await setup(); await expect(host.prepare({ intent, placement, request: { ...request, runtimeDirectory } })).rejects.toThrow('runtime leaf'); expect(state.starts).toBe(0) })
  it('rejects placement/input drift and revoked authority before native work', async () => { const { host, intent, placement, request, state } = await setup(); await expect(host.prepare({ intent, placement, request: { ...request, input: { edited: true } } })).rejects.toThrow('binding mismatch'); state.allowed = false; await expect(host.prepare({ intent, placement, request })).rejects.toThrow('revoked'); expect(state.starts).toBe(0) })
  it('recovers the surviving original resident after observation uncertainty without native start or attach', async () => {
    const f = await setup()
    await f.host.prepare(f)
    await f.journal.uncertain(f.intent.operationId, 'lost observation')
    f.ports.verifyRecovery = vi.fn(async () => {})
    f.manager.attachSession = vi.fn(async () => { throw new Error('must not attach a replacement') })
    const recovered = await f.host.recover({ ...f, evidenceDigest: 'a'.repeat(64) })
    expect(recovered.status).toMatchObject({ status: 'known', receipt: { phase: 'start_acknowledged' } })
    expect(f.state.starts).toBe(1)
    expect(f.manager.attachSession).not.toHaveBeenCalled()
  })
  it('refuses cold allocation even with provider-thread recovery proof', async () => {
    const f = await setup()
    await f.host.prepare(f)
    await f.journal.uncertain(f.intent.operationId, 'lost host')
    const attach = vi.fn(async () => f.session)
    f.manager.attachSession = attach
    const cold = new RemoteExecutionHost({ ...f.ports,
      managers: new ExecutionScopedNativeSessionManagerResolver(() => f.manager), verifyRecovery: async () => {} })
    hosts.push(cold)
    await expect(cold.recover({ ...f, evidenceDigest: 'a'.repeat(64) })).rejects.toThrow('cold recovery unavailable')
    expect(attach).not.toHaveBeenCalled()
    expect(f.state.starts).toBe(1)
    expect(await f.journal.status(f.intent.operationId)).toMatchObject({ status: 'known', receipt: { phase: 'uncertain' } })
  })
  it.each(['input', 'runId', 'workflowNodeId', 'workingDirectory'] as const)('rejects recovery request drift in %s before manager allocation', async field => {
    const f = await setup()
    await f.host.prepare(f)
    f.ports.verifyRecovery = vi.fn(async () => {})
    const request = { ...f.request, [field]: field === 'input' ? { edited: true } : 'changed' }
    await expect(f.host.recover({ ...f, request, evidenceDigest: 'a'.repeat(64) })).rejects.toThrow('Recovery binding mismatch')
    expect(f.ports.verifyRecovery).not.toHaveBeenCalled()
    expect(f.state.starts).toBe(1)
  })
  it('retains uncertainty when original physical process proof changes during recovery', async () => {
    const f = await setup()
    await f.host.prepare(f)
    await f.journal.uncertain(f.intent.operationId, 'lost observation')
    f.ports.verifyRecovery = async () => {}
    f.ports.nativeEvidence = async () => ({ sessionId: f.session.nativeSessionId, processIdentityDigest: 'b'.repeat(64) })
    await expect(f.host.recover({ ...f, evidenceDigest: 'a'.repeat(64) })).rejects.toThrow('original native lifetime')
    expect(await f.journal.status(f.intent.operationId)).toMatchObject({ status: 'known', receipt: { phase: 'uncertain' } })
  })
  it('observes an attached original session source before returning it and retains disposal guard on failed observation', async () => {
    const f = await setup()
    await f.host.prepare(f)
    const observe = vi.fn(async () => { throw new Error('physical evidence missing') })
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: (_method, frame) => f.host.handle(frame) }, observeReceipt: async () => {},
      observeOriginalSource: observe, controlFor: async () => { throw new Error('unused') } })
    await expect(proxy.attachSession(f.session, { request: f.request, correlationId: 'execution:execution' })).rejects.toThrow('physical evidence missing')
    expect(observe).toHaveBeenCalledWith(expect.anything(), { type: 'session_created', session: f.session })
    await expect(proxy.dispose()).rejects.toThrow('disposal is unconfirmed')
    expect(f.state.starts).toBe(1)
  })
  it.each(['owner', 'sequence', 'process'] as const)('rejects proxy %s drift before receipt observation', async field => {
    const f = await setup()
    let forged = false
    const observed = vi.fn(async () => {})
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: async (_method, frame) => {
        const response = await f.host.handle(frame)
        if (!forged) return response
        const status = await f.journal.status(f.intent.operationId)
        if (status.status !== 'known') throw new Error('missing receipt')
        if (field === 'owner') status.receipt.intent.owner.epoch = '2'
        if (field === 'sequence') status.receipt.sequence--
        if (field === 'process') status.receipt.native!.processIdentityDigest = 'b'.repeat(64)
        return { session: f.session, status }
      } }, observeReceipt: observed, controlFor: async () => { throw new Error('unused') } })
    await proxy.createSession({ request: f.request, correlationId: 'execution:execution' })
    forged = true
    await expect(proxy.attachSession(f.session, { request: f.request, correlationId: 'execution:execution' })).rejects.toThrow(/receipt (binding mismatch|changed)/)
    expect(observed).toHaveBeenCalledTimes(1)
    expect(f.state.starts).toBe(1)
  })

  it('reattaches only the exact resident through authenticated RPC without provider attach or launch', async () => {
    const f = await setup()
    await f.host.prepare(f)
    f.manager.attachSession = vi.fn(async () => { throw new Error('replacement forbidden') })
    const original = await f.journal.status(f.intent.operationId)
    const frame = { method: 'reattach', intent: f.intent, placement: f.placement, request: f.request, session: f.session }
    expect(await f.host.handle(frame)).toEqual({ session: f.session, status: original })
    await expect(f.host.handle({ ...frame, request: { ...f.request, runtimeDirectory: '/runtime/replacement' } })).rejects.toThrow('reattachment binding mismatch')
    expect(f.manager.attachSession).not.toHaveBeenCalled()
    expect(f.state.starts).toBe(1)
    await f.journal.uncertain(f.intent.operationId, 'lost native observation')
    await expect(f.host.handle(frame)).rejects.toThrow('requires reconciliation')
  })

  it('recovers a lost prepare acknowledgement by observing the original resident without replaying prepare', async () => {
    const f = await setup(), sources: string[] = []
    const methods: string[] = []
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: async (method, frame) => {
        methods.push(method)
        const response = await f.host.handle(frame)
        if (method === 'prepare') throw new Error('lost prepare acknowledgement')
        return response
      } }, observeReceipt: async () => {}, observeOriginalSource: async (_receipt, source) => { sources.push(source.type) },
      controlFor: async () => { throw new Error('unused') } })
    await expect(proxy.createSession({ request: f.request, correlationId: 'execution:execution' })).rejects.toThrow('lost prepare acknowledgement')
    expect(await proxy.attachSession(f.session, { request: f.request, correlationId: 'execution:execution' })).toEqual(f.session)
    expect(methods).toEqual(['prepare', 'reattach'])
    expect(sources).toEqual(['session_created'])
    expect(f.state.starts).toBe(1)
  })

  it('does not replay an exact response whose native acknowledgement was lost', async () => {
    const f = await setup()
    await f.host.prepare(f)
    await f.host.startTurn(f.intent.operationId, 'prompt', 'execution:execution')
    await f.host.drain()
    const option = CODEX_APPROVAL_OPTIONS_FIXTURE[0]!
    f.manager.pending = async () => ({ session: f.session, turn: { nativeTurnId: 'native-turn', nativeRequestId: 'question' }, nativeRequestType: 'approval', request: {}, responseOptions: [option] })
    f.manager.respond = async () => { f.state.responds++; throw new Error('lost acknowledgement') }
    const status = await f.journal.status(f.intent.operationId)
    if (status.status !== 'known') throw new Error('missing original')
    const command = { schemaVersion: 1, protocolVersion: 1, commandId: 'original-response', operationId: f.intent.operationId,
      attemptId: f.intent.attemptId, executionId: f.intent.executionId, bindingHash: f.intent.bindingHash, owner: f.intent.owner, native: status.receipt.native,
      action: { kind: 'respond', interactionId: 'interaction', interactionRevision: '1', nativeInteractionId: 'question', response: option } }
    expect(await f.host.control(command)).toMatchObject({ status: 'known', receipt: { phase: 'uncertain' } })
    expect(await f.host.control(command)).toMatchObject({ status: 'known', receipt: { phase: 'uncertain' } })
    expect(f.state.responds).toBe(1)
    expect(f.state.starts).toBe(1)
  })

})

it('keeps the admitted mode in worker turn replay identity after journal restart', async () => {
  const f = await setup()
  await f.host.prepare({ intent: f.intent, placement: f.placement, request: f.request })
  await f.host.startTurn(f.intent.operationId, 'prompt', 'execution:execution', 'plan')
  await expect(f.host.startTurn(f.intent.operationId, 'prompt', 'execution:execution', 'regular'))
    .rejects.toThrow('Turn input binding conflict')
  await f.host.drain()
  await f.journal.close()
  const reopened = await RemoteOperationJournal.open(join(roots.at(-1)!, 'journal'))
  journals.push(reopened)
  await expect(reopened.reserveTurn(f.intent.operationId, {
    correlationId: 'execution:execution', promptDigest: createHash('sha256').update('prompt').digest('hex'),
    sessionMode: 'regular',
  })).rejects.toThrow('Turn input binding conflict')
  expect(f.state.turns).toBe(1)
})
