import type pg from 'pg'
import { DeviceProvisioningTargetSchema, sameDeviceProvisioningTarget,
  type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { buildComputerKey } from '../settings/buildComputers.js'

export interface SyncWorkspace { id: string; name: string; active: boolean; targets: DeviceProvisioningTarget[] }
export interface SyncPreference { revision: number; enabled: boolean }
export class SyncRepository {
  constructor(private readonly pool: pg.Pool, readonly mainId: string) {}
  get mainTarget(): DeviceProvisioningTarget {
    return { hostRef: { kind: 'main', mainId: this.mainId }, applicationInstallationId: this.mainId,
      keyRevision: null, authorizationRevision: null }
  }
  async workspaces(): Promise<SyncWorkspace[]> {
    const workspaces = (await this.pool.query<{ id: string; name: string; active: boolean }>(
      `select id,record->>'name' as name,archived_at is null as active from workspaces order by id`)).rows
    const hosts = (await this.pool.query<{ workspace_id: string; host: unknown; installation_id: string; key_revision: string | null;
      authorization_revision: string | null }>(`
      select a.workspace_id, c.record#>'{harnessProfileSelection,target,hostRef}' as host,
        c.record#>>'{harnessProfileSelection,target,applicationInstallationId}' as installation_id,
        null::text as key_revision,null::text as authorization_revision
      from agents a join agent_configuration_versions c on c.id=a.current_configuration_version_id
      where a.archived_at is null
      union
      select r.workspace_id,p.record->'hostRef' as host,
        p.record#>>'{registration,workerInstallationId}' as installation_id,
        p.record#>>'{registration,keyRevision}' as key_revision,
        p.record#>>'{registration,authorizationRevision}' as authorization_revision
      from run_node_placements p join runs r on r.id=p.run_id
      where p.record#>>'{payload,kind}'='agent' and r.execution_state in ('queued','running','waiting','interrupted')
    `)).rows
    const computers = await this.computers()
    return workspaces.map(workspace => {
      const targets = new Map<string, DeviceProvisioningTarget>()
      if (workspace.active) targets.set('main', this.mainTarget)
      for (const row of hosts.filter(host => host.workspace_id === workspace.id)) {
        const host = row.host as DeviceProvisioningTarget['hostRef'] | null
        if (!workspace.active || !host || host.mainId !== this.mainId || host.kind !== 'device') continue
        const target = computers.find(value => value.hostRef.kind === 'device' && value.hostRef.deviceId === host.deviceId)
        if (!target || row.installation_id !== target.applicationInstallationId) continue
        if (row.key_revision !== null && Number(row.key_revision) !== target.keyRevision) continue
        if (row.authorization_revision !== null && Number(row.authorization_revision) !== target.authorizationRevision) continue
        targets.set(host.deviceId, target)
      }
      return { ...workspace, targets: [...targets.values()] }
    })
  }
  async computers(): Promise<DeviceProvisioningTarget[]> {
    const registrations = (await this.pool.query<{ record: unknown }>(
      `select record from device_registrations where main_id=$1 and record->>'status'='paired'`, [this.mainId]))
      .rows.map(row => DeviceRegistrationSchema.parse(row.record))
    return [this.mainTarget, ...registrations.map(registration => ({
      hostRef: { kind: 'device' as const, mainId: this.mainId, deviceId: registration.deviceId },
      applicationInstallationId: registration.workerInstallationId,
      keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision,
    }))]
  }
  async preference(sql: Pick<pg.Pool, 'query'>, workspaceId: string, target: DeviceProvisioningTarget): Promise<SyncPreference> {
    const row = (await sql.query<{ target: unknown; revision: string; enabled: boolean }>(
      `select target,revision::text,enabled from computer_sync_preferences where workspace_id=$1 and host_key=$2`,
      [workspaceId, buildComputerKey(target)])).rows[0]
    const matches = row && sameDeviceProvisioningTarget(DeviceProvisioningTargetSchema.parse(row.target), target)
    return { revision: Number(row?.revision ?? 0), enabled: matches ? row.enabled : true }
  }
  async save(sql: Pick<pg.Pool, 'query'>, workspaceId: string, target: DeviceProvisioningTarget,
    preference: SyncPreference, principalId: string) {
    await sql.query(`insert into computer_sync_preferences(workspace_id,host_key,target,revision,enabled,updated_by)
      values($1,$2,$3::jsonb,$4,$5,$6) on conflict(workspace_id,host_key) do update set
      target=excluded.target,revision=excluded.revision,enabled=excluded.enabled,updated_by=excluded.updated_by`,
    [workspaceId, buildComputerKey(target), JSON.stringify(target), preference.revision, preference.enabled, principalId])
  }
}
