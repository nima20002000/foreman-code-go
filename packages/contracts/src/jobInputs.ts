import { z } from 'zod'
import { JobExecutionSchema, JobInputRevisionSchema } from './jobs.js'
import { RunInputSchema } from './schemaPrimitives.js'
import { FileScopeSchema, FileSha256Schema } from './files.js'
import { TransferIntentSchema } from './byteTransfer.js'
const Relative=z.string().min(1).max(2048).refine(path=>!path.startsWith('/')&&!path.includes('\\')&&!path.includes('\0')&&!path.split('/').some(part=>!part||part==='.'||part==='..'),'Safe relative input path required.')
export const JOB_INPUT_DIRECTORY='.graphql-job-inputs' as const
export const JobInputRecipientSchema=z.object({workspaceId:JobExecutionSchema.shape.workspaceId,executionId:JobExecutionSchema.shape.id,
  attemptId:JobExecutionSchema.shape.attemptId,operationId:JobExecutionSchema.shape.operationId,owner:JobExecutionSchema.shape.owner,
  bindingHash:FileSha256Schema,specDigest:FileSha256Schema,materializationId:z.uuid(),materializationDigest:FileSha256Schema}).strict()
export const JobInputEntrySchema=z.object({relativePath:Relative,pin:JobInputRevisionSchema.omit({path:true}),scope:FileScopeSchema,
  senderPrincipalId:z.string().min(1),senderGrantsDigest:FileSha256Schema,
  delegation:z.object({kind:z.literal('run-edge'),bindingId:z.string().min(1),runId:z.string().min(1),sourceExecutionId:z.string().min(1),sourceResultDigest:z.string().min(1),ordinal:z.number().int().nonnegative()}).strict().nullable()}).strict()
export const JobInputManifestSchema=z.object({version:z.literal(1),bindingId:z.string().min(1),recipient:JobInputRecipientSchema,
  inputSnapshotDigest:FileSha256Schema,workflowInput:RunInputSchema.nullable(),entries:z.array(JobInputEntrySchema).max(256),
  manifestSha256:FileSha256Schema,manifestByteSize:z.number().int().nonnegative().max(4*1024*1024),
  totalBytes:z.number().int().nonnegative().max(128*1024*1024)}).strict()
export const JobInputAdmissionSchema=z.object({version:z.literal(1),manifest:JobInputManifestSchema,
  principalId:z.string().min(1),principalGrantsDigest:FileSha256Schema,issuedAt:z.string().datetime(),
  transfers:z.array(z.object({relativePath:Relative,intent:TransferIntentSchema}).strict()).max(258)}).strict()
export const JobInputDeliveryReceiptSchema=z.object({version:z.literal(1),recipient:JobInputRecipientSchema,
  bindingId:z.string().min(1),inputSnapshotDigest:FileSha256Schema,manifestSha256:FileSha256Schema,manifestByteSize:z.number().int().nonnegative(),
  directory:z.object({relativePath:z.literal('.graphql-job-inputs'),device:z.string().regex(/^\d+$/),inode:z.string().regex(/^\d+$/),mountId:z.string().regex(/^\d+$/)}).strict(),
  files:z.array(z.object({relativePath:Relative,sha256:FileSha256Schema,byteSize:z.number().int().nonnegative()}).strict()).max(258),
  readonlyMountRequired:z.literal(true)}).strict()
export type JobInputRecipient=z.infer<typeof JobInputRecipientSchema>
export type JobInputEntry=z.infer<typeof JobInputEntrySchema>
export type JobInputManifest=z.infer<typeof JobInputManifestSchema>
export type JobInputAdmission=z.infer<typeof JobInputAdmissionSchema>
export type JobInputDeliveryReceipt=z.infer<typeof JobInputDeliveryReceiptSchema>

export const JobBuildInputManifestSchema=z.object({version:z.literal(1),inputSnapshotDigest:FileSha256Schema,workflowInput:RunInputSchema.nullable(),
  files:z.array(z.object({relativePath:Relative,...JobInputRevisionSchema.omit({path:true}).shape}).strict()).max(256)}).strict()
export type JobBuildInputManifest=z.infer<typeof JobBuildInputManifestSchema>
export const JobInputDeviceRequestSchema=z.discriminatedUnion('method',[
 z.object({method:z.literal('bind'),recipient:JobInputRecipientSchema}).strict(),
 z.object({method:z.literal('authorize'),executionId:z.string().min(1),transferId:z.uuid()}).strict(),
 z.object({method:z.literal('range'),executionId:z.string().min(1),transferId:z.uuid(),offset:z.number().int().nonnegative(),length:z.number().int().min(1).max(8192)}).strict(),
])
