import { z } from 'zod'
import { IdSchema } from './schemaPrimitives.js'
import { JobOrdinaryVerificationSuiteSchema, JobVerificationReportReadSchema } from './jobVerification.js'
import { JobPlacementIntentSchema, JobQueueCancelSchema, JobQueueTicketSchema } from './jobAdmission.js'
import { JobResourceRequestSchema } from './jobVerificationPolicy.js'
import { JobArtifactSchema, JobArtifactReadInputSchema, JobArtifactReadOutputSchema, JobLogPageSchema, JobExecutionSchema } from './jobs.js'
import { SourceRootRecordSchema } from './sourceAdmission.js'
import { SourceManifestSchema } from './sourceMaterialization.js'

const CiRunInputObjectSchema = z.object({
  suite: JobOrdinaryVerificationSuiteSchema,
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  commandId: IdSchema,
  placementOverride: JobPlacementIntentSchema.optional(),
  /** Split an integration run into this many duration-balanced Jobs that build computers run in parallel. */
  partitions: z.number().int().min(2).max(12).optional(),
}).strict()
const partitionedSuite = (value: { suite: string; partitions?: number | undefined }) =>
  value.partitions === undefined || value.suite === 'integration'
const partitionIssue = { message: 'Only the integration suite can be partitioned.', path: ['partitions'] }
export const CiRunInputSchema = CiRunInputObjectSchema.refine(partitionedSuite, partitionIssue)
export const OperatorCiRunInputSchema = CiRunInputObjectSchema.extend({ workspaceId: IdSchema }).strict()
  .refine(partitionedSuite, partitionIssue)
const CiRunTicketSchema = z.object({ ticketId: IdSchema, executionId: IdSchema.optional() }).strict()
/** `partitions` lists every partition's ticket in order; the first is also `ticketId`. Poll each with ci_get. */
export const CiRunOutputSchema = CiRunTicketSchema.extend({ partitions: z.array(CiRunTicketSchema).min(2).max(12).optional() }).strict()
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

export const CiCancelInputSchema = JobQueueCancelSchema
export const OperatorCiCancelInputSchema = CiCancelInputSchema.extend({ workspaceId: IdSchema }).strict()
export const CiCancelOutputSchema = z.object({ ticket: JobQueueTicketSchema }).strict()
export const CiLogsInputSchema = CiGetInputSchema.extend({
  afterSequence: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(50),
}).strict()
export const OperatorCiLogsInputSchema = CiLogsInputSchema.extend({ workspaceId: IdSchema }).strict()
export const CiLogsOutputSchema = JobLogPageSchema
export const CiArtifactsOutputSchema = z.object({ artifacts: z.array(JobArtifactSchema) }).strict()
export const CiArtifactInputSchema = CiGetInputSchema.extend(JobArtifactReadInputSchema.shape).strict()
export const OperatorCiArtifactInputSchema = CiArtifactInputSchema.extend({ workspaceId: IdSchema }).strict()
export const CiArtifactOutputSchema = JobArtifactReadOutputSchema
export type CiCancelInput = z.infer<typeof CiCancelInputSchema>
export type CiLogsInput = z.infer<typeof CiLogsInputSchema>
export type CiArtifactInput = z.infer<typeof CiArtifactInputSchema>

export * from './ciEnrollment.js'
import { CiInstalledStorageSchema, CiManagedSetupSchema } from './ciEnrollment.js'
const CommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const AbsolutePathSchema = z.string().min(2).max(4096).startsWith('/')
/** Build computers prepare their own CI runtime for a commit: offline seed, image and qualification source. */
export const CI_RUNTIME_NAMESPACE = 'ci-runtime-v1'
export const CiPreparationLimitsSchema = z.object({
  cpuCount: z.number().positive(), memoryBytes: z.number().int().positive(),
}).strict()
export type CiPreparationLimits = z.infer<typeof CiPreparationLimitsSchema>
export const PreparedCiRuntimeSchema = z.object({
  commit: CommitSchema, imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), imageManifestDigest: z.string().min(1).max(200),
  seedReceiptPath: AbsolutePathSchema, contextReceiptPath: AbsolutePathSchema, qualificationSource: AbsolutePathSchema,
  reusedImage: z.boolean().optional(),
  unitCodex: z.object({ executable: AbsolutePathSchema, sourceExecutable: AbsolutePathSchema, version: z.string().min(1).max(200),
    binarySha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict()
export const CiRuntimeRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('prepare'), operationId: z.uuid(), repository: z.string().min(3).max(140), commit: CommitSchema,
    review: z.object({ reviewedByPrincipalId: IdSchema, decisionDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    keepImages: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).max(64) }).strict(),
  z.object({ operation: z.literal('status') }).strict(),
  /** `resources` are the verification profile's: the refreshed runtime reserves exactly what the profile requests. */
  z.object({ operation: z.literal('refresh'), operationId: z.uuid(), commit: CommitSchema, root: SourceRootRecordSchema, manifest: SourceManifestSchema,
    resources: JobResourceRequestSchema }).strict(),
])
export const CiRuntimeWorkerStateSchema = z.object({
  managedSetup: CiManagedSetupSchema.optional(),
  preparationLimits: CiPreparationLimitsSchema.optional(),
  installedStorage: CiInstalledStorageSchema.nullable().optional(),
  operationId: z.uuid().nullable(),
  state: z.enum(['idle', 'preparing', 'prepared', 'failed', 'refreshing']),
  commit: CommitSchema.nullable(), stage: z.string().max(80).nullable(), prepared: PreparedCiRuntimeSchema.nullable(),
  message: z.string().max(2000).nullable(), updatedAt: z.string().datetime(),
}).strict()
export const BuildComputerPrepareInputSchema = z.object({ workspaceId: IdSchema, profileId: IdSchema,
  commit: CommitSchema.optional(), commandId: IdSchema }).strict()
export const BuildComputerPrepareGetInputSchema = z.object({ workspaceId: IdSchema, profileId: IdSchema }).strict()
export const BuildComputerPrepareStatusSchema = z.object({
  preparationLimits: CiPreparationLimitsSchema.optional(),
  profileId: IdSchema, deviceId: IdSchema.nullable(),
  state: z.enum(['idle', 'approving', 'preparing', 'binding', 'refreshing', 'qualifying', 'qualified', 'failed']),
  commit: CommitSchema.nullable(), stage: z.string().max(80).nullable(), message: z.string().max(2000).nullable(),
  reuse: z.object({ image: z.boolean(), qualification: z.boolean(),
    qualificationSourceCommit: CommitSchema.nullable() }).strict().optional(),
  profiles: z.array(z.object({ profileId: IdSchema, revision: z.number().int().positive(), status: z.string().max(40) }).strict()).max(20),
  startedAt: z.string().datetime().nullable(), updatedAt: z.string().datetime().nullable(),
}).strict()
export type PreparedCiRuntime = z.infer<typeof PreparedCiRuntimeSchema>
export type CiRuntimeRequest = z.infer<typeof CiRuntimeRequestSchema>
export type CiRuntimeWorkerState = z.infer<typeof CiRuntimeWorkerStateSchema>
export type BuildComputerPrepareInput = z.infer<typeof BuildComputerPrepareInputSchema>
export type BuildComputerPrepareStatus = z.infer<typeof BuildComputerPrepareStatusSchema>
