import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { AgentPlacementProducer } from './agentProducer.js'
import { deriveDispatch, freezePlacement } from './binding.js'
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
  const state = { grant: true, origin: connection, cleanup: false, stopped: false }
  const sql = { query: async (text: string) => {
    if (text.includes('from runs r')) return { rows: [{ authorization_principal_id: 'principal', workspace_id: 'workspace',
      workflow_id: 'workflow', execution_state: 'running', stopped: state.stopped, cleanup: state.cleanup }], rowCount: 1 }
    if (text.includes('execution_dispatch_owner_grants')) return { rows: [], rowCount: state.grant ? 1 : 0 }
    if (text.includes('remote_dispatch_origins')) return { rows: [{ connection: state.origin }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  } } as unknown as GraphTransactionSql
  const locations = { revalidateRunAuthorization: vi.fn(async () => {}) }
  const pins = vi.fn(async () => {})
  const producer = { assertPinsCurrent: pins } as unknown as AgentPlacementProducer
  ports.intent.mockResolvedValue(intent)
  ports.placement.mockResolvedValue(placement)
  ports.installation.mockResolvedValue(registration)
  ports.principal.mockResolvedValue({ id: 'principal' })
  const authorize = (action: 'start' | 'read' | 'control' | 'stop', authenticated = connection) =>
    assertRemoteExecutionAuthority(sql, locations, { version: 1, intent, placement, action }, authenticated, producer)
  return { authorize, state, locations, pins, connection, intent }
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
    await expect(f.authorize('stop')).resolves.toBeUndefined()
    await expect(f.authorize('read')).resolves.toBeUndefined()
  })

  it('requires a committed cleanup intent even when the caller holds the original grant', async () => {
    const f = fixture()
    await expect(f.authorize('stop')).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    expect(f.locations.revalidateRunAuthorization).not.toHaveBeenCalled()
  })

  it.each(['owner-grant', 'dispatch-owner', 'registration', 'device', 'boot'])('preserves the %s fence during cleanup', async defect => {
    const f = fixture()
    f.state.cleanup = true
    if (defect === 'owner-grant') f.state.grant = false
    if (defect === 'dispatch-owner') ports.intent.mockResolvedValue({ ...f.intent, owner: { grantId: 'other', epoch: '2' } })
    if (defect === 'registration') ports.installation.mockResolvedValue({ authorizationRevision: 2, keyRevision: 1 })
    const authenticated = { ...f.connection }
    if (defect === 'device') authenticated.deviceId = randomUUID()
    if (defect === 'boot') authenticated.bootId = randomUUID()
    await expect(f.authorize('stop', authenticated)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })
})
