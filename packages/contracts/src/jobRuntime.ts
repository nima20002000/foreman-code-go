import { z } from 'zod'
import { JobPolicySchema, JobTargetSchema } from './jobs.js'
import { SourceRootRecordSchema } from './sourceAdmission.js'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'
const Digest=z.string().regex(/^[a-f0-9]{64}$/)
export const JobRuntimeLimitsSchema=z.object({cpuLimit:z.number().positive().max(256),memoryBytes:z.number().int().positive(),pidsLimit:z.number().int().positive(),diskBytes:z.number().int().positive()}).strict()
/** Policy metadata refers to an existing authorized root, never a caller filesystem path. */
export const JobRuntimeProfileInputSchema=z.object({rootId:z.uuid(),bindingRevision:z.number().int().positive(),limits:JobRuntimeLimitsSchema,
  policy:JobPolicySchema.omit({isolationPolicyId:true,isolationPolicyRevision:true}),
}).strict().superRefine((value,ctx)=>{
  if(value.policy.network!=='none'||value.policy.environmentScopeRefs.length)ctx.addIssue({code:'custom',path:['policy'],message:'This qualified noninteractive profile requires no network or credential environment.'})
  if(value.policy.maxWorkerSpoolBytes>value.limits.diskBytes||value.policy.maxOutputBytes>value.limits.diskBytes)ctx.addIssue({code:'custom',path:['policy'],message:'Declared spool/output budgets exceed the qualified filesystem limit.'})
})
export const QualifiedJobRuntimeSchema=JobRuntimeLimitsSchema.extend({policyId:IdSchema,policyRevision:z.number().int().positive(),imageDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/),toolchainDigest:Digest,
  runtimeVersion:z.string().min(1).max(200),ociRuntimeVersion:z.string().min(1).max(200),kernelVersion:z.string().min(1).max(200),qualificationId:IdSchema,
  rootless:z.literal(true),cgroupV2:z.literal(true),filesystemBounded:z.literal(true),descendantContainment:z.literal(true),network:z.literal('none'),
}).strict()
export const JobRuntimeFingerprintSchema=z.object({schemaVersion:z.literal(1),profileId:IdSchema,profileRevision:z.number().int().positive(),specDigest:Digest,
  hostRef:JobTargetSchema.shape.hostRef,registration:JobTargetSchema.shape.registration,mainInstallationId:IdSchema,bootId:z.uuid(),
  root:SourceRootRecordSchema,runtimeExecutable:z.string().startsWith('/'),runtimeBinarySha256:Digest,ociExecutable:z.string().startsWith('/'),ociBinarySha256:Digest,configurationDigest:Digest,
  imageDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/),toolchainDigest:Digest,limits:JobRuntimeLimitsSchema,
}).strict()
export const JobRuntimeApprovalSchema=z.object({schemaVersion:z.literal(1),id:z.uuid(),qualificationId:z.uuid(),workspaceId:IdSchema,profileId:IdSchema,profileRevision:z.number().int().positive(),
  fingerprint:JobRuntimeFingerprintSchema,fingerprintDigest:Digest,requestedByPrincipalId:IdSchema,
  status:z.enum(['awaiting-approval','approved','qualifying','complete','failed','cancelled','recovery-required']),approvedByPrincipalId:IdSchema.nullable(),approvedAt:TimestampSchema.nullable(),expiresAt:TimestampSchema,
}).strict()
/** A host producer supplies actual measured evidence. Public save input admits no ready/approval/proof fields. */
export const JobRuntimeMeasurementSchema=z.object({schemaVersion:z.literal(1),qualificationId:z.uuid(),profileId:IdSchema,profileRevision:z.number().int().positive(),specDigest:Digest,
  hostRef:JobTargetSchema.shape.hostRef,registration:JobTargetSchema.shape.registration,root:SourceRootRecordSchema,
  runtime:QualifiedJobRuntimeSchema,runtimeBinarySha256:Digest,ociBinarySha256:Digest,runtimeExecutable:z.string().startsWith('/'),
  environment:z.record(z.enum(['PATH','XDG_RUNTIME_DIR','LANG']),z.string()),
  fingerprint:JobRuntimeFingerprintSchema,fingerprintDigest:Digest,approvalId:z.uuid(),
  origin:z.literal('real-runtime'),checkedAt:TimestampSchema,expiresAt:TimestampSchema,
  checks:z.array(z.object({id:z.enum(['rootless','cgroup-v2','filesystem-quota','descendant-containment','network-none','image-toolchain','credential-isolation']),passed:z.boolean(),evidenceDigest:Digest}).strict()).min(7).max(7),
}).strict().superRefine((value,ctx)=>{
  if(Date.parse(value.expiresAt)<=Date.parse(value.checkedAt))ctx.addIssue({code:'custom',path:['expiresAt'],message:'Qualification evidence must expire after its actual check.'})
  if(new Set(value.checks.map(check=>check.id)).size!==7||value.checks.some(check=>!check.passed))ctx.addIssue({code:'custom',path:['checks'],message:'Every exact real-runtime qualification check must pass.'})
  if(value.runtime.policyId!==value.profileId||value.runtime.policyRevision!==value.profileRevision||value.runtime.qualificationId!==value.qualificationId)ctx.addIssue({code:'custom',message:'Qualification identity differs from its actual profile.'})
})
export const JobRuntimeProfileSchema=z.object({schemaVersion:z.literal(1),id:IdSchema,workspaceId:IdSchema,revision:z.number().int().positive(),name:z.string().trim().min(1).max(200),
  root:SourceRootRecordSchema,policy:JobPolicySchema,limits:JobRuntimeLimitsSchema,specDigest:Digest,
  status:z.enum(['unqualified','awaiting-approval','qualifying','qualified','failed','revoked','recovery-required']),
  measurement:JobRuntimeMeasurementSchema.nullable(),createdAt:TimestampSchema,updatedAt:TimestampSchema,
}).strict()
export const JobRuntimeProfileSaveSchema=z.object({commandId:IdSchema,id:IdSchema.optional(),expectedRevision:z.number().int().positive().nullable(),name:z.string().trim().min(1).max(200),spec:JobRuntimeProfileInputSchema}).strict()
export const JobRuntimeQualificationRequestSchema=z.object({commandId:IdSchema,profileId:IdSchema,expectedRevision:z.number().int().positive()}).strict()
export type JobRuntimeProfile=z.infer<typeof JobRuntimeProfileSchema>
export type JobRuntimeProfileSave=z.infer<typeof JobRuntimeProfileSaveSchema>
export type JobRuntimeMeasurement=z.infer<typeof JobRuntimeMeasurementSchema>
export type QualifiedJobRuntime=z.infer<typeof QualifiedJobRuntimeSchema>

export type JobRuntimeFingerprint=z.infer<typeof JobRuntimeFingerprintSchema>
export type JobRuntimeApproval=z.infer<typeof JobRuntimeApprovalSchema>

export const JobRuntimeQualificationReadSchema=z.object({approval:JobRuntimeApprovalSchema,measurement:JobRuntimeMeasurementSchema.nullable(),profile:JobRuntimeProfileSchema,readiness:z.object({ready:z.boolean(),reasons:z.array(z.string()),sideEffects:z.literal(false)}).strict()}).strict()
export const JobRuntimeQualificationCommandSchema=z.object({commandId:IdSchema}).strict()
