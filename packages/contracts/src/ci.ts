import { z } from 'zod'
import { IdSchema } from './schemaPrimitives.js'
import { JobOrdinaryVerificationSuiteSchema, JobVerificationReportReadSchema } from './jobVerification.js'
import { JobQueueTicketSchema } from './jobAdmission.js'
import { JobResourceRequestSchema } from './jobVerificationPolicy.js'
import { JobExecutionSchema } from './jobs.js'
import { SourceRootRecordSchema, SourcePinSchema } from './sourceAdmission.js'
import { SourceManifestSchema } from './sourceMaterialization.js'

export const CiRunInputSchema = z.object({
  suite: JobOrdinaryVerificationSuiteSchema,
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  commandId: IdSchema,
}).strict()
export const OperatorCiRunInputSchema = CiRunInputSchema.extend({ workspaceId: IdSchema }).strict()
export const CiRunOutputSchema = z.object({ ticketId: IdSchema, executionId: IdSchema.optional() }).strict()
export const CiGetInputSchema = z.object({ ticketId: IdSchema }).strict()
export const OperatorCiGetInputSchema = CiGetInputSchema.extend({ workspaceId: IdSchema }).strict()
export const CiGetOutputSchema = z.object({
  queue: JobQueueTicketSchema,
  executionId: IdSchema.nullable(),
  process: JobExecutionSchema.shape.process.nullable(),
  publication: JobExecutionSchema.shape.publication.nullable(),
  resultIssue: JobExecutionSchema.shape.resultIssue,
  summaryReport: JobVerificationReportReadSchema.nullable(),
  logTail: z.object({ text: z.string().max(32768), truncated: z.boolean() }).strict(),
}).strict()
export type CiRunInput = z.infer<typeof CiRunInputSchema>
export type CiGetInput = z.infer<typeof CiGetInputSchema>

const CommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const AbsolutePathSchema = z.string().min(2).max(4096).startsWith('/')
/** Build computers prepare their own CI runtime for a commit: offline seed, image and qualification source. */
export const CI_RUNTIME_NAMESPACE = 'ci-runtime-v1'
export const PreparedCiRuntimeSchema = z.object({
  commit: CommitSchema, imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), imageManifestDigest: z.string().min(1).max(200),
  seedReceiptPath: AbsolutePathSchema, contextReceiptPath: AbsolutePathSchema, qualificationSource: AbsolutePathSchema,
  unitCodex: z.object({ executable: AbsolutePathSchema, sourceExecutable: AbsolutePathSchema, version: z.string().min(1).max(200),
    binarySha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict()
export const CiRuntimeRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('source'), transferId: z.uuid(), repository: z.string().min(3).max(140),
    source: SourcePinSchema, byteSize: z.number().int().positive().max(128 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().nonnegative(),
    dataBase64: z.string().max(700 * 1024), complete: z.boolean() }).strict(),
  z.object({ operation: z.literal('prepare'), repository: z.string().min(3).max(140), commit: CommitSchema,
    review: z.object({ reviewedByPrincipalId: IdSchema, decisionDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    keepImages: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).max(8) }).strict(),
  z.object({ operation: z.literal('status') }).strict(),
  /** `resources` are the verification profile's: the refreshed runtime reserves exactly what the profile requests. */
  z.object({ operation: z.literal('refresh'), commit: CommitSchema, root: SourceRootRecordSchema, manifest: SourceManifestSchema,
    resources: JobResourceRequestSchema }).strict(),
])
export const CiRuntimeWorkerStateSchema = z.object({
  state: z.enum(['idle', 'preparing', 'prepared', 'failed', 'refreshing']),
  commit: CommitSchema.nullable(), stage: z.string().max(80).nullable(), prepared: PreparedCiRuntimeSchema.nullable(),
  message: z.string().max(2000).nullable(), updatedAt: z.string().datetime(),
}).strict()
export const BuildComputerPrepareInputSchema = z.object({ workspaceId: IdSchema, profileId: IdSchema,
  commit: CommitSchema.optional(), commandId: IdSchema }).strict()
export const BuildComputerPrepareGetInputSchema = z.object({ workspaceId: IdSchema, profileId: IdSchema }).strict()
export const BuildComputerPrepareStatusSchema = z.object({
  profileId: IdSchema, deviceId: IdSchema.nullable(),
  state: z.enum(['idle', 'approving', 'preparing', 'binding', 'refreshing', 'qualifying', 'qualified', 'failed']),
  commit: CommitSchema.nullable(), stage: z.string().max(80).nullable(), message: z.string().max(2000).nullable(),
  profiles: z.array(z.object({ profileId: IdSchema, revision: z.number().int().positive(), status: z.string().max(40) }).strict()).max(20),
  startedAt: z.string().datetime().nullable(), updatedAt: z.string().datetime().nullable(),
}).strict()
export type PreparedCiRuntime = z.infer<typeof PreparedCiRuntimeSchema>
export type CiRuntimeRequest = z.infer<typeof CiRuntimeRequestSchema>
export type CiRuntimeWorkerState = z.infer<typeof CiRuntimeWorkerStateSchema>
export type BuildComputerPrepareInput = z.infer<typeof BuildComputerPrepareInputSchema>
export type BuildComputerPrepareStatus = z.infer<typeof BuildComputerPrepareStatusSchema>
