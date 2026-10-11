import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import {
  ProviderAccountsSnapshotSchema, ProviderAccountBindingSchema, type ProviderAccountsSnapshot,
} from '@foreman-code/contracts/provider-accounts'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { DeviceProvisioningTargetSchema, sameDeviceProvisioningTarget,
  type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'

export class ProviderAccountsRepository {
  private targetReader?: () => Promise<DeviceProvisioningTarget>
  constructor(private readonly pool: pg.Pool, private readonly hostId: () => Promise<string>) {}

  bindTarget(reader: () => Promise<DeviceProvisioningTarget>): void { this.targetReader = reader }

  async target(): Promise<DeviceProvisioningTarget> {
    if (this.targetReader) return DeviceProvisioningTargetSchema.parse(await this.targetReader())
    const id = await this.hostId()
    return DeviceProvisioningTargetSchema.parse({ hostRef: { kind: 'main', mainId: id },
      applicationInstallationId: id, keyRevision: null, authorizationRevision: null })
  }

  async key(): Promise<string> {
    return `provider-accounts:${await this.hostId()}`
  }

  async read(sql: GraphSqlClient = this.pool): Promise<ProviderAccountsSnapshot> {
    const result = await sql.query<{ record: unknown; revision: string }>(
      'select record, revision from application_settings where key=$1', [await this.key()],
    )
    const row = result.rows[0]
    const snapshot = row
      ? ProviderAccountsSnapshotSchema.parse({ ...(row.record as object), revision: Number(row.revision) })
      : { revision: 0, accounts: [] } as ProviderAccountsSnapshot
    const target = await this.target()
    const foreignAccount = snapshot.accounts.some(account => account.binding
      && !sameDeviceProvisioningTarget(account.binding.target, target))
    const foreignDefault = snapshot.defaults?.some(value => !sameDeviceProvisioningTarget(value.target, target))
    if (foreignAccount || foreignDefault) throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT',
      'These native account records belong to another application installation. Their history is retained.', 409)
    for (const account of snapshot.accounts) {
      if (!account.binding) account.legacyProfile = true
      account.binding ??= ProviderAccountBindingSchema.parse({ kind: 'slot', accountId: account.id,
        provider: account.provider, target, profileRef: account.id, bindingRevision: 1, subject: null })
      account.removedAt ??= null
    }
    snapshot.defaults ??= (['codex', 'claude'] as const).map(provider => ({ target, provider,
      accountId: snapshot.accounts.find(account => account.provider === provider && account.isDefault)?.id ?? null,
      revision: 0 }))
    return snapshot
  }

  async lock(sql: GraphSqlClient): Promise<ProviderAccountsSnapshot> {
    const key = await this.key()
    await sql.query('select pg_advisory_xact_lock(hashtext($1))', [key])
    return this.read(sql)
  }

  async write(sql: GraphSqlClient, snapshot: ProviderAccountsSnapshot, expectedRevision: number) {
    const current = await this.read(sql)
    if (current.revision !== expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', 'Provider accounts changed. Refresh before saving.', 409)
    }
    const next = ProviderAccountsSnapshotSchema.parse({ ...snapshot, revision: expectedRevision + 1 })
    const versionId = randomUUID()
    await sql.query(
      'insert into application_setting_versions (id,setting_key,version,record) values ($1,$2,$3,$4::jsonb)',
      [versionId, await this.key(), next.revision, JSON.stringify(next)],
    )
    await sql.query(
      `insert into application_settings (key, record, revision, current_version_id, updated_at)
       values ($1,$2::jsonb,$3,$4,now()) on conflict (key) do update
       set record=excluded.record, revision=excluded.revision, current_version_id=excluded.current_version_id,
       updated_at=excluded.updated_at`,
      [await this.key(), JSON.stringify(next), next.revision, versionId],
    )
    return next
  }
}
