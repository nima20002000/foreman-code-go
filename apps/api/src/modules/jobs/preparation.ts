import { JobAuthoringChoicesSchema, PreparedJobSpecSchema, type JobAuthoringChoices, type JobDefinitionSpec, type JobExecution, type PreparedJobSpec } from '@graphql/contracts/jobs'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { DomainError } from '../errors.js'
import { canonical, type JobSql } from './repository.js'
import type { JobPreparationPort } from './ports.js'
export interface JobPreparationSources {
  /** Actual W12 computer/root, W09 scoped snapshot and CI-A qualified profile readbacks. No probes/install side effects. */
  adoptFinalBinding(sql:JobSql,principal:ManagementPrincipal,execution:JobExecution):Promise<void>
  choices(sql:JobSql,principal:ManagementPrincipal,workspaceId:string):Promise<JobAuthoringChoices>
  /** Real W09 verified private repository materialization, bound to this genuine job/attempt. */
  materialize(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,spec:JobDefinitionSpec,identity:{executionId:string;attemptId:string;operationId:string}):Promise<PreparedJobSpec>
}
/** Source/target/profile authority is drawn from current inventory, never trusted caller attestations. */
export class JobPreparationService implements JobPreparationPort {
  constructor(private readonly sources:JobPreparationSources) {}
  async adoptFinalBinding(sql:JobSql,principal:ManagementPrincipal,execution:JobExecution) {
    await this.sources.adoptFinalBinding(sql,principal,execution)
  }
  async choices(sql:JobSql,principal:ManagementPrincipal,workspaceId:string) {
    return JobAuthoringChoicesSchema.parse(await this.sources.choices(sql,principal,workspaceId))
  }
  async validate(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,spec:JobDefinitionSpec) {
    const choices=await this.choices(sql,principal,workspaceId),reasons:string[]=[]
    const target=choices.targets.find(choice=>canonical(choice.target)===canonical(spec.target))
    if(!target)reasons.push('TARGET_AUTHORITY_CHANGED')
    else if(!target.ready)reasons.push(...target.reasons)
    if(!choices.sources.some(source=>canonical(source)===canonical(spec.source)))reasons.push('SOURCE_REVISION_UNAVAILABLE')
    if(!choices.policies.some(policy=>canonical(policy)===canonical(spec.policy)))reasons.push('ISOLATION_POLICY_UNAVAILABLE')
    return {valid:reasons.length===0,reasons,sideEffects:false as const}
  }
  async accept(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,spec:JobDefinitionSpec,identity:{executionId:string;attemptId:string;operationId:string}) {
    const ready=await this.validate(sql,principal,workspaceId,spec)
    if(!ready.valid)throw new DomainError('JOB_NOT_READY','Current source, target or isolation authority does not match the saved job.',409,{reasons:ready.reasons})
    return PreparedJobSpecSchema.parse(await this.sources.materialize(sql,principal,workspaceId,spec,identity))
  }
}
