import type pg from 'pg'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import { HostHarnessOverrideSchema, type HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { DomainError } from '../../errors.js'

export const harnessHostKey = (host: CanonicalMachineReference): string => host.kind === 'main' ? `main:${host.mainId}` : `device:${host.mainId}:${host.deviceId}`
export class HarnessInstanceSettingsRepository {
  constructor(private readonly pool: pg.Pool) {}
  async list(host: CanonicalMachineReference, applicationInstallationId: string, client?: pg.ClientBase): Promise<HostHarnessOverride[]> {
    const result = await (client ?? this.pool).query<{ record: unknown }>(`select distinct on(instance_id) record from harness_instance_settings
      where host_key=$1 and application_installation_id=$2 order by instance_id,revision desc`, [harnessHostKey(host), applicationInstallationId])
    return result.rows.map(row => HostHarnessOverrideSchema.parse(row.record))
  }
  async readAuthorized<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    let releaseError: Error | undefined
    try {
      await client.query('begin')
      const result = await operation(client)
      await client.query('commit')
      return result
    } catch (error) {
      try { await client.query('rollback') } catch (rollbackError) { releaseError = rollbackError instanceof Error ? rollbackError : new Error('Settings read rollback failed.') }
      throw error
    } finally { client.release(releaseError) }
  }
  async latest(client: pg.ClientBase, instanceId: string): Promise<HostHarnessOverride | null> {
    const result = await client.query<{ record: unknown }>('select record from harness_instance_settings where instance_id=$1 order by revision desc limit 1', [instanceId])
    return result.rows[0] ? HostHarnessOverrideSchema.parse(result.rows[0].record) : null
  }
  async lockRevision(client: pg.ClientBase, instanceId: string): Promise<void> {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`harness-instance:${instanceId}`])
  }
  async append(client: pg.PoolClient, principalId: string, expectedRevision: number, value: HostHarnessOverride): Promise<HostHarnessOverride> {
    await this.lockRevision(client, value.instanceId)
    const previous = await this.latest(client, value.instanceId)
    if ((previous?.revision ?? 0) !== expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Host harness settings changed since they were read.', 409, { currentRevision: previous?.revision ?? 0 })
    if (previous && (harnessHostKey(previous.target.hostRef) !== harnessHostKey(value.target.hostRef)
      || previous.target.applicationInstallationId !== value.target.applicationInstallationId
      || previous.driverId !== value.driverId)) throw new DomainError('HARNESS_INSTANCE_TARGET_CONFLICT', 'A configured instance cannot move to another host, installation or driver.', 409)
    await client.query(`insert into harness_instance_settings(instance_id,revision,host_key,application_installation_id,record,configuration_fingerprint,created_by)
      values($1,$2,$3,$4,$5::jsonb,$6,$7)`, [value.instanceId, value.revision, harnessHostKey(value.target.hostRef), value.target.applicationInstallationId, JSON.stringify(value), value.configurationFingerprint, principalId])
    return value
  }
}
