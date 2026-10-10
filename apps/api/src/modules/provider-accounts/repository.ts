import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import {
  ProviderAccountsSnapshotSchema, type ProviderAccountsSnapshot,
} from '@foreman-code/contracts/provider-accounts'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'

export class ProviderAccountsRepository {
  constructor(private readonly pool: pg.Pool, private readonly hostId: () => Promise<string>) {}

  async key(): Promise<string> {
    return `provider-accounts:${await this.hostId()}`
  }

  async read(sql: GraphSqlClient = this.pool): Promise<ProviderAccountsSnapshot> {
    const result = await sql.query<{ record: unknown; revision: string }>(
      'select record, revision from application_settings where key=$1', [await this.key()],
    )
    const row = result.rows[0]
    if (!row) return { revision: 0, accounts: [] }
    return ProviderAccountsSnapshotSchema.parse({ ...(row.record as object), revision: Number(row.revision) })
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
