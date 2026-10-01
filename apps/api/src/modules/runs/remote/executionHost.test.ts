import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion } from '@graphql/contracts'
import { canonicalGraphJson } from '@graphql/contracts/wave25'
import { freezePlacement, deriveDispatch } from '../../placement/binding.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../interactions/runtimePorts.js'
import type { NativeHarnessSessionManager } from '../../harnesses/port.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteExecutionHost } from './executionHost.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'w08-host-')); roots.push(root)
  const journal = await RemoteOperationJournal.open(join(root, 'journal'), { initializeNewInstallation: true })
  const mainId = randomUUID(), deviceId = randomUUID(), installationId = randomUUID(), digest = 'a'.repeat(64)
  const configuration: AgentConfigurationVersion = { id: 'configuration', agentId: 'agent', workspaceId: 'workspace', version: 1, prompt: { system: 'test' }, assignedSkills: [], harness: DEFAULT_HARNESS_DEFAULTS.codex, contentHash: 'sha256:test', createdAt: '2026-10-01T00:00:00.000Z' }
  const placement = freezePlacement({ schemaVersion: 1, mainId, runId: 'run', nodeId: 'node', hostRef: { kind: 'device', mainId, deviceId }, registration: { workerInstallationId: installationId, keyRevision: 1, authorizationRevision: 1 }, mainInstallationId: 'main-installation',
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime', directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: digest }, source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness', installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  const input = { value: 'accepted' }, inputDigest = `sha256:${createHash('sha256').update(canonicalGraphJson(input)).digest('hex')}`
  const intent = deriveDispatch(placement, { executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', inputDigest, owner: { grantId: 'grant', epoch: '1' } })
  const request = { executionId: 'execution', runId: 'run', workspaceId: 'workspace', workflowNodeId: 'node', workingDirectory: '/project', runtimeDirectory: '/runtime', configuration, input }
  const state = { starts: 0, turns: 0, cancels: 0, allowed: true }
  const session = { harness: 'codex' as const, providerVersion: 'test', nativeSessionId: 'native-session' }
  const manager: NativeHarnessSessionManager = { harness: 'codex', capabilities: async () => { throw new Error('unused') }, inspectMcp: async () => { throw new Error('unused') }, createSession: async () => { state.starts++; return session }, attachSession: async () => session,
    startTurn: async function* (_session, turn) { state.turns++; await turn.onSubmitted?.('native-turn'); yield { sequence: 1, type: 'event', occurredAt: '2026-10-01T00:00:00.000Z', payload: {} } }, pending: async () => undefined, respond: async () => {}, cancel: async () => { state.cancels++; return false }, history: async () => ({ events: [], pendingInteractions: [] }), reconcile: async () => ({ events: [], pendingInteractions: [] }), close: async () => {} }
  const host = new RemoteExecutionHost({ journal, connection: { mainId, deviceId, workerInstallationId: installationId, bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }, incarnationId: randomUUID(), managers: new ExecutionScopedNativeSessionManagerResolver(() => manager), authorize: async () => { if (!state.allowed) throw new Error('revoked') }, preflight: async () => {}, nativeEvidence: async () => ({ sessionId: 'native-session', processIdentityDigest: digest }), settle: async () => null })
  return { host, journal, intent, placement, request, state }
}
describe('actual worker native-port adapter', () => {
  it('uses the native manager once across duplicated delivery and turn requests', async () => { const { host, intent, placement, request, state } = await setup(); await host.prepare({ intent, placement, request }); await host.prepare({ intent, placement, request }); expect(state.starts).toBe(1); await host.startTurn('operation', 'accepted prompt', 'execution:execution'); await host.startTurn('operation', 'accepted prompt', 'execution:execution'); expect(state.turns).toBe(1) })
  it('Stop delivered before Start persists a negative fence before any native manager launch', async () => { const { host, intent, placement, request, state } = await setup(); await host.control({ schemaVersion: 1, protocolVersion: 1, commandId: 'stop', operationId: intent.operationId, attemptId: intent.attemptId, executionId: intent.executionId, bindingHash: intent.bindingHash, owner: intent.owner, action: { kind: 'stop' } }, { intent, placement }); await expect(host.prepare({ intent, placement, request })).rejects.toThrow('reconciliation'); expect(state.starts).toBe(0) })
  it('revocation fences and requests physical cancellation without inventing closure', async () => { const { host, journal, intent, placement, request, state } = await setup(); await host.prepare({ intent, placement, request }); state.allowed = false; await host.refreshAuthority(); expect(state.cancels).toBe(1); const status = await journal.status('operation'); expect(status.status === 'known' && status.receipt.stopFence).toBe(true); expect(status.status === 'known' && status.receipt.phase).toBe('stop_requested') })
  it('rejects placement/input drift and revoked authority before native work', async () => { const { host, intent, placement, request, state } = await setup(); await expect(host.prepare({ intent, placement, request: { ...request, input: { edited: true } } })).rejects.toThrow('binding mismatch'); state.allowed = false; await expect(host.prepare({ intent, placement, request })).rejects.toThrow('revoked'); expect(state.starts).toBe(0) })
})
