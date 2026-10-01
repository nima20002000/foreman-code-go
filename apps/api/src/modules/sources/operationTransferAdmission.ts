import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { TransferIntentSchema, TransferContextSchema, type TransferIntent, type TransferContext } from '@graphql/contracts/byte-transfer'
import { SourceRootRecordSchema, type SourceRootRecord } from '@graphql/contracts/source-admission'
import { SourcePreparationIdentitySchema } from '@graphql/contracts/source-operations'
import type { z } from 'zod'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { createEndpointTransferClient, transferContextForBinding, type AcceptedTransferAuthority } from '../byte-transfer/carrier.js'
import type { ImmutableTransferSource } from '../byte-transfer/sender.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { TransferOperation } from '../byte-transfer/service.js'
import type { MaterializationAttempt } from './ports.js'
import type { PostgresSourceOperationAuthority } from './operationAuthority.js'
import type { SourcePackageTransferAdmission } from './operationSender.js'
type Identity = z.infer<typeof SourcePreparationIdentitySchema>
type Allocation = { root: SourceRootRecord; attempt: MaterializationAttempt; identity: Identity; intent: TransferIntent }
/** Original Main command ledger is reused, never a new worker DB/resource registry. */
export class PostgresSourcePackageTransfers implements SourcePackageTransferAdmission, AcceptedTransferAuthority {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly owners: PostgresSourceOperationAuthority, private readonly endpoint: () => DeviceEndpoint) {}
  private binding(root: SourceRootRecord) {
    const registration = root.registration, binding = this.endpoint().currentBinding(root.binding.deviceId!)
    if (!binding || !registration || binding.mainId !== root.binding.mainId || binding.deviceId !== root.binding.deviceId
      || binding.workerInstallationId !== registration.workerInstallationId || binding.keyRevision !== registration.keyRevision
      || binding.authorizationRevision !== registration.authorizationRevision) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source package transfer is not on its actual accepted current device.', 409)
    return binding
  }
  async revalidate(root: SourceRootRecord, attempt: MaterializationAttempt, identity: Identity) {
    const sql = await this.pool.connect()
    try { await sql.query('begin'); await this.owners.authorizePreparation(sql, root, attempt, identity); this.binding(root); await sql.query('commit') }
    catch (error) { await sql.query('rollback'); throw error } finally { sql.release() }
  }
  async allocate(input: { root: SourceRootRecord; attempt: MaterializationAttempt; identity: Identity; sha256: string; byteSize: number }): Promise<TransferIntent> {
    const sql = await this.pool.connect()
    let principal
    try { await sql.query('begin'); principal = await this.owners.authorizePreparation(sql, input.root, input.attempt, input.identity); await sql.query('commit') }
    catch (error) { await sql.query('rollback'); throw error } finally { sql.release() }
    return (await this.commands.execute({ principal, source: 'http', operation: 'source.package.admit', commandId: input.identity.operationId,
      targetKey: `source-operation:${input.identity.operationId}`, payload: input,
      authorize: async sql => { await this.owners.authorizePreparation(sql, input.root, input.attempt, input.identity); this.binding(input.root) },
      perform: async sql => {
        const reservation = (await sql.query<{ state: string; reserved_bytes: string }>('select state,reserved_bytes from source_storage_reservations where owner_kind=$1 and owner_id=$2 for share', ['materialization', input.identity.operationId])).rows[0]
        if (!reservation || reservation.state === 'reclaimed' || Number(reservation.reserved_bytes) < input.byteSize)
          throw new DomainError('SOURCE_RESERVATION_MISSING', 'The actual source preparation must reserve staging and retained copies before transfer.', 409)
        const context = transferContextForBinding(this.binding(input.root))
        const intent = TransferIntentSchema.parse({ ...context, version: 1, transferId: randomUUID(), operationId: input.identity.operationId,
          executionId: input.attempt.executionId, attemptId: input.attempt.attemptId, placementHash: input.attempt.placementHash,
          rootId: input.root.binding.rootId, rootBindingRevision: input.root.binding.bindingRevision, direction: 'to-worker', byteClass: 'source',
          sha256: input.sha256, byteSize: input.byteSize, manifestDigest: input.root.source.manifestDigest,
          expiresAt: new Date(Math.min(Date.parse(input.identity.expiresAt), Date.now() + 60 * 60 * 1000)).toISOString(), chunkBytes: 1024 * 1024 })
        return { ...input, intent }
      } })).value.intent
  }
  sender(source: ImmutableTransferSource, root: SourceRootRecord) {
    this.binding(root)
    return createEndpointTransferClient(this.endpoint(), root.binding.deviceId!).sender(source)
  }
  private async allocation(id: string): Promise<Allocation> {
    const row = (await this.pool.query<{ result: unknown }>(`select result from management_command_receipts where operation='source.package.admit' and result->'intent'->>'transferId'=$1`, [id])).rows
    if (row.length !== 1) throw new DomainError('SOURCE_TRANSFER_UNKNOWN', 'The source transfer was not admitted by the original Main owner.', 409)
    const value = row[0]!.result as Allocation
    return { ...value, root: SourceRootRecordSchema.parse(value.root), identity: SourcePreparationIdentitySchema.parse(value.identity), intent: TransferIntentSchema.parse(value.intent) }
  }
  async intent(id: string, binding: Readonly<DeviceSessionBinding>): Promise<TransferIntent> {
    const allocation = await this.allocation(id)
    await this.authorize(allocation.intent, transferContextForBinding(binding), 'start'); return allocation.intent
  }
  async authorize(intent: TransferIntent, raw: TransferContext, operation: TransferOperation): Promise<void> {
    void operation
    const context = TransferContextSchema.parse(raw), allocation = await this.allocation(intent.transferId)
    if (!isDeepStrictEqual(allocation.intent, intent)) throw new DomainError('SOURCE_TRANSFER_CONFLICT', 'Source transfer identity changed under the original request.', 409)
    await this.revalidate(allocation.root, allocation.attempt, allocation.identity)
    const current = transferContextForBinding(this.binding(allocation.root))
    if (!isDeepStrictEqual(current, context)) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source transfer must use the actual current authenticated epoch/boot.', 409)
  }
}
