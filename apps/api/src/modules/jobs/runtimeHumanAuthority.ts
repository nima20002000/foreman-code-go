import type { ManagementPrincipal } from '@graphql/contracts/management'
import { JobRuntimeApprovalSchema,type JobRuntimeApproval } from '@graphql/contracts/job-runtime'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'
import { canonical, type JobSql } from './repository.js'
import type { JobRuntimeHumanAuthority } from './runtimeProfilePorts.js'
/** Approval is created only by the verified browser route. Reuse its immutable
 * command receipt under the current transaction; transport labels are not proof. */
export class PostgresJobRuntimeHumanAuthority implements JobRuntimeHumanAuthority {
  async require(sql:JobSql,principal:ManagementPrincipal,approval:JobRuntimeApproval) {
    if(principal.id!==approval.approvedByPrincipalId||!approval.approvedAt)throw new DomainError('JOB_RUNTIME_HUMAN_APPROVAL_REQUIRED','The original human approval is missing.',403)
    const live=await readLiveManagementPrincipal(sql,principal.id)
    requireAuthorization(live,'job_definitions:write',{workspaceId:approval.workspaceId})
    const rows=await sql.query<{result:unknown}>(`select result from management_command_receipts
      where principal_id=$1 and operation='job.runtime-profile.approve' and target_key=$2
      and result->>'id'=$3 for share`,[principal.id,approval.workspaceId,approval.id])
    const original=rows.rows.map(row=>JobRuntimeApprovalSchema.parse(row.result)).find(value=>canonical(value)===canonical({...approval,status:'approved'}))
    if(!original)throw new DomainError('JOB_RUNTIME_HUMAN_APPROVAL_REQUIRED','The original exact browser approval receipt is missing.',403)
  }
}
