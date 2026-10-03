import { join } from 'node:path'
import type pg from 'pg'
import type { SourceManifest } from '@graphql/contracts/source-materialization'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import type { InstalledSourceExecutionHosts } from '../sources/executionHosts.js'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { ApprovedSourceSchema, SourceRootRecordSchema, SourceMaterializationRecordSchema, type SourceRootRecord, type SourceMaterializationRecord } from '@graphql/contracts/source-admission'
import { JobTargetSchema, PreparedJobSpecSchema, type JobDefinitionSpec, type JobAuthoringChoices, type JobExecution } from '@graphql/contracts/jobs'
import type { PostgresSourceService } from '../sources/service.js'
import { sourceBindingHash, sourceMaterializationDigest } from '../sources/bindingHash.js'
import { sourceSha256 } from '../sources/manifest.js'
import { verifiedSourceWorkingTree } from '../sources/nativeStamp.js'
import { authorizeSource } from '../sources/authority.js'
import { DomainError } from '../errors.js'
import { DeviceAccessError } from '../devices/access.js'
import { canonical, JobRepository, type JobSql } from './repository.js'
import { JobPreparationService, type JobPreparationSources } from './preparation.js'

/** W07/CI qualification readback; no probing, installing or pulling during authoring. */
export interface JobRuntimeInventory {
  choices(sql:JobSql,principal:ManagementPrincipal,workspaceId:string):Promise<JobAuthoringChoices['policies']>
  revalidate(sql:JobSql,principal:ManagementPrincipal,root:SourceRootRecord,spec:JobDefinitionSpec):Promise<void>
}
export interface JobDefinitionInputAuthority {validateDeclaredJobInputs(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,inputs:JobDefinitionSpec['inputs']):Promise<void>}
/** Creates/replays the approved detached repository on the actual selected host. */
export interface JobPrivateRepositoryPort {
  prepare(principal:ManagementPrincipal,record:SourceMaterializationRecord):Promise<void>
}
export class CanonicalJobPreparationSources implements JobPreparationSources {
  constructor(private readonly sources:PostgresSourceService,private readonly runtime:JobRuntimeInventory,
    private readonly repositories:JobPrivateRepositoryPort,private readonly inputs:JobDefinitionInputAuthority,private readonly roots:Pick<WorkspaceRootPolicyPort,'resolve'>) {}
  async choices(sql:JobSql,principal:ManagementPrincipal,workspaceId:string):Promise<JobAuthoringChoices> {
    await authorizeSource(sql,principal,'sources:read',workspaceId)
    await authorizeSource(sql,principal,'source_roots:read',workspaceId)
    const sources=(await sql.query<{record:unknown}>(`select record from source_snapshots where workspace_id=$1 and availability='retained' order by snapshot_id limit 100`,[workspaceId])).rows.map(row=>ApprovedSourceSchema.parse(row.record)).filter(source=>source.manifest.git!==undefined).map(source=>({approvedSourceId:source.manifest.approvedSourceId,snapshotId:source.manifest.snapshotId,manifestDigest:source.manifest.manifestDigest,commit:source.manifest.git!.commit}))
    const roots=(await sql.query<{record:unknown}>(`select b.record from source_root_catalog c join source_root_bindings b on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision where c.workspace_id=$1 order by c.root_id limit 100`,[workspaceId])).rows.map(row=>SourceRootRecordSchema.parse(row.record))
    const policies=await this.runtime.choices(sql,principal,workspaceId)
    const targets:JobAuthoringChoices['targets']=[]
    for(const root of roots.filter(root=>sources.some(source=>source.snapshotId===root.source.snapshotId&&source.manifestDigest===root.source.manifestDigest))) {
      try{const target=await this.target(sql,principal,root);targets.push({id:root.binding.rootId,label:root.selection.hostRef.kind==='main'?'Main computer':`Computer ${root.selection.hostRef.deviceId}`,target,ready:root.binding.accessMode==='exclusive-write',reasons:root.binding.accessMode==='exclusive-write'?[]:['SOURCE_READ_ONLY']})}
      catch (error) {
        // Retained roots on revoked devices remain history, but cannot be selected for another Job.
        if (root.selection.hostRef.kind === 'device' && error instanceof DeviceAccessError && error.code === 'revoked') {
          continue
        }
        if (!(error instanceof DomainError) || error.status >= 500 || error.status === 403) throw error
      }
    }
    return {sources,targets,policies}
  }
  private async target(sql:JobSql,principal:ManagementPrincipal,root:SourceRootRecord) {
    const policy=await this.roots.resolve(sql,principal,{workspaceId:root.binding.workspaceId,...root.selection})
    const main=(await sql.query<{id:string}>('select id from application_installation where singleton=true for share')).rows[0]
    if(!main||main.id!==root.binding.mainId||policy.hostRef.mainId!==main.id||canonical(policy.hostRef)!==canonical(root.selection.hostRef)||canonical(policy.registration)!==canonical(root.registration)||root.binding.canonicalPath!==join(policy.managedRuntimeRoot,'source-materializations',policy.rootPolicyId))throw new DomainError('JOB_ROOT_PIN_CONFLICT','The original root namespace, registration or actual main installation changed.',409)
    return JobTargetSchema.parse({schemaVersion:1,mainId:main.id,mainInstallationId:main.id,hostRef:root.selection.hostRef,registration:root.registration,
      destination:{canonicalProjectRoot:root.binding.canonicalPath,canonicalCwd:root.binding.canonicalPath,managedRuntimeRoot:policy.managedRuntimeRoot,
        directoryIdentityHash:sourceSha256(Buffer.from(JSON.stringify(root.binding.filesystem))),rootPolicyId:root.selection.rootPolicyId,rootPolicyRevision:root.selection.rootPolicyRevision,locationRevision:root.selection.locationRevision,attestationId:root.attestationId,attestationHash:root.attestationDigest}})
  }
  private async root(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,spec:JobDefinitionSpec) {
    const row=(await sql.query<{record:unknown}>(`select b.record from source_root_catalog c join source_root_bindings b on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision where c.workspace_id=$1 and b.record->>'attestationId'=$2 for share of b,c`,[workspaceId,spec.target.destination.attestationId])).rows
    if(row.length!==1)throw new DomainError('JOB_ROOT_PIN_CONFLICT','The exact current job root attestation is unavailable.',409)
    const root=SourceRootRecordSchema.parse(row[0]!.record)
    if(root.binding.accessMode!=='exclusive-write'||canonical(await this.target(sql,principal,root))!==canonical(spec.target))throw new DomainError('JOB_ROOT_PIN_CONFLICT','The saved target is not the current exclusive job source root.',409)
    if(canonical(root.source)!==canonical({approvedSourceId:spec.source.approvedSourceId,snapshotId:spec.source.snapshotId,manifestDigest:spec.source.manifestDigest}))throw new DomainError('JOB_SOURCE_PIN_CONFLICT','The target root is bound to a different exact approved snapshot.',409)
    const source=await this.sources.resolveApprovedSource(sql,principal,workspaceId,{approvedSourceId:spec.source.approvedSourceId,snapshotId:spec.source.snapshotId,manifestDigest:spec.source.manifestDigest})
    if(source.manifest.git?.commit!==spec.source.commit)throw new DomainError('JOB_SOURCE_PIN_CONFLICT','The saved commit differs from the approved snapshot.',409)
    await this.sources.resolveRootBinding(sql,principal,{workspaceId,rootId:root.binding.rootId,bindingRevision:root.binding.bindingRevision,source:root.source})
    await this.runtime.revalidate(sql,principal,root,spec)
    return root
  }
  async validateSelection(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,spec:JobDefinitionSpec) {await this.inputs.validateDeclaredJobInputs(sql,principal,workspaceId,spec.inputs);await this.root(sql,principal,workspaceId,spec)}
  async materialize(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,spec:JobDefinitionSpec,identity:{executionId:string;attemptId:string;operationId:string}) {
    await this.inputs.validateDeclaredJobInputs(sql,principal,workspaceId,spec.inputs)
    const root=await this.root(sql,principal,workspaceId,spec)
    const attempt={executionId:identity.executionId,attemptId:identity.attemptId,keyRevision:root.registration?.keyRevision??null,authorizationRevision:root.registration?.authorizationRevision??null}
    const record=await this.sources.prepareExecution({principal,workspaceId,rootId:root.binding.rootId,bindingRevision:root.binding.bindingRevision,source:root.source,operationId:identity.operationId,attempt:{...attempt,placementHash:sourceBindingHash(root,attempt,identity.operationId)}})
    await this.repositories.prepare(principal,record)
    const path=await this.sources.verifyPreparation({principal,record}),tree=verifiedSourceWorkingTree(record,path)
    return PreparedJobSpecSchema.parse({...spec,source:{...spec.source,materializationId:record.receipt.materializationId,materializationDigest:sourceMaterializationDigest(record)},
      target:{...spec.target,destination:{...spec.target.destination,canonicalProjectRoot:tree.canonicalProjectRoot,canonicalCwd:spec.relativeCwd?join(tree.canonicalProjectRoot,spec.relativeCwd):tree.canonicalCwd,directoryIdentityHash:tree.directoryIdentityHash}}})
  }
  async revalidateAccepted(sql:JobSql,principal:ManagementPrincipal,execution:JobExecution) {
    const row=(await sql.query<{record:unknown;state:string}>('select record,state from source_execution_materializations where materialization_id=$1 and workspace_id=$2 and execution_id=$3 and attempt_id=$4 for share',[execution.acceptedSpec.source.materializationId,execution.workspaceId,execution.id,execution.attemptId])).rows[0]
    if(!row)throw new DomainError('SOURCE_ATTEMPT_CONFLICT','The original accepted source materialization is missing.',409)
    const record=SourceMaterializationRecordSchema.parse(row.record)
    record.state=SourceMaterializationRecordSchema.shape.state.parse(row.state)
    if(!['prepared','running','closed'].includes(record.state)||record.operationId!==execution.operationId||record.finalDispatchBindingHash!==execution.acceptedSpec.bindingHash||sourceMaterializationDigest(record)!==execution.acceptedSpec.source.materializationDigest)throw new DomainError('SOURCE_ATTEMPT_CONFLICT','The original accepted source binding changed.',409)
    const source={approvedSourceId:execution.acceptedSpec.source.approvedSourceId,snapshotId:execution.acceptedSpec.source.snapshotId,manifestDigest:execution.acceptedSpec.source.manifestDigest}
    const root=await this.sources.resolveRootBinding(sql,principal,{workspaceId:execution.workspaceId,rootId:record.receipt.binding.rootId,bindingRevision:record.receipt.binding.bindingRevision,source})
    if(root.attestationId!==execution.acceptedSpec.target.destination.attestationId||root.attestationDigest!==execution.acceptedSpec.target.destination.attestationHash||canonical(root.registration)!==canonical(execution.acceptedSpec.target.registration))throw new DomainError('JOB_ROOT_PIN_CONFLICT','The original accepted root/registration differs from its stored materialization.',409)
    const definition=await new JobRepository().version(sql,execution.workspaceId,execution.acceptedSpec.definitionVersionId,execution.acceptedSpec.definitionId)
    await this.runtime.revalidate(sql,principal,root,definition.spec)
  }
  async adoptFinalBinding(sql:JobSql,principal:ManagementPrincipal,execution:JobExecution) {
    const row=(await sql.query<{record:unknown}>('select record from source_execution_materializations where materialization_id=$1 and execution_id=$2 and attempt_id=$3 for update',[execution.acceptedSpec.source.materializationId,execution.id,execution.attemptId])).rows[0]
    if(!row)throw new DomainError('SOURCE_ATTEMPT_CONFLICT','The actual prepared job source is missing.',409)
    const record=SourceMaterializationRecordSchema.parse(row.record)
    if(record.operationId!==execution.operationId||sourceMaterializationDigest(record)!==execution.acceptedSpec.source.materializationDigest)throw new DomainError('SOURCE_ATTEMPT_CONFLICT','The job source belongs to another original operation.',409)
    await this.sources.adoptFinalBinding(sql,principal,record,execution.acceptedSpec.bindingHash)
  }
}

/** Includes the source/root pairing check before Save as well as native preparation. */
export class CanonicalJobPreparationService extends JobPreparationService {
  constructor(private readonly canonicalSources:CanonicalJobPreparationSources) {super(canonicalSources)}
  override async validate(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,spec:JobDefinitionSpec) {
    const result=await super.validate(sql,principal,workspaceId,spec)
    if(result.valid)await this.canonicalSources.validateSelection(sql,principal,workspaceId,spec)
    return result
  }
}

/** Original-main implementation reuses the W09 detached repository writer. Remote
 * requests stay on its authenticated source host, carrying the original record. */
export class CanonicalJobPrivateRepositories implements JobPrivateRepositoryPort {
  constructor(private readonly pool:pg.Pool,private readonly sources:PostgresSourceService,
    private readonly hosts:InstalledSourceExecutionHosts,
    private readonly remote:{preparePrivateRepository(principal:ManagementPrincipal,record:SourceMaterializationRecord):Promise<void>}) {}
  async prepare(principal:ManagementPrincipal,record:SourceMaterializationRecord) {
    if(record.receipt.binding.deviceId!==null)return this.remote.preparePrivateRepository(principal,record)
    const sql=await this.pool.connect()
    let manifest:SourceManifest
    try {
      await sql.query('begin')
      const row=(await sql.query<{record:unknown}>('select record from source_root_bindings where root_id=$1 and binding_revision=$2 for share',[record.receipt.binding.rootId,record.receipt.binding.bindingRevision])).rows[0]
      const root=SourceRootRecordSchema.parse(row?.record)
      const source=await this.sources.resolveApprovedSource(sql,principal,record.receipt.binding.workspaceId,root.source)
      manifest=source.manifest;await sql.query('commit')
    } catch(error){await sql.query('rollback');throw error}finally{sql.release()}
    await this.sources.verifyPreparation({principal,record})
    await this.hosts.privateRepository(record,manifest)
  }
}
