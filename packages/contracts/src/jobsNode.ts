import { createHash } from 'node:crypto'
import type { PreparedJobSpec } from './jobs.js'
import type { RunInput } from './schemaPrimitives.js'
import { canonicalGraphJson } from './wave25/json.js'
/** Node-only producer/executor identity. Browser contracts never import this entrypoint. */
export function jobSpecDigests(spec:PreparedJobSpec,workflowInput:RunInput|null) {
  const hash=(value:unknown)=>createHash('sha256').update(canonicalGraphJson(value)).digest('hex')
  const prepared={source:spec.source,target:spec.target,argv:spec.argv,inputs:spec.inputs,policy:spec.policy,outputs:spec.outputs,...(spec.relativeCwd?{relativeCwd:spec.relativeCwd}:{})}
  return {scriptDigest:hash(prepared.argv),outputSpecDigest:hash(prepared.outputs),specDigest:hash({...prepared,workflowInput}),bindingHash:hash({target:prepared.target,source:prepared.source})}
}
