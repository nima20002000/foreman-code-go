import { z } from 'zod'
import { JobPolicySchema, JobTargetSchema } from './jobs.js'
import { SourceRootRecordSchema } from './sourceAdmission.js'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'
import { DeviceSessionBindingSchema } from './deviceConnection.js'
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
/** Trusted admission retained on the original human-approved qualification row.
 * A diagnostic is its own subject; it never borrows a workflow grant or Job ID.
 * Public profile/request inputs do not accept this internal authority. */
export const JobRuntimeNativeAdmissionSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('job-runtime-qualification'),
  approvalId:z.uuid(),qualificationId:z.uuid(),operationId:z.uuid(),workspaceId:IdSchema,profileId:IdSchema,profileRevision:z.number().int().positive(),
  fingerprintDigest:Digest,leaseId:z.uuid(),runCommandId:IdSchema,runPrincipalId:IdSchema,approvedByPrincipalId:IdSchema,
  hostRef:JobTargetSchema.shape.hostRef,registration:JobTargetSchema.shape.registration,mainInstallationId:IdSchema,bootId:z.uuid(),
  connection:DeviceSessionBindingSchema.nullable(),admittedAt:TimestampSchema,expiresAt:TimestampSchema,
}).strict().superRefine((value,ctx)=>{
  if(value.operationId!==value.qualificationId||value.hostRef.mainId!==value.mainInstallationId)
    ctx.addIssue({code:'custom',message:'Admission must retain the original qualification and Main installation.'})
  if(Date.parse(value.expiresAt)<=Date.parse(value.admittedAt))
    ctx.addIssue({code:'custom',message:'Admission must expire after reservation.'})
  if(value.hostRef.kind==='main') {
    if(value.registration!==null||value.connection!==null)
      ctx.addIssue({code:'custom',message:'Main-local admission cannot carry worker authority.'})
  } else if(!value.registration||!value.connection||value.connection.mainId!==value.mainInstallationId||value.connection.deviceId!==value.hostRef.deviceId||
    value.connection.workerInstallationId!==value.registration.workerInstallationId||value.connection.keyRevision!==value.registration.keyRevision||
    value.connection.authorizationRevision!==value.registration.authorizationRevision||value.connection.bootId!==value.bootId)
    ctx.addIssue({code:'custom',message:'Admission must retain the exact authenticated worker binding.'})
})
export type JobRuntimeNativeAdmission=z.infer<typeof JobRuntimeNativeAdmissionSchema>
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

export const JobRuntimeQualificationReadSchema=z.object({approval:JobRuntimeApprovalSchema,nativeAdmission:JobRuntimeNativeAdmissionSchema.nullable(),measurement:JobRuntimeMeasurementSchema.nullable(),profile:JobRuntimeProfileSchema,readiness:z.object({ready:z.boolean(),reasons:z.array(z.string()),sideEffects:z.literal(false)}).strict()}).strict()
export const JobRuntimeQualificationCommandSchema=z.object({commandId:IdSchema}).strict()
const QualificationPath=z.string().startsWith('/').refine(value=>!value.includes('\0')&&!value.includes('\n')&&!value.includes(','))
const QualificationEnvironment=z.object({PATH:z.string().min(1),XDG_RUNTIME_DIR:QualificationPath,LANG:z.literal('C.UTF-8')}).strict()
export const InstalledJobRuntimeDescriptorSchema=z.object({
  target:z.object({hostRef:JobRuntimeFingerprintSchema.shape.hostRef,registration:JobRuntimeFingerprintSchema.shape.registration,
    mainInstallationId:JobRuntimeFingerprintSchema.shape.mainInstallationId}).strict(),
  runtimeExecutable:QualificationPath,ociExecutable:QualificationPath,findmntExecutable:QualificationPath,findmntBinarySha256:Digest,
  runtimeRoot:QualificationPath,backingFile:QualificationPath,controllerEnvironment:QualificationEnvironment,
}).strict()
export type InstalledJobRuntimeDescriptor=z.infer<typeof InstalledJobRuntimeDescriptorSchema>
export const JobQualificationCandidateSchema=z.object({qualificationId:z.uuid(),operationId:z.uuid(),approvalId:z.uuid(),
  fingerprint:JobRuntimeFingerprintSchema,findmntBinary:QualificationPath,findmntBinarySha256:Digest,
  backingFile:QualificationPath,backingBytes:z.number().int().positive(),controllerEnvironment:QualificationEnvironment,
  sourceParent:QualificationPath,runtimeRoot:QualificationPath,spoolBytes:z.number().int().min(131072).max(67108864),
  ttlSeconds:z.number().int().positive().max(86400),
}).strict().superRefine((value,ctx)=>{
  if(value.fingerprint.root.binding.accessMode!=='exclusive-write'||value.sourceParent!==value.fingerprint.root.binding.canonicalPath)
    ctx.addIssue({code:'custom',message:'Qualification requires the exact existing exclusive-write root binding.'})
})
export type JobQualificationCandidate=z.infer<typeof JobQualificationCandidateSchema>
export const JobRuntimeQualificationResultSchema=z.discriminatedUnion('outcome',[
  z.object({outcome:z.literal('qualified'),measurement:JobRuntimeMeasurementSchema}).strict(),
  z.object({outcome:z.literal('denied'),closure:z.enum(['not_started','confirmed','unconfirmed']),reasons:z.array(z.string().max(500)).max(128)}).strict(),
])
export const JobRuntimeQualificationRpcRequestSchema=z.discriminatedUnion('operation',[
  z.object({version:z.literal(1),operation:z.literal('inspect'),profile:JobRuntimeProfileSchema}).strict(),
  z.object({version:z.literal(1),operation:z.enum(['run','authorize']),admission:JobRuntimeNativeAdmissionSchema,candidate:JobQualificationCandidateSchema}).strict(),
])
export const JobRuntimeQualificationRpcResponseSchema=z.discriminatedUnion('operation',[
  z.object({version:z.literal(1),operation:z.literal('inspect'),descriptor:InstalledJobRuntimeDescriptorSchema,fingerprint:JobRuntimeFingerprintSchema}).strict(),
  z.object({version:z.literal(1),operation:z.literal('run'),admission:JobRuntimeNativeAdmissionSchema,candidate:JobQualificationCandidateSchema,result:JobRuntimeQualificationResultSchema}).strict(),
  z.object({version:z.literal(1),operation:z.literal('authorize'),admission:JobRuntimeNativeAdmissionSchema,candidate:JobQualificationCandidateSchema,
    approval:z.object({status:z.literal('approved'),fingerprint:Digest,expiresAt:TimestampSchema}).strict()}).strict(),
])
export const JOB_RUNTIME_QUALIFICATION_EXTENSION=Object.freeze({namespace:'job-runtime-qualification-v1',version:1 as const,maxJsonBytes:1048576,maxBinaryBytes:0})
export type JobRuntimeQualificationRpcRequest=z.infer<typeof JobRuntimeQualificationRpcRequestSchema>
export type JobRuntimeQualificationRpcResponse=z.infer<typeof JobRuntimeQualificationRpcResponseSchema>
