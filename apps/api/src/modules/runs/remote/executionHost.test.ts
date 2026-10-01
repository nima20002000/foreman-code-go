import { createRemoteExecutionHandler } from './executionRouter.js'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import type { RemoteJobDispatchIntent } from '@graphql/contracts/remote-job-execution'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, CODEX_APPROVAL_OPTIONS_FIXTURE, type AgentConfigurationVersion } from '@graphql/contracts'
import { canonicalGraphJson } from '@graphql/contracts/wave25'
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
  const journal = await RemoteOperationJournal.open(join(root, 'journal'), { initializeNewInstallation: true })
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
  return { host, manager, session, journal, intent, placement, request, state, ports }
}
describe('actual worker native-port adapter', () => {
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

  it('uses the native manager once across duplicated delivery and turn requests', async () => { const { host, intent, placement, request, state } = await setup(); await host.prepare({ intent, placement, request }); await host.prepare({ intent, placement, request }); expect(state.starts).toBe(1); await host.startTurn('operation', 'accepted prompt', 'execution:execution'); await host.startTurn('operation', 'accepted prompt', 'execution:execution'); expect(state.turns).toBe(1); await host.drain() })
  it('routes the main native port through the shared bound RPC and observes requested cancellation', async () => {
    const { host, intent, placement, request, state } = await setup()
    const observed: string[] = []
    const proxy = new RemoteNativeSessionManager({ intent, placement, harness: 'codex', configuration: request.configuration,
      transport: { request: (_method, frame) => host.handle(frame) }, observeReceipt: async receipt => { observed.push(receipt.phase) },
      controlFor: async ({ native }) => ({ schemaVersion: 1, protocolVersion: 1, commandId: 'proxy-stop', operationId: intent.operationId, attemptId: intent.attemptId, executionId: intent.executionId, bindingHash: intent.bindingHash, owner: intent.owner, native, action: { kind: 'stop' } }) })
    const session = await proxy.createSession({ request, correlationId: 'execution:execution' })
    expect(await proxy.cancel(session)).toBe(false)
    expect(state.starts).toBe(1); expect(state.cancels).toBe(1); expect(observed).toEqual(['start_acknowledged', 'stop_requested'])
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
})
