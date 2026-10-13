import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { buildComputerKey } from '../settings/buildComputers.js'
import type { JobSql } from './repository.js'

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
