import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { SourceApproveInputSchema, SourceRootBindInputSchema, type SourceRootRecord, type SourceMaterializationRecord, type SourcePreparationClosure } from '@foreman-code/contracts/source-admission'
import { PostgresSourceService } from './service.js'
import { PostgresSourceReservations } from './reservations.js'
import { sourceBindingHash, sourceMaterializationDigest } from './bindingHash.js'
import { sourceStorageCapacityFixture } from '../../../test/helpers/sourceStorageCapacityFixture.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { PrivateSourceSnapshotStore } from './store.js'
import type { RegisteredSourceRootPort, SourceClosureProofPort } from './admissionPorts.js'
import type { SourceExecutionHostPort } from './service.js'
const principal: ManagementPrincipal = { id: 'real-reader-fixture', name: 'reader', audience: 'operator', grants: [{ actions: ['sources:read'], scope: { workspaceIds: ['workspace-owned'] } }], expiresAt: '9999-01-01T00:00:00Z', revokedAt: null }
describe('source admission boundaries', () => {
  it.each(['metadata-only', 'materialized'] as const)('accounts retained %s failures without charging uncreated source copies', async state => {
    const operationId = randomUUID()
    const reservedBytes = 100 * 1024 * 1024
    let storedBytes = reservedBytes
    const sql = { query: async (_statement: string, values: unknown[]) => {
      if (values[1] === 'retained') storedBytes = Number(values[2])
      return { rows: [], rowCount: 1 }
    } } as unknown as pg.PoolClient
    const reservation = { reservationId: randomUUID(), scopeId: 'original-volume', ownerKind: 'materialization' as const,
      ownerId: operationId, reservedBytes }
    const closure: SourcePreparationClosure = { version: 1, reconciliationId: randomUUID(), operationId,
      executionId: randomUUID(), attemptId: randomUUID(), rootId: randomUUID(), bindingRevision: 1,
      materializationId: state === 'metadata-only' ? null : randomUUID(), mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
      filesystem: { device: '1', inode: '2', mountId: '3' }, admissionClosed: true, childrenClosed: true,
      claimReleased: true, evidencePreserved: true, observedAt: new Date().toISOString() }
    const reservations = new PostgresSourceReservations()
    await expect(reservations.retainClosedPreparation(sql, reservation, { ...closure, operationId: randomUUID() }, storedBytes))
      .rejects.toMatchObject({ code: 'SOURCE_RESERVATION_CONFLICT' })
    expect(storedBytes).toBe(reservedBytes)
    await reservations.retainClosedPreparation(sql, reservation, closure, storedBytes)
    expect(storedBytes).toBe(state === 'metadata-only' ? 16 * 1024 : reservedBytes)
    await reservations.retainClosedPreparation(sql, reservation, closure, storedBytes)
    expect(storedBytes).toBe(state === 'metadata-only' ? 16 * 1024 : reservedBytes)
  })

  it('requires approval scope before SQL, filesystem, host or command work', async () => {
    const probe = vi.fn()
    const service = new PostgresSourceService({ connect: probe } as unknown as pg.Pool, { execute: probe } as unknown as PostgresCommandCoordinator,
      { snapshot: probe } as unknown as WorkspaceLocationService, {} as PrivateSourceSnapshotStore, randomUUID(), {} as RegisteredSourceRootPort, {} as SourceExecutionHostPort, {} as SourceClosureProofPort)
    await expect(service.approve(principal, 'mcp', { workspaceId: 'workspace-owned', commandId: randomUUID(), expectedLocationRevision: 1,
      commit: 'a'.repeat(40), approvedPaths: ['src/app.ts'], executablePolicy: 'strip' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(probe).not.toHaveBeenCalled()
  })
  it('rejects tool-supplied paths, fake Agent/Run selectors and mutable Git refs', () => {
    const input = { workspaceId: 'workspace-owned', commandId: randomUUID(), expectedLocationRevision: 1, commit: 'a'.repeat(40), approvedPaths: ['src/app.ts'], executablePolicy: 'strip' }
    for (const extra of [{ rootPath: '/home/other' }, { agentId: 'invented' }, { runId: 'invented' }, { commit: 'HEAD' }]) expect(SourceApproveInputSchema.safeParse({ ...input, ...extra }).success).toBe(false)
    expect(SourceRootBindInputSchema.safeParse({ rootPath: '/home/other' }).success).toBe(false)
  })
  it('includes retained and uncertain copies in the shared aggregate storage budget', async () => {
    let inserted = false
    const query = vi.fn(async (text: string) => {
      if (text.startsWith('insert into')) inserted = true
      if (text.includes('select record,state')) return { rows: [] }
      if (text.includes('coalesce(sum')) return { rows: [{ bytes: String(1024 * 1024 * 1024),
        verification_bytes: '0', pending_bytes: '0', preparing: '0', materializations: '0',
        verification_materializations: '0' }] }
      return { rows: [], rowCount: 1 }
    })
    const reservations = new PostgresSourceReservations(async () => sourceStorageCapacityFixture())
    await expect(reservations.reserve({ query } as unknown as pg.PoolClient,
      { scopeId: 'capacity-scope', ownerKind: 'materialization', ownerId: 'operation', reservedBytes: 1 }))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
    expect(inserted).toBe(false)
  })
  it('does not treat disconnect, expiry or uncertain closure as reclamation', async () => {
    const query = vi.fn()
    await expect(new PostgresSourceReservations().reclaimed({ query } as unknown as pg.PoolClient,
      { reservationId: randomUUID(), scopeId: 'main:filesystem', ownerKind: 'materialization', ownerId: 'real-operation', reservedBytes: 100 }, async () => false)).rejects.toMatchObject({ code: 'SOURCE_RECLAMATION_UNCONFIRMED' })
    expect(query).not.toHaveBeenCalled()
  })
  it('separates source selection hashes from actual final dispatch adoption', () => {
    const root = { source: { approvedSourceId: randomUUID(), snapshotId: randomUUID(), manifestDigest: 'a'.repeat(64) },
      binding: { rootId: randomUUID(), bindingRevision: 1 }, selection: { rootPolicyId: 'actual-policy', rootPolicyRevision: '1' }, registration: null,
      attestationId: 'actual-attestation', attestationDigest: 'b'.repeat(64) } as unknown as SourceRootRecord
    const attempt = { executionId: 'execution-actual', attemptId: 'attempt-actual', keyRevision: null, authorizationRevision: null }
    const hash = sourceBindingHash(root, attempt, 'operation-actual')
    expect(sourceBindingHash(root, { ...attempt, attemptId: 'attempt-other' }, 'operation-actual')).not.toBe(hash)
    const record = { receipt: { placementHash: hash }, sourceBindingHash: hash, rootPolicyId: 'actual-policy', rootPolicyRevision: '1', operationId: 'operation-actual', reservationId: randomUUID(), finalDispatchBindingHash: null, state: 'prepared' } as unknown as SourceMaterializationRecord
    expect(sourceMaterializationDigest({ ...record, finalDispatchBindingHash: 'c'.repeat(64), state: 'running' })).toBe(sourceMaterializationDigest(record))
  })
})
