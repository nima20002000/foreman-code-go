import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { AgentPlacementProducer } from './agentProducer.js'
import { deriveDispatch, freezePlacement } from './binding.js'
import { approvalFixture } from '../../../test/helpers/wave25ApprovalFixture.js'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { assertRemoteExecutionAuthority } from './executionAuthority.js'

const ports = vi.hoisted(() => ({ intent: vi.fn(), placement: vi.fn(), installation: vi.fn(), principal: vi.fn() }))
vi.mock('../runs/remote/persistence.js', () => ({ readReconciledDispatchIntent: ports.intent }))
vi.mock('./persistence.js', () => ({ readExecutionPlacement: ports.placement, readNativePlacement: vi.fn(async () => ({})) }))
vi.mock('../devices/hostAuthorization.js', () => ({ assertDeviceHostInstallation: ports.installation }))
vi.mock('../access/liveManagementPrincipal.js', () => ({ readLiveManagementPrincipal: ports.principal }))

function fixture() {
  const mainId = randomUUID()
  const digest = 'a'.repeat(64)
  const registration = { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
  const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId, runId: 'run', nodeId: 'node',
    hostRef: { kind: 'device', mainId, deviceId: randomUUID() }, registration,
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex',
      driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness',
      installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: 'execution', operationId: 'operation', attemptId: 'attempt',
    technicalAttempt: 1, occurrenceId: null, occurrenceIndex: 0, inputDigest: `sha256:${digest}`,
    owner: { grantId: 'grant', epoch: '1' } })
  if (placement.hostRef.kind !== 'device') throw new Error('Expected device placement')
  const connection = { mainId, deviceId: placement.hostRef.deviceId, ...registration,
    bootId: randomUUID(), connectionGeneration: 1 }
  const state = { grant: true, origin: connection, cleanup: false, stopped: false, receipt: true, reviewer: undefined as unknown, reviewsPending: false }
  const receipt: RemoteOperationReceipt = { schemaVersion: 1, intent, connection, workerIncarnationId: randomUUID(), sequence: 4,
    phase: 'running', entryAttempted: true, turnEntryAttempted: true, stopFence: false, controls: [],
    turnInput: { correlationId: 'execution:execution', promptDigest: digest, sessionMode: 'regular' },
    native: { sessionId: 'native-session', turnId: 'original-turn', processIdentityDigest: digest } }
  const sql = { query: async (text: string) => {
    if (text.startsWith('select r.record as run')) return { rows: state.reviewer ? [state.reviewer] : [],
      rowCount: state.reviewer ? 1 : 0 }
    if (text.startsWith('select 1 from review_jobs')) return { rows: state.reviewsPending ? [{}] : [],
      rowCount: state.reviewsPending ? 1 : 0 }
    if (text.includes('from runs r')) return { rows: [{ authorization_principal_id: 'principal', workspace_id: 'workspace',
      workflow_id: 'workflow', execution_state: 'running', stopped: state.stopped, cleanup: state.cleanup }], rowCount: 1 }
    if (text.includes('execution_dispatch_owner_grants')) return { rows: [], rowCount: state.grant ? 1 : 0 }
    if (text.includes('remote_dispatch_origins')) return { rows: [{ connection: state.origin }], rowCount: 1 }
    if (text.includes('remote_execution_receipts')) return { rows: state.receipt ? [{ receipt }] : [], rowCount: state.receipt ? 1 : 0 }
    return { rows: [], rowCount: 1 }
  } } as unknown as GraphTransactionSql
  const locations = { revalidateRunAuthorization: vi.fn(async () => {}) }
  const pins = vi.fn<AgentPlacementProducer['assertPinsCurrent']>(async () => {})
  const producer = { assertPinsCurrent: pins } as unknown as AgentPlacementProducer
  ports.intent.mockResolvedValue(intent)
  ports.placement.mockResolvedValue(placement)
  ports.installation.mockResolvedValue(registration)
  ports.principal.mockResolvedValue({ id: 'principal' })
  const authorize = (action: 'start' | 'read' | 'control' | 'stop', authenticated = connection) =>
    assertRemoteExecutionAuthority(sql, locations, { version: 1, intent, placement, action }, authenticated, producer)
  return { authorize, state, locations, pins, connection, intent, receipt }
}


function retainReviewer(f: ReturnType<typeof fixture>) {
  const saved = approvalFixture()
  const execution = { ...saved.executions[0]!, id: f.intent.executionId, runId: f.intent.runId,
    workflowNodeId: f.intent.nodeId, nativeSessionId: f.receipt.native!.sessionId,
    state: 'completed' as const, finishedAt: '2026-10-01T00:00:00.000Z',
    result: { outcome: 'succeeded' as const } }
  saved.version.entryNodeId = f.intent.nodeId
  saved.version.definition.entryNodeId = f.intent.nodeId
  saved.version.definition.nodes[0]!.id = f.intent.nodeId
  for (const edge of saved.version.definition.edges) edge.source = f.intent.nodeId
  const reviewer = { run: { ...saved.run, id: f.intent.runId }, version: saved.version,
    execution, configuration: saved.configurations[0], finalized: true,
    reference: { harness: 'codex', providerVersion: 'fixture', nativeSessionId: f.receipt.native!.sessionId } }
  f.state.reviewer = reviewer
  f.receipt.retainedReviewer = { agentId: execution.agentId, workflowTurnId: f.receipt.native!.turnId!,
    result: execution.result, expiresAt: '2026-10-01T00:01:00.000Z' }
  return reviewer
}

describe('remote cleanup authorization', () => {
  it.each(['permission', 'source', 'root', 'harness'])('keeps Stop and closure readback after %s invalidation', async defect => {
    const f = fixture()
    f.state.cleanup = true
    f.state.stopped = true
    if (defect === 'permission') f.locations.revalidateRunAuthorization.mockRejectedValue(new Error('Permission revoked'))
    else f.pins.mockRejectedValue(new Error(`${defect} changed`))
    await expect(f.authorize('start')).rejects.toThrow()
    await expect(f.authorize('control')).rejects.toThrow()
    await expect(f.authorize('stop')).resolves.toEqual({ cleanupOnly: true })
    await expect(f.authorize('read')).resolves.toEqual({ cleanupOnly: true })
  })

  it('authorizes closure of a successful idle reviewer while preserving live Run grants', async () => {
    const f = fixture()
    retainReviewer(f)
    await expect(f.authorize('stop')).resolves.toBeUndefined()
    expect(f.locations.revalidateRunAuthorization).toHaveBeenCalled()
    expect(f.pins).toHaveBeenCalled()
    f.state.reviewsPending = true
    await expect(f.authorize('stop')).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    f.state.reviewsPending = false
    f.locations.revalidateRunAuthorization.mockRejectedValue(new Error('Permission revoked'))
    await expect(f.authorize('stop')).rejects.toThrow('Permission revoked')
  })

  it('keeps successful reviewer closure tied to session finalization and its live owner grant', async () => {
    const f = fixture()
    const reviewer = retainReviewer(f)
    await expect(f.authorize('stop')).resolves.toBeUndefined()
    reviewer.finalized = false
    await expect(f.authorize('stop')).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    reviewer.finalized = true
    f.state.grant = false
    await expect(f.authorize('stop')).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })

  it('requires a committed cleanup intent even when the caller holds the original grant', async () => {
    const f = fixture()
    await expect(f.authorize('stop')).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    expect(f.locations.revalidateRunAuthorization).not.toHaveBeenCalled()
  })

  it.each(['owner-grant', 'dispatch-owner', 'registration', 'device'])('preserves the %s fence during cleanup', async defect => {
    const f = fixture()
    f.state.cleanup = true
    if (defect === 'owner-grant') f.state.grant = false
    if (defect === 'dispatch-owner') ports.intent.mockResolvedValue({ ...f.intent, owner: { grantId: 'other', epoch: '2' } })
    if (defect === 'registration') ports.installation.mockResolvedValue({ authorizationRevision: 2, keyRevision: 1 })
    const authenticated = { ...f.connection }
    if (defect === 'device') authenticated.deviceId = randomUUID()
    await expect(f.authorize('stop', authenticated)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })
})

describe('authenticated original execution reconnection', () => {
  it('allows existing-owner control on a replacement channel without authorizing new entry', async () => {
    const f = fixture()
    const replacement = { ...f.connection, connectionGeneration: 2 }
    await expect(f.authorize('read', replacement)).resolves.toBeUndefined()
    await expect(f.authorize('control', replacement)).resolves.toBeUndefined()
    expect(f.pins.mock.calls.at(-1)?.[4]).toEqual({ purpose: 'resident' })
    f.state.cleanup = true
    await expect(f.authorize('stop', replacement)).resolves.toEqual({ cleanupOnly: true })
    await expect(f.authorize('start', replacement)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    expect(f.receipt.connection).toEqual(f.connection)
  })

  it.each(['native', 'owner', 'origin'])('requires retained original %s evidence before reconnecting control', async defect => {
    const f = fixture()
    if (defect === 'native') delete (f.receipt as { native?: unknown }).native
    if (defect === 'owner') f.receipt.intent = { ...f.intent, owner: { grantId: 'other', epoch: '2' } }
    if (defect === 'origin') f.receipt.connection = { ...f.connection, connectionGeneration: 2 }
    const replacement = { ...f.connection, connectionGeneration: 2 }
    await expect(f.authorize('read', replacement)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    await expect(f.authorize('control', replacement)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })

  it('reads an acknowledged owner after an OS restart without authorizing continuation or new entry', async () => {
    const f = fixture()
    const restarted = { ...f.connection, bootId: randomUUID(), connectionGeneration: 2 }
    f.pins.mockRejectedValue(new Error('New OS has no current launch qualification'))
    await expect(f.authorize('read', restarted)).resolves.toBeUndefined()
    expect(f.locations.revalidateRunAuthorization).toHaveBeenCalled()
    expect(f.pins).not.toHaveBeenCalled()
    for (const action of ['control', 'start', 'stop'] as const) {
      await expect(f.authorize(action, restarted)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    }
    f.state.cleanup = true
    await expect(f.authorize('stop', restarted)).resolves.toEqual({ cleanupOnly: true })
    delete (f.receipt as { native?: unknown }).native
    await expect(f.authorize('read', restarted)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })

  it('can consult the original worker journal when Main lost the preparation acknowledgment', async () => {
    const f = fixture()
    f.state.receipt = false
    const replacement = { ...f.connection, connectionGeneration: 2 }
    f.pins.mockRejectedValue(new Error('This channel cannot qualify a new launch'))
    await expect(f.authorize('read', replacement)).resolves.toBeUndefined()
    expect(f.locations.revalidateRunAuthorization).toHaveBeenCalled()
    expect(f.pins).not.toHaveBeenCalled()
    await expect(f.authorize('control', replacement)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    await expect(f.authorize('start', replacement)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    f.state.cleanup = true
    await expect(f.authorize('stop', replacement)).resolves.toEqual({ cleanupOnly: true })
    f.state.grant = false
    await expect(f.authorize('read', replacement)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })
})
