import { createHash } from 'node:crypto'
import { z } from 'zod'
import { JobInputRevisionSchema, type JobExecution } from '@foreman-code/contracts/jobs'
import { JobInputEntrySchema, JobInputManifestSchema, type JobInputEntry, type JobInputManifest } from '@foreman-code/contracts/job-inputs'
import { jobInputSnapshotDigest, jobBuildInputManifestBytes } from '@foreman-code/contracts/job-inputs-node'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { DomainError } from '../../errors.js'
export const inputHash=(value:unknown)=>commandInputHash(value).slice(7)
export function recipient(execution:JobExecution) { return {workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,
  owner:execution.owner,bindingHash:execution.acceptedSpec.bindingHash,specDigest:execution.acceptedSpec.specDigest,materializationId:execution.acceptedSpec.source.materializationId,materializationDigest:execution.acceptedSpec.source.materializationDigest} }
export const snapshotDigest=jobInputSnapshotDigest
export const manifestBytes=jobBuildInputManifestBytes
export function makeManifest(execution:JobExecution,entries:JobInputEntry[]):JobInputManifest {
  const totalBytes=entries.reduce((sum,entry)=>sum+entry.pin.byteSize,0)
  if(totalBytes>128*1024*1024)throw new DomainError('JOB_INPUT_TOO_LARGE','Immutable input bytes exceed the supported delivery budget.',413)
  const content={version:1 as const,bindingId:inputHash([recipient(execution),snapshotDigest(execution)]),recipient:recipient(execution),inputSnapshotDigest:snapshotDigest(execution),
    workflowInput:execution.acceptedSpec.workflowInput,entries,totalBytes}
  const bytes=manifestBytes({...content,manifestSha256:'0'.repeat(64),manifestByteSize:0})
  return JobInputManifestSchema.parse({...content,manifestSha256:createHash('sha256').update(bytes).digest('hex'),manifestByteSize:bytes.length})
}
/** Workflow vectors remain exact accepted JSON. File pins must use the supported vector; unknown shapes fail closed. */
export function workflowPins(execution:JobExecution) {
  const raw=execution.acceptedSpec.workflowInput?.files
  if(raw===undefined)return []
  return z.array(JobInputRevisionSchema.omit({path:true})).max(128).parse(raw)
}
export function artifactPins(result:unknown) {
  const output=z.object({output:z.unknown()}).passthrough().parse(result).output
  const candidate=z.object({latestDeliverable:z.object({artifacts:z.array(JobInputRevisionSchema).max(128)}).passthrough()}).passthrough()
  const direct=candidate.safeParse(output)
  if(direct.success)return direct.data.latestDeliverable.artifacts
  const wrapped=z.object({data:candidate}).passthrough().safeParse(output)
  return wrapped.success?wrapped.data.data.latestDeliverable.artifacts:[]
}
export function ensureDistinct(entries:JobInputEntry[]) {
  for(const entry of entries)JobInputEntrySchema.parse(entry)
  if(new Set(entries.map(entry=>entry.relativePath)).size!==entries.length)throw new DomainError('JOB_INPUT_PATH_CONFLICT','Accepted immutable input paths collide.',409)
}
