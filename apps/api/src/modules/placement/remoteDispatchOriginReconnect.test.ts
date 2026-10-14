import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { RunOwnership } from '../runs/ownership.js'
import { deriveDispatch, freezePlacement } from './binding.js'
import { reserveRemoteDispatchOrigin } from './remoteReceiptCommit.js'

const ports = vi.hoisted(() => ({ intent: vi.fn(), placement: vi.fn() }))
vi.mock('../runs/remote/persistence.js', () => ({ readReconciledDispatchIntent: ports.intent,
  persistVerifiedRemoteReceipt: vi.fn(), auditRejectedRemoteReceipt: vi.fn() }))
vi.mock('./persistence.js', () => ({ readAcceptedPlacement: ports.placement }))
vi.mock('../run-graph/connection.js', () => ({ beforeGraphCommit: vi.fn() }))

function fixture() {
  const mainId = randomUUID(), digest = 'a'.repeat(64)
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
  const original = { mainId, deviceId: placement.hostRef.deviceId, ...registration, bootId: randomUUID(), connectionGeneration: 1 }
  // remote_dispatch_origins keeps the first delivery connection (insert ... on conflict do nothing).
  let origin: unknown
  const sql = { query: async (text: string, values: unknown[]) => {
    if (text.startsWith('insert into remote_dispatch_origins')) { origin ??= JSON.parse(String(values[1])); return { rows: [], rowCount: 1 } }
    if (text.startsWith('select connection from remote_dispatch_origins')) return { rows: origin ? [{ connection: origin }] : [], rowCount: origin ? 1 : 0 }
    throw new Error(`Unexpected statement in the origin fixture`)
  } } as unknown as GraphTransactionSql
  const owner = { runId: 'run', assertOwned: () => {}, readOneShotFence: async () => {} } as unknown as RunOwnership
  ports.intent.mockResolvedValue(intent)
  ports.placement.mockResolvedValue(placement)
  const reserve = (connection: typeof original) => reserveRemoteDispatchOrigin(sql, owner, intent, connection,
    { assertCurrent: async () => {} })
  return { reserve, original }
}

describe('original dispatch delivery connection', () => {
  it('accepts the replayed preparation from the reconnected session of the same Worker boot', async () => {
    const f = fixture()
    await f.reserve(f.original)
    await expect(f.reserve({ ...f.original, connectionGeneration: 2 })).resolves.toBeUndefined()
  })

  it('still refuses delivery to a restarted Worker boot', async () => {
    const f = fixture()
    await f.reserve(f.original)
    await expect(f.reserve({ ...f.original, bootId: randomUUID(), connectionGeneration: 2 }))
      .rejects.toMatchObject({ code: 'REMOTE_ORIGINAL_OPERATION_REQUIRED' })
  })
})
