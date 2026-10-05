import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { JobRuntimeApprovalRecord, JobRuntimeFingerprintRecord, JobRuntimeProfileRecord,
  JobRuntimeQualificationResultRecord } from '@foreman-code/contracts/job-verification-runtime'
import type { JobSql } from './repository.js'
/** CI-A's concrete installed-host producer. Candidate reads metadata; only approved run may probe. */
export interface JobRuntimeQualificationProducer {
  capture(profile:JobRuntimeProfileRecord):Promise<JobRuntimeFingerprintRecord>
  run(approval:JobRuntimeApprovalRecord,signal:AbortSignal):Promise<JobRuntimeQualificationResultRecord>
  /** Pure current HRT/W07/root metadata check. No CLI, filesystem probe, install or model invocation. */
  revalidate(sql:JobSql,profile:JobRuntimeProfileRecord):Promise<{ready:boolean;reasons:string[]}>
}
/** Existing human authority verifies the actual approver, not a public ready/approval flag. */
export interface JobRuntimeHumanAuthority {
  require(sql:JobSql,principal:ManagementPrincipal,approval:JobRuntimeApprovalRecord):Promise<void>
}

export type JobRuntimeQualificationResult = JobRuntimeQualificationResultRecord
