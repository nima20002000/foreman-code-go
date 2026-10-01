import type pg from 'pg'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { SourceRootRecord, SourceMaterializationRecord } from '@graphql/contracts/source-admission'
import type { SourceManifest } from '@graphql/contracts/source-materialization'
import { DomainError } from '../errors.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim } from './materialization.js'
import { createPrivateSourceRepository } from './repository.js'
import type { MaterializationAttempt, SourceByteReader } from './ports.js'
import type { SourceExecutionHostPort } from './service.js'

export interface SourceAttemptAuthority {
  authorize(sql: Pick<pg.PoolClient, 'query'>, principal: ManagementPrincipal, input: { workspaceId: string; root: SourceRootRecord; attempt: MaterializationAttempt; operationId: string }): Promise<void>
  authorizeFinal(sql: Pick<pg.PoolClient, 'query'>, principal: ManagementPrincipal, record: SourceMaterializationRecord, finalDispatchBindingHash: string): Promise<void>
  /** Rechecks exact accepted source/root/current host authorization on that host.
   * It confers no native launch right; W08 final intent controls entry. */
  revalidate(root: SourceRootRecord, attempt: MaterializationAttempt): Promise<void>
  revalidateMaterialization(record: SourceMaterializationRecord): Promise<void>
}
export interface RemoteSourceMaterializationHost {
  prepare(manifest: SourceManifest, root: SourceRootRecord, attempt: MaterializationAttempt): Promise<SourceMaterializationRecord['receipt']>
  verify(record: SourceMaterializationRecord): Promise<string>
  releaseClaim(record: SourceMaterializationRecord): Promise<void>
}
/** Concrete original-main source copy. Remote carries exactly the same approved
 * operation through W07/B verified source bytes, never a second scheduler. */
export class InstalledSourceExecutionHosts implements SourceExecutionHostPort {
  constructor(private readonly mainId: string, private readonly bytes: SourceByteReader,
    private readonly authority: SourceAttemptAuthority, private readonly remote: RemoteSourceMaterializationHost) {}
  authorize(sql: Pick<pg.PoolClient, 'query'>, principal: ManagementPrincipal, input: { workspaceId: string; root: SourceRootRecord; attempt: MaterializationAttempt; operationId: string }) {
    return this.authority.authorize(sql, principal, input)
  }
  authorizeFinal(sql: Pick<pg.PoolClient, 'query'>, principal: ManagementPrincipal, record: SourceMaterializationRecord, hash: string) {
    return this.authority.authorizeFinal(sql, principal, record, hash)
  }
  async prepare(manifest: SourceManifest, root: SourceRootRecord, attempt: MaterializationAttempt) {
    if (root.binding.mainId !== this.mainId) throw new DomainError('SOURCE_WRONG_MAIN', 'Source copy belongs to another main.', 403)
    if (root.binding.deviceId !== null) return this.remote.prepare(manifest, root, attempt)
    const materializer = new PrivateSourceMaterializer(this.bytes, async () => this.authority.revalidate(root, attempt))
    return materializer.prepare({ manifest, binding: root.binding, attempt })
  }
  async verify(record: SourceMaterializationRecord): Promise<string> {
    if (record.receipt.binding.mainId !== this.mainId) throw new DomainError('SOURCE_WRONG_MAIN', 'Source copy belongs to another main.', 403)
    if (record.receipt.binding.deviceId !== null) return this.remote.verify(record)
    const expected = { binding: record.receipt.binding, attempt: { placementHash: record.receipt.placementHash, executionId: record.receipt.executionId,
      attemptId: record.receipt.attemptId, keyRevision: record.receipt.keyRevision, authorizationRevision: record.receipt.authorizationRevision } }
    return new PrivateSourceMaterializer(this.bytes, async () => this.authority.revalidateMaterialization(record)).resolve(record.receipt, expected)
  }
  /** Main service calls only after exact original physical closure proof. */
  async releaseClaim(record: SourceMaterializationRecord): Promise<void> {
    if (record.receipt.binding.deviceId !== null) return this.remote.releaseClaim(record)
    await releaseMaterializationClaim(record.receipt, async () => 'released')
  }
  /** CI-only explicit detached write copy; read-only references cannot acquire
   * write authority or Git working metadata through this helper. */
  async privateRepository(record: SourceMaterializationRecord, manifest: SourceManifest) {
    if (record.receipt.binding.deviceId !== null) throw new DomainError('SOURCE_PRIVATE_REPOSITORY_REMOTE', 'Request the actual private repository from the approved remote source host.', 409)
    if (record.receipt.binding.accessMode !== 'exclusive-write') throw new DomainError('SOURCE_READ_ONLY', 'Read-only source references cannot become writable execution copies.', 403)
    const materializer = new PrivateSourceMaterializer(this.bytes, async () => this.authority.revalidateMaterialization(record))
    return createPrivateSourceRepository({ receipt: record.receipt, manifest, materializer, attempt: { placementHash: record.receipt.placementHash,
      executionId: record.receipt.executionId, attemptId: record.receipt.attemptId,
      keyRevision: record.receipt.keyRevision, authorizationRevision: record.receipt.authorizationRevision } })
  }
}
