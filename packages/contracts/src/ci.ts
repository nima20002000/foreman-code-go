import { z } from 'zod'
import { CI_LOG_MAX_BYTES, CiActivitySchema, CiRunRecordSchema, CiSuiteSchema, CiScopeSchema, CiSelectedFilesSchema,
  CiTestResultsSchema,
  CiTestStatusSchema, CiTestSummarySchema, validCiSelection } from './ciHost.js'
import { IdSchema } from './schemaPrimitives.js'
import { JobResourceRequestSchema } from './jobVerificationPolicy.js'
import { SourceRootRecordSchema } from './sourceAdmission.js'
import { SourceManifestSchema } from './sourceMaterialization.js'

const CiRunInputObjectSchema = z.object({
  suite: CiSuiteSchema.describe('Repositories with the CI suite hook queue unit, lint, typecheck and build parts; '
    + 'other repositories run their package script for the suite as one job. Install runs one job.'),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional()
    .describe('Optional full SHA for runner-selected affected scope. Compare against this ancestor of the resolved '
      + 'commit; an unavailable or non-ancestor base falls back to the full suite with a reason.'),
  commandId: IdSchema,
  /** Split integration when the repository supplies its CI hook and file selector. */
  partitions: z.number().int().min(2).max(32).describe('Integration partitions for repositories with '
    + 'scripts/ci-suite.sh and scripts/ci-files.mjs. User-systemd files use separate build-computer slices; '
    + 'mixed explicit selections split even when this is omitted. Other repositories run integration as one job.').optional(),
  scope: CiScopeSchema.optional().describe('Defaults to affected; full runs the complete suite. '
    + 'Repositories without an affected selector always run the full suite.'),
  files: CiSelectedFilesSchema.optional().describe('Optional affected selection with an explicit commit. Omit to select '
    + 'on the runner against baseCommit or the workspace default branch; an empty list runs no tests.'),
}).strict()
const partitionedSuite = (value: { suite: string; partitions?: number | undefined }) =>
  value.partitions === undefined || value.suite === 'integration'
const partitionIssue = { message: 'Only the integration suite can be partitioned.', path: ['partitions'] }
const selectionIssue = { message: 'Selected files require an explicit commit, affected scope and a supported suite.', path: ['scope'] }
const selectedSuite = (value: z.infer<typeof CiRunInputObjectSchema>) => validCiSelection(value)
  && ((value.scope ?? 'affected') !== 'affected' || value.files === undefined || value.commit !== undefined)
export const CiRunInputSchema = CiRunInputObjectSchema.refine(partitionedSuite, partitionIssue)
  .refine(selectedSuite, selectionIssue)
export const OperatorCiRunInputSchema = CiRunInputObjectSchema.extend({ workspaceId: IdSchema }).strict()
  .refine(partitionedSuite, partitionIssue)
  .refine(selectedSuite, selectionIssue)
const CiRunTicketSchema = z.object({ ticketId: IdSchema }).strict()
/** `partitions` lists every part or integration partition; the first is also `ticketId`. Poll each with ci_get. */
export const CiRunOutputSchema = CiRunTicketSchema.extend({ partitions: z.array(CiRunTicketSchema).min(2).max(66).optional() }).strict()
const CiTicketInputSchema = z.object({ ticketId: IdSchema }).strict()
/** Statuses to include; the results' summary always counts every test. */
export const CiTestStatusFilterSchema = z.array(CiTestStatusSchema).min(1).max(3)
export const CiGetInputSchema = CiTicketInputSchema.extend({
  testStatus: CiTestStatusFilterSchema.optional().describe('Include the ticket’s structured test results, limited to '
    + 'tests with these statuses (passed, failed, skipped). tests is null until a finished unit or integration run reports them.'),
}).strict()
export const OperatorCiGetInputSchema = CiGetInputSchema.extend({ workspaceId: IdSchema }).strict()
export const CiGetOutputSchema = z.object({
  run: CiRunRecordSchema, partitions: z.array(CiRunRecordSchema).optional(), logTail: z.string(),
  group: z.object({ groupId: CiRunRecordSchema.shape.groupId, state: CiRunRecordSchema.shape.state }).strict().optional(),
  tests: CiTestResultsSchema.nullable().optional(),
}).strict()
export type CiRunInput = z.infer<typeof CiRunInputSchema>
export type CiGetInput = z.infer<typeof CiGetInputSchema>
export const CiCancelInputSchema = CiTicketInputSchema
export const OperatorCiCancelInputSchema = CiTicketInputSchema.extend({ workspaceId: IdSchema }).strict()
export const CiCancelOutputSchema = z.object({ run: CiRunRecordSchema }).strict()
export const CiTestsOutputSchema = z.object({ ticketId: IdSchema, tests: CiTestResultsSchema.nullable() }).strict()
export type CiTestsOutput = z.infer<typeof CiTestsOutputSchema>

/** Where a CI job ran: this computer fleet's Host CI, GitHub Actions or CircleCI. */
export const CiPlacementSchema = z.enum(['host', 'github', 'circleci'])
export type CiPlacement = z.infer<typeof CiPlacementSchema>
/** One CI ticket an Agent of a Run requested, with that Agent's Run node. */
export const CiRunJobSchema = z.object({
  ticketId: IdSchema, ci: CiActivitySchema, scope: CiScopeSchema, placement: CiPlacementSchema.nullable(),
  message: z.string().max(2000).nullable(),
  requester: z.object({ executionId: IdSchema, agentId: IdSchema, nodeId: z.string().min(1).max(200),
    nodeName: z.string().min(1).max(200) }).strict(),
  tests: CiTestSummarySchema.nullable(),
}).strict()
export type CiRunJob = z.infer<typeof CiRunJobSchema>
export const CI_RUN_JOBS_LIMIT = 500
export const OperatorCiListInputSchema = z.object({ workspaceId: IdSchema, runId: IdSchema }).strict()
export const CiListOutputSchema = z.object({ runId: IdSchema, jobs: z.array(CiRunJobSchema).max(CI_RUN_JOBS_LIMIT),
  /** Older tickets beyond the limit were left out. */
  truncated: z.boolean() }).strict()
export type CiListOutput = z.infer<typeof CiListOutputSchema>
export const CiLogsInputSchema = CiTicketInputSchema.extend({
  /** Omit to read the last maxBytes; continue with nextOffset. */
  afterOffset: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().min(1).optional()
    .describe(`Defaults to ${CI_LOG_MAX_BYTES} bytes; larger values are clamped to this limit.`),
  /** Include a bounded page from every part, with a separate cursor for each ticket. */
  group: z.boolean().optional(),
}).strict()
export const OperatorCiLogsInputSchema = CiLogsInputSchema.extend({ workspaceId: IdSchema }).strict()
export const CiLogsOutputSchema = z.object({ text: z.string(), nextOffset: z.number().int().nonnegative(),
  logBytes: z.number().int().nonnegative(),
  maxBytes: z.number().int().min(1).max(CI_LOG_MAX_BYTES),
  parts: z.array(z.object({ run: CiRunRecordSchema, text: z.string(), nextOffset: z.number().int().nonnegative(),
    logBytes: z.number().int().nonnegative(),
    maxBytes: z.number().int().min(1).max(CI_LOG_MAX_BYTES) }).strict()).optional(),
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
  failureCount: z.number().int().nonnegative().optional(), retryAt: z.string().datetime().optional(),
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
