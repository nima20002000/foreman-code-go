import type pg from 'pg'
import { CI_RUNTIME_NAMESPACE, CiRuntimeWorkerStateSchema, type CiInstalledStorage } from '@foreman-code/contracts'
import { DeviceProvisioningTargetSchema, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { PostgresSourceService } from '../sources/service.js'
import { assertBuildComputerTarget, buildComputerKey } from '../settings/buildComputers.js'
import type { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { DomainError } from '../errors.js'
import type { CiRuntimeWorker } from './ciRuntimeWorker.js'
import { canonical, jobDigest } from './digest.js'
import type { JobSql } from './repository.js'

export interface CiEnrollmentTarget {
  target: DeviceProvisioningTarget
  buildEnabled: boolean
  connected: boolean
}
export interface CiEnrollmentInventory {
  computers(): Promise<CiEnrollmentTarget[]>
  storage(target: DeviceProvisioningTarget): Promise<CiInstalledStorage | null>
  root(principal: ManagementPrincipal, workspaceId: string, template: SourceRootRecord,
    target: DeviceProvisioningTarget): Promise<SourceRootRecord>
}

export class ProductionCiEnrollmentInventory implements CiEnrollmentInventory {
  constructor(private readonly pool: pg.Pool, private readonly sources: PostgresSourceService,
    private readonly endpoint: () => DeviceEndpoint, private readonly main: () => CiRuntimeWorker | undefined,
    private readonly workerExecution: WorkerExecutionPolicy) {}

  async computers(): Promise<CiEnrollmentTarget[]> {
    const rows = await this.pool.query<{ target: unknown; build_enabled: boolean }>(
      'select target,build_enabled from build_computer_preferences order by host_key')
    return rows.rows.map(row => {
      const target = DeviceProvisioningTargetSchema.parse(row.target)
      const binding = target.hostRef.kind === 'device' ? this.endpoint().currentBinding(target.hostRef.deviceId) : null
      const connected = target.hostRef.kind === 'main' || !!binding
        && binding.workerInstallationId === target.applicationInstallationId
        && binding.keyRevision === target.keyRevision && binding.authorizationRevision === target.authorizationRevision
      return { target, buildEnabled: row.build_enabled, connected }
    })
  }

  async storage(target: DeviceProvisioningTarget): Promise<CiInstalledStorage | null> {
    await assertBuildComputerTarget(this.pool, target)
    this.workerExecution.requireEnabled(target.hostRef)
    if (target.hostRef.kind === 'main') {
      const state = await this.main()?.handle({ operation: 'status' })
      return state?.installedStorage ?? null
    }
    const channel = this.endpoint().captureRequest(target.hostRef.deviceId, CI_RUNTIME_NAMESPACE)
    if (!channel) return null
    const current = () => this.endpoint().currentBinding(target.hostRef.kind === 'device' ? target.hostRef.deviceId : '')
    const matches = () => channel.binding.workerInstallationId === target.applicationInstallationId
      && channel.binding.keyRevision === target.keyRevision && channel.binding.authorizationRevision === target.authorizationRevision
      && canonical(channel.binding) === canonical(current())
    if (!matches()) throw new DomainError('CI_ENROLLMENT_OFFLINE', 'The computer connection changed.', 409)
    const result = await channel.request({ operation: 'status' }, { timeoutMs: 30_000 })
    if (!matches()) throw new DomainError('CI_ENROLLMENT_OFFLINE', 'The computer connection changed.', 409)
    return CiRuntimeWorkerStateSchema.parse(result.payload).installedStorage ?? null
  }

  async root(principal: ManagementPrincipal, workspaceId: string, template: SourceRootRecord,
    target: DeviceProvisioningTarget): Promise<SourceRootRecord> {
    const roots = (await this.sources.rootList(principal, 'mcp', { workspaceId, limit: 100 })).items
    const matching = roots.find(root => canonical(root.selection.hostRef) === canonical(target.hostRef)
      && canonical(root.source) === canonical(template.source))
    if (matching) return matching
    const current = roots.find(root => canonical(root.selection.hostRef) === canonical(target.hostRef))
    const rows = await this.pool.query<{ record: unknown }>(`select p.record from workspace_root_policy_heads h
      join workspace_root_policies p on p.root_policy_id=h.root_policy_id and p.root_policy_revision=h.root_policy_revision
      where h.workspace_id=$1 and p.revoked_at is null`, [workspaceId])
    const policy = rows.rows.map(row => WorkspaceRootPolicySchema.parse(row.record))
      .find(value => canonical(value.hostRef) === canonical(target.hostRef) && value.accessMode === 'read-write')
    if (!policy) throw new DomainError('CI_ENROLLMENT_ROOT_REQUIRED',
      'This computer needs an approved writable workspace root before CI can enroll it.', 409)
    const selection = { hostRef: policy.hostRef, rootPolicyId: policy.rootPolicyId,
      rootPolicyRevision: policy.rootPolicyRevision, locationRevision: policy.locationRevision }
    const commandId = `enroll-root-${jobDigest({ workspaceId, selection, source: template.source,
      previous: current?.binding.bindingRevision ?? 0 })}`
    return (await this.sources.bindRoot(principal, 'mcp', { workspaceId, commandId, selection,
      source: template.source, accessMode: 'exclusive-write',
      expectedBindingRevision: current?.binding.bindingRevision ?? 0 })).value
  }
}

export async function lockCiEnrollment(sql: JobSql, workspaceId: string,
  target: DeviceProvisioningTarget): Promise<void> {
  await sql.query('select pg_advisory_xact_lock(hashtext($1))',
    [`ci-enrollment:${workspaceId}:${buildComputerKey(target)}`])
}

export async function ciEnrollmentDisabled(sql: JobSql, workspaceId: string,
  target: DeviceProvisioningTarget, options: { lock?: boolean } = {}): Promise<boolean> {
  if (options.lock) await lockCiEnrollment(sql, workspaceId, target)
  const row = (await sql.query<{ enabled: boolean }>(
    'select enabled from ci_enrollment_computers where workspace_id=$1 and host_key=$2',
    [workspaceId, buildComputerKey(target)])).rows[0]
  return row?.enabled === false
}
