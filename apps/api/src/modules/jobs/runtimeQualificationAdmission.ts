import { randomUUID } from 'node:crypto'
import { JobRuntimeApprovalSchema, JobRuntimeProfileSchema, JobRuntimeNativeAdmissionSchema, type JobRuntimeNativeAdmission,
  type JobRuntimeFingerprint, type JobRuntimeProfile } from '@graphql/contracts/job-runtime'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { canonical, type JobSql } from './repository.js'
import { PostgresJobRuntimeHumanAuthority } from './runtimeHumanAuthority.js'
import { jobQualificationFingerprint, type JobQualificationCandidate } from './qualification.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'

export interface JobRuntimeNativeAdmissionInput {
  candidate: JobQualificationCandidate
  runCommandId: string
  runPrincipalId: string
  resolveRoot(sql: JobSql, profile: JobRuntimeProfile, principal: Awaited<ReturnType<typeof readLiveManagementPrincipal>>): Promise<JobRuntimeProfile['root']>
  /** Trusted installed host capture and live carrier binding; no public observations. */
  readCurrent(sql: JobSql, profile: JobRuntimeProfile): Promise<{ fingerprint: JobRuntimeFingerprint; connection: DeviceSessionBinding | null }>
}
function changed(): never { throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'The original human-approved qualification authority changed.', 409) }
/** Called inside the existing Main transaction, committed before native entry.
 * Its original approval row is the sole admission store. Retry reads the same
 * immutable lease and never mints replacement native authority. */
export async function admitInstalledJobQualification(sql: JobSql, input: JobRuntimeNativeAdmissionInput, existingOnly=false): Promise<JobRuntimeNativeAdmission> {
  const candidate = input.candidate
  await lockActiveWorkspace(sql,candidate.fingerprint.root.binding.workspaceId)
  const row = (await sql.query<{ record: unknown; run_command_id: string | null; run_principal_id: string | null;
    approved_by: string | null; native_admission: unknown }>(`select record,run_command_id,run_principal_id,approved_by,native_admission
      from job_runtime_qualification_approvals where id=$1 for update`, [candidate.approvalId])).rows[0]
  if (!row) changed()
  const approval = JobRuntimeApprovalSchema.parse(row.record)
  if (approval.id!==candidate.approvalId||approval.workspaceId!==candidate.fingerprint.root.binding.workspaceId||approval.status !== 'qualifying' || row.run_command_id !== input.runCommandId || row.run_principal_id !== input.runPrincipalId || !approval.approvedByPrincipalId ||
    row.approved_by !== approval.approvedByPrincipalId || !approval.approvedAt || Date.parse(approval.expiresAt) <= Date.now() ||
    candidate.operationId !== approval.qualificationId || candidate.qualificationId !== approval.qualificationId ||
    jobQualificationFingerprint(candidate) !== approval.fingerprintDigest || canonical(candidate.fingerprint) !== canonical(approval.fingerprint)) changed()
  const runner=await readLiveManagementPrincipal(sql, input.runPrincipalId)
  requireAuthorization(runner, 'job_definitions:write', { workspaceId: approval.workspaceId })
  await new PostgresJobRuntimeHumanAuthority().require(sql, await readLiveManagementPrincipal(sql, approval.approvedByPrincipalId), approval)
  const profileRow = (await sql.query<{ record: unknown }>(`select v.record from job_runtime_profile_versions v
    join job_runtime_profiles p on p.id=v.profile_id where p.workspace_id=$1 and v.profile_id=$2 and v.revision=$3
    and p.revision=$3 and p.record->>'status'='qualifying' for share of p,v`, [approval.workspaceId, approval.profileId, approval.profileRevision])).rows[0]
  if (!profileRow) changed()
  const profile = JobRuntimeProfileSchema.parse(profileRow.record)
  if (profile.id !== approval.profileId || profile.revision !== approval.profileRevision || profile.workspaceId !== approval.workspaceId ||
    profile.specDigest !== approval.fingerprint.specDigest || canonical(profile.root) !== canonical(approval.fingerprint.root)) changed()
  if(canonical(await input.resolveRoot(sql,profile,runner))!==canonical(profile.root))changed()
  const root=profile.root
  const currentRoot=(await sql.query(`select 1 from source_root_catalog c join workspace_root_policies p on p.workspace_id=c.workspace_id
    where c.root_id=$1 and c.workspace_id=$2 and c.current_binding_revision=$3
    and p.root_policy_id=$4 and p.root_policy_revision=$5 and p.revoked_at is null for share of c,p`,
    [root.binding.rootId,approval.workspaceId,root.binding.bindingRevision,root.selection.rootPolicyId,root.selection.rootPolicyRevision])).rows[0]
  if(!currentRoot||root.binding.accessMode!=='exclusive-write')changed()
  const current = await input.readCurrent(sql, profile)
  if (canonical(current.fingerprint) !== canonical(approval.fingerprint)) changed()
  const fingerprint = current.fingerprint
  const registration = await assertDeviceHostInstallation(sql, fingerprint.hostRef,
    fingerprint.hostRef.kind === 'main' ? fingerprint.mainInstallationId : fingerprint.registration!.workerInstallationId)
  const registrationPin = registration ? { workerInstallationId: registration.workerInstallationId, keyRevision: registration.keyRevision,
    authorizationRevision: registration.authorizationRevision } : null
  if (canonical(registrationPin) !== canonical(fingerprint.registration)) changed()
  const context = { schemaVersion: 1 as const, kind: 'job-runtime-qualification' as const, approvalId: approval.id,
    qualificationId: approval.qualificationId, operationId: approval.qualificationId, workspaceId: approval.workspaceId,
    profileId: approval.profileId, profileRevision: approval.profileRevision, fingerprintDigest: approval.fingerprintDigest,
    runCommandId: input.runCommandId, runPrincipalId: input.runPrincipalId, approvedByPrincipalId: approval.approvedByPrincipalId,
    hostRef: fingerprint.hostRef, registration: fingerprint.registration, mainInstallationId: fingerprint.mainInstallationId,
    bootId: fingerprint.bootId, connection: current.connection, expiresAt: approval.expiresAt }
  if (row.native_admission) {
    const saved = JobRuntimeNativeAdmissionSchema.parse(row.native_admission)
    if (canonical(saved) !== canonical({ ...context, leaseId: saved.leaseId, admittedAt: saved.admittedAt })) changed()
    return saved
  }
  if(existingOnly)changed()
  const admission = JobRuntimeNativeAdmissionSchema.parse({ ...context, leaseId: randomUUID(), admittedAt: new Date().toISOString() })
  await sql.query('update job_runtime_qualification_approvals set native_admission=$2::jsonb where id=$1', [approval.id, JSON.stringify(admission)])
  return admission
}

/** Recheck the original persisted lease without ever creating one. */
export async function assertInstalledJobQualification(sql:JobSql,input:JobRuntimeNativeAdmissionInput,admission:JobRuntimeNativeAdmission):Promise<void> {
  const saved=await admitInstalledJobQualification(sql,input,true)
  if(canonical(saved)!==canonical(admission))changed()
}
