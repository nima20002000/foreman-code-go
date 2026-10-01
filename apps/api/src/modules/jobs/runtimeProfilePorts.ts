import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { JobRuntimeApproval, JobRuntimeFingerprint, JobRuntimeMeasurement, JobRuntimeProfile } from '@graphql/contracts/job-runtime'
import type { JobSql } from './repository.js'
/** CI-A's concrete installed-host producer. Candidate reads metadata; only approved run may probe. */
export interface JobRuntimeQualificationProducer {
  capture(profile:JobRuntimeProfile):Promise<JobRuntimeFingerprint>
  run(approval:JobRuntimeApproval,signal:AbortSignal):Promise<JobRuntimeQualificationResult>
  /** Pure current HRT/W07/root metadata check. No CLI, filesystem probe, install or model invocation. */
  revalidate(sql:JobSql,profile:JobRuntimeProfile):Promise<{ready:boolean;reasons:string[]}>
}
/** Existing human authority verifies the actual approver, not a public ready/approval flag. */
export interface JobRuntimeHumanAuthority {
  require(sql:JobSql,principal:ManagementPrincipal,approval:JobRuntimeApproval):Promise<void>
}

export type JobRuntimeQualificationResult = {outcome:'qualified';measurement:JobRuntimeMeasurement} | {outcome:'denied';closure:'not_started'|'confirmed'|'unconfirmed';reasons:string[]}
