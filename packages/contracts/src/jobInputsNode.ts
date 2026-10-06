import { createHash } from 'node:crypto'
import type { JobExecutionRecord } from './jobVerification.js'
import { JobBuildInputManifestSchema, type JobInputManifest } from './jobInputs.js'
function canonical(value:unknown):string {if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;return JSON.stringify(value)}
export function jobInputSnapshotDigest(execution:Pick<JobExecutionRecord,'acceptedSpec'>):string {return createHash('sha256').update(canonical({inputs:execution.acceptedSpec.inputs,workflowInput:execution.acceptedSpec.workflowInput})).digest('hex')}
export function jobBuildInputManifestBytes(manifest:JobInputManifest):Buffer {
  const bytes = manifest.verificationContext ? Buffer.from(JSON.stringify(manifest.verificationContext)) : undefined
  return Buffer.from(JSON.stringify(JobBuildInputManifestSchema.parse({version:1,inputSnapshotDigest:manifest.inputSnapshotDigest,
    workflowInput:manifest.workflowInput,files:manifest.entries.map(entry=>({relativePath:entry.relativePath,...entry.pin})),
    ...(bytes ? { verificationContext: { relativePath: 'verification.json',
      sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length } } : {}) })))
}
