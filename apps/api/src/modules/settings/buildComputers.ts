import type pg from 'pg'
import {
  BuildComputerPreferenceSchema, BuildComputerReadSchema, BuildComputerUpdateSchema,
  type BuildComputerPreference, type BuildComputerStatus,
} from '@foreman-code/contracts/build-computers'
import { sameDeviceProvisioningTarget, DeviceProvisioningTargetSchema, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal, ManagementAction } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DomainError } from '../errors.js'
import type { JobSql } from '../jobs/repository.js'

export function buildComputerKey(target: Pick<DeviceProvisioningTarget, 'hostRef'>): string {
  const host = target.hostRef
  return `${host.mainId}:${host.kind === 'device' ? host.deviceId : 'main'}`
}
export function buildComputerTarget(target: Pick<import('@foreman-code/contracts/jobs').ResolvedJobDefinitionSpec['target'],
  'hostRef' | 'registration' | 'mainInstallationId'>): DeviceProvisioningTarget {
  return {
    hostRef: target.hostRef,
    applicationInstallationId: target.registration?.workerInstallationId ?? target.mainInstallationId,
    keyRevision: target.registration?.keyRevision ?? null,
    authorizationRevision: target.registration?.authorizationRevision ?? null,
  }
}
export async function assertBuildComputerTarget(sql: JobSql, target: DeviceProvisioningTarget): Promise<void> {
  const registration = await assertDeviceHostInstallation(sql, target.hostRef, target.applicationInstallationId)
  if ((registration?.keyRevision ?? null) !== target.keyRevision
    || (registration?.authorizationRevision ?? null) !== target.authorizationRevision) {
    throw new DomainError('BUILD_COMPUTER_IDENTITY_CHANGED', 'Refresh this computer’s registration before editing builds.', 409)
  }
}

export class BuildComputerSettings {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly readiness: (sql: JobSql, target: DeviceProvisioningTarget) => Promise<
      Pick<BuildComputerStatus, 'state' | 'reasons' | 'remoteExecutionEnabled'>>,
    private readonly changed?: () => void) {}

  async preference(sql: JobSql, target: DeviceProvisioningTarget): Promise<BuildComputerPreference> {
    const row = (await sql.query<{ target: DeviceProvisioningTarget; revision: string; build_enabled: boolean; build_priority: number }>(
      'select target,revision::text,build_enabled,build_priority from build_computer_preferences where host_key=$1 for share',
      [buildComputerKey(target)])).rows[0]
    const matches = row && sameDeviceProvisioningTarget(DeviceProvisioningTargetSchema.parse(row.target), target)
    return BuildComputerPreferenceSchema.parse({ target, revision: Number(row?.revision ?? 0),
      buildEnabled: matches ? row.build_enabled : false, buildPriority: matches ? row.build_priority : 50 })
  }
  async requireEnabled(sql: JobSql, target: DeviceProvisioningTarget): Promise<BuildComputerPreference> {
    await assertBuildComputerTarget(sql, target)
    const preference = await this.preference(sql, target)
    if (!preference.buildEnabled) {
      throw new DomainError('BUILD_COMPUTER_DISABLED', 'Enable builds for this computer in Settings → Computers.', 409)
    }
    return preference
  }
  private async authorize(sql: JobSql, principal: ManagementPrincipal, action: ManagementAction) {
    requireAuthorization(principal, action)
    requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), action)
  }
  private async status(sql: JobSql, target: DeviceProvisioningTarget): Promise<BuildComputerStatus> {
    const preference = await this.preference(sql, target)
    const readiness = await this.readiness(sql, target)
    return { preference, ...readiness,
      state: preference.buildEnabled ? readiness.state : 'disabled',
      reasons: preference.buildEnabled ? readiness.reasons : ['Enable builds to participate.'] }
  }
  async read(principal: ManagementPrincipal, raw: unknown, source: 'http' | 'mcp' = 'http'): Promise<BuildComputerStatus> {
    const { target } = BuildComputerReadSchema.parse(raw)
    try { requireAuthorization(principal, 'settings:read') } catch (error) {
      await this.commands.recordDenied(principal.id, source, 'build.computer.read', buildComputerKey(target))
      throw error
    }
    const sql = await this.pool.connect()
    try {
      await sql.query('begin')
      await this.authorize(sql, principal, 'settings:read')
      await assertBuildComputerTarget(sql, target)
      const result = await this.status(sql, target)
      await this.authorize(sql, principal, 'settings:read')
      await sql.query('commit')
      return result
    } catch (error) {
      await sql.query('rollback')
      throw error
    } finally { sql.release() }
  }
  async update(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown): Promise<BuildComputerStatus> {
    const input = BuildComputerUpdateSchema.parse(raw)
    try { requireAuthorization(principal, 'settings:update') } catch (error) {
      await this.commands.recordDenied(principal.id, source, 'build.computer.update', buildComputerKey(input.target))
      throw error
    }
    const result = await this.commands.execute({ principal, source, commandId: input.commandId,
      operation: 'build.computer.update', targetKey: buildComputerKey(input.target), payload: input,
      authorize: async sql => {
        await this.authorize(sql, principal, 'settings:update')
        await assertBuildComputerTarget(sql, input.target)
      },
      perform: async sql => {
        await assertBuildComputerTarget(sql, input.target)
        await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`build-settings:${buildComputerKey(input.target)}`])
        const old = await this.preference(sql, input.target)
        if (old.revision !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'Build settings changed. Refresh before saving again.', 409)
        }
        await sql.query(`insert into build_computer_preferences
          (host_key,target,revision,build_enabled,build_priority,updated_by) values($1,$2::jsonb,$3,$4,$5,$6)
          on conflict(host_key) do update set target=excluded.target,revision=excluded.revision,
          build_enabled=excluded.build_enabled,build_priority=excluded.build_priority,updated_by=excluded.updated_by`,
        [buildComputerKey(input.target), JSON.stringify(input.target), old.revision + 1,
          input.buildEnabled, input.buildPriority, principal.id])
        return this.status(sql, input.target)
      } })
    this.changed?.()
    return result.value
  }
}
