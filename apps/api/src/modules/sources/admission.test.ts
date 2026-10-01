import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { SourceApproveInputSchema, SourceRootBindInputSchema, type SourceRootRecord, type SourceMaterializationRecord } from '@graphql/contracts/source-admission'
import { PostgresSourceService } from './service.js'
import { PostgresSourceReservations } from './reservations.js'
import { sourceBindingHash, sourceMaterializationDigest } from './bindingHash.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { PrivateSourceSnapshotStore } from './store.js'
import type { RegisteredSourceRootPort, SourceClosureProofPort } from './admissionPorts.js'
import type { SourceExecutionHostPort } from './service.js'
const principal: ManagementPrincipal = { id: 'real-reader-fixture', name: 'reader', audience: 'operator', grants: [{ actions: ['sources:read'], scope: { workspaceIds: ['workspace-owned'] } }], expiresAt: '9999-01-01T00:00:00Z', revokedAt: null }
describe('source admission boundaries', () => {
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
    const query = vi.fn(async (text: string) => {
      if (text.includes('select record,state')) return { rows: [] }
      if (text.includes('coalesce(sum')) return { rows: [{ bytes: String(1024 * 1024 * 1024), preparing: '0', materializations: '0' }] }
      return { rows: [], rowCount: 1 }
    })
    await expect(new PostgresSourceReservations().reserve({ query } as unknown as pg.PoolClient, { scopeId: 'actual-main:filesystem:mount', ownerKind: 'materialization', ownerId: 'actual-operation', reservedBytes: 1 })).rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
    expect(query.mock.calls.some(([text]) => text.includes("state<>'reclaimed'"))).toBe(true)
    expect(query.mock.calls.some(([text]) => text.includes('insert into'))).toBe(false)
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
