import { z } from 'zod'
import { CiRunRecordSchema, CiSuiteSchema, CiScopeSchema, CiSelectedFilesSchema, validCiSelection } from './ciHost.js'
import { IdSchema } from './schemaPrimitives.js'
import { JobResourceRequestSchema } from './jobVerificationPolicy.js'
import { SourceRootRecordSchema } from './sourceAdmission.js'
import { SourceManifestSchema } from './sourceMaterialization.js'

const CiRunInputObjectSchema = z.object({
  suite: CiSuiteSchema.describe('Unit, lint, typecheck and build automatically queue separate suite parts; install runs one job.'),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  commandId: IdSchema,
  /** Split an integration run into this many duration-balanced runs on separate build computers. */
  partitions: z.number().int().min(2).max(32).optional(),
  scope: CiScopeSchema.optional(),
  files: CiSelectedFilesSchema.optional(),
}).strict()
const partitionedSuite = (value: { suite: string; partitions?: number | undefined }) =>
  value.partitions === undefined || value.suite === 'integration'
const partitionIssue = { message: 'Only the integration suite can be partitioned.', path: ['partitions'] }
const selectionIssue = { message: 'Affected scope requires a commit and selected files for a supported suite.', path: ['scope'] }
const selectedSuite = (value: z.infer<typeof CiRunInputObjectSchema>) => validCiSelection(value)
  && (value.scope !== 'affected' || value.commit !== undefined)
export const CiRunInputSchema = CiRunInputObjectSchema.refine(partitionedSuite, partitionIssue)
  .refine(selectedSuite, selectionIssue)
export const OperatorCiRunInputSchema = CiRunInputObjectSchema.extend({ workspaceId: IdSchema }).strict()
  .refine(partitionedSuite, partitionIssue)
  .refine(selectedSuite, selectionIssue)
const CiRunTicketSchema = z.object({ ticketId: IdSchema }).strict()
/** `partitions` lists every part or integration partition; the first is also `ticketId`. Poll each with ci_get. */
export const CiRunOutputSchema = CiRunTicketSchema.extend({ partitions: z.array(CiRunTicketSchema).min(2).max(66).optional() }).strict()
export const CiGetInputSchema = z.object({ ticketId: IdSchema }).strict()
export const OperatorCiGetInputSchema = CiGetInputSchema.extend({ workspaceId: IdSchema }).strict()
export const CiGetOutputSchema = z.object({
  run: CiRunRecordSchema, partitions: z.array(CiRunRecordSchema).optional(), logTail: z.string(),
  group: z.object({ groupId: CiRunRecordSchema.shape.groupId, state: CiRunRecordSchema.shape.state }).strict().optional(),
}).strict()
export type CiRunInput = z.infer<typeof CiRunInputSchema>
export type CiGetInput = z.infer<typeof CiGetInputSchema>
export const CiCancelInputSchema = CiGetInputSchema
export const OperatorCiCancelInputSchema = OperatorCiGetInputSchema
export const CiCancelOutputSchema = z.object({ run: CiRunRecordSchema }).strict()
export const CiLogsInputSchema = CiGetInputSchema.extend({
  /** Omit to read the last maxBytes; continue with nextOffset. */
  afterOffset: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().min(1).max(65_536).optional(),
  /** Include a bounded page from every part, with a separate cursor for each ticket. */
  group: z.boolean().optional(),
}).strict()
export const OperatorCiLogsInputSchema = CiLogsInputSchema.extend({ workspaceId: IdSchema }).strict()
export const CiLogsOutputSchema = z.object({ text: z.string(), nextOffset: z.number().int().nonnegative(),
  logBytes: z.number().int().nonnegative(),
  parts: z.array(z.object({ run: CiRunRecordSchema, text: z.string(), nextOffset: z.number().int().nonnegative(),
    logBytes: z.number().int().nonnegative() }).strict()).optional(),
}).strict()
export const CiComputersOutputSchema = z.object({ computers: z.array(z.object({
  label: z.string(), hostRef: CiRunRecordSchema.shape.computer.unwrap().shape.hostRef,
  priority: z.number().int(), ready: z.boolean(), reasons: z.array(z.string()),
  cpuCount: z.number().int().positive().optional(), memoryBytes: z.number().int().positive().optional(),
  running: z.array(z.string()).optional(),
}).strict()) }).strict()
export type CiCancelInput = z.infer<typeof CiCancelInputSchema>
export type CiLogsInput = z.infer<typeof CiLogsInputSchema>

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
