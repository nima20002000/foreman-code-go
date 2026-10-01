import { createHash } from 'node:crypto'
import type { JobExecution } from './jobs.js'
import { JobBuildInputManifestSchema, type JobInputManifest } from './jobInputs.js'
function canonical(value:unknown):string {if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;return JSON.stringify(value)}
export function jobInputSnapshotDigest(execution:Pick<JobExecution,'acceptedSpec'>):string {return createHash('sha256').update(canonical({inputs:execution.acceptedSpec.inputs,workflowInput:execution.acceptedSpec.workflowInput})).digest('hex')}
export function jobBuildInputManifestBytes(manifest:JobInputManifest):Buffer {return Buffer.from(JSON.stringify(JobBuildInputManifestSchema.parse({version:1,inputSnapshotDigest:manifest.inputSnapshotDigest,workflowInput:manifest.workflowInput,files:manifest.entries.map(entry=>({relativePath:entry.relativePath,...entry.pin}))})))}
