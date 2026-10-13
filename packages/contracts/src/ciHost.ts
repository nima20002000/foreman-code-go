import { z } from 'zod'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'
export { integrationPartition, requiresUserSystemd } from './ciPartition.mjs'
export { userSystemdIntegrationFiles, exclusiveIntegrationFiles } from './integrationScheduling.mjs'
import { WorkspaceRepositorySchema } from './workspaceRepository.js'

/** Host CI: a build computer runs a suite directly in a git worktree of the commit, like a self-hosted runner.
 * It fetches with its own GitHub CLI login and installs packages normally; a systemd unit caps CPU and memory. */
export const CI_HOST_NAMESPACE = 'ci-host-v1'
export const CI_LOG_MAX_BYTES = 65_536

export const CiSuiteSchema = z.enum(['install', 'typecheck', 'lint', 'unit', 'build', 'integration'])
export type CiSuite = z.infer<typeof CiSuiteSchema>
const CiPartSchema = z.enum(['unit-api', 'unit-web', 'unit-web-heavy', 'unit-other',
  'lint-api', 'lint-other', 'typecheck-api', 'typecheck-other', 'build-api', 'build-other'])
export type CiPart = z.infer<typeof CiPartSchema>
export type CiExecutionSuite = CiSuite | CiPart
function validCiPart(value: { suite: CiSuite; part?: CiPart | null | undefined; partition?: CiPartition | null | undefined }) {
  if (!value.part) return !value.partition || value.suite === 'integration'
  if (!value.part.startsWith(`${value.suite}-`)) return false
  return !value.partition || value.part === 'unit-api' || value.part === 'unit-web' || value.part === 'unit-web-heavy'
}
export const CiScopeSchema = z.enum(['affected', 'full'])
export type CiScope = z.infer<typeof CiScopeSchema>
export const CiSelectedFilesSchema = z.array(z.string().min(1).max(300)
  .regex(/^(?:apps\/(?:api|web|worker)|packages\/contracts|scripts)\/[A-Za-z0-9_./-]+$/)
  .refine(file => !file.split('/').some(part => part === '..' || part === '.' || part === ''))).max(2000)

export function validCiSelection(value: { suite: CiSuite; scope?: CiScope | undefined; files?: string[] | undefined }) {
  if (value.scope === 'full') return !value.files?.length
  if (value.files === undefined) return true
  if (!['unit', 'integration', 'typecheck', 'lint'].includes(value.suite)) return false
  if (value.suite === 'integration') return value.files.every(file => /^apps\/api\/test\/[^/]+\.integration\.test\.ts$/.test(file))
  if (value.suite === 'unit') return value.files.every(file => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
    && !(file.startsWith('apps/api/') && /\.(?:integration|acceptance)\.test\.ts$/.test(file)))
  return value.files.every(file => /\.[cm]?[jt]sx?$/.test(file) && !file.startsWith('scripts/'))
}
const CommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const CiRepositorySchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
/** `weights` gives each slice's relative speed (its computer's measured throughput), so slices finish together. */
export const CiPartitionSchema = z.object({ index: z.number().int().nonnegative(), count: z.number().int().min(1).max(64),
  /** Slow tier: files measured at or above the slow threshold run only after the rest of the request passed. */
  tier: z.enum(['fast', 'slow']).optional(),
  slowFiles: z.array(z.string().min(1).max(300)).max(300).optional(),
  /** Keep files at or above this measured duration alone when capacity permits. */
  targetDurationMs: z.number().positive().finite().optional(),
  weights: z.array(z.number().positive().finite()).optional(),
  /** Only user-systemd files run in these slices on capable cloud executors or build computers; ordinary files use the others. */
  hostIndexes: z.array(z.number().int().nonnegative()).min(1).max(64).optional() }).strict()
  .refine(value => value.index < value.count, 'The partition index must be below its count.')
  .refine(value => !value.weights || value.weights.length === value.count, 'Give one weight per partition.')
  .refine(value => !value.hostIndexes || (new Set(value.hostIndexes).size === value.hostIndexes.length
    && value.hostIndexes.every(index => index < value.count)), 'Host indexes must be unique partition indexes.')
export type CiPartition = z.infer<typeof CiPartitionSchema>

/** Test file -> wall milliseconds. Bounded so a start request or read reply stays far below the device
 * channel's 1 MiB message limit. */
export const CiDurationsSchema = z.record(z.string().min(1).max(300), z.number().positive().finite().max(24 * 3_600_000))
  .refine(value => Object.keys(value).length <= 1000, 'Give at most 1000 file durations.')
export type CiDurations = z.infer<typeof CiDurationsSchema>

/** Structured per-test results a finished test run reports with its measured durations. Bounded with the durations
 * so one read reply stays far below the device channel's 1 MiB message limit: failed tests are kept first, then
 * skipped, then passed; `summary` always counts every test. */
export const CI_TEST_RESULT_LIMITS = { tests: 600, files: 300, name: 200, file: 200, message: 240, location: 240 } as const
export const CiTestStatusSchema = z.enum(['passed', 'failed', 'skipped'])
export type CiTestStatus = z.infer<typeof CiTestStatusSchema>
const CiTestDurationSchema = z.number().nonnegative().finite().max(24 * 3_600_000).nullable()
const CiTestCaseSchema = z.object({ name: z.string().min(1).max(CI_TEST_RESULT_LIMITS.name), status: CiTestStatusSchema,
  durationMs: CiTestDurationSchema, message: z.string().max(CI_TEST_RESULT_LIMITS.message).optional(),
  /** A failure's `path:line:column` in the repository, read from its full stack. */
  location: z.string().max(CI_TEST_RESULT_LIMITS.location).optional() }).strict()
const CiTestFileSchema = z.object({ file: z.string().min(1).max(CI_TEST_RESULT_LIMITS.file), status: CiTestStatusSchema,
  durationMs: CiTestDurationSchema, tests: z.array(CiTestCaseSchema).max(CI_TEST_RESULT_LIMITS.tests) }).strict()
export const CiTestSummarySchema = z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative() }).strict()
export const CiTestResultsSchema = z.object({ summary: CiTestSummarySchema,
  files: z.array(CiTestFileSchema).max(CI_TEST_RESULT_LIMITS.files),
  /** Some tests or files were left out to stay within the bounds. */
  truncated: z.boolean() }).strict()
  .refine(value => value.files.reduce((count, file) => count + file.tests.length, 0) <= CI_TEST_RESULT_LIMITS.tests,
    `Give at most ${CI_TEST_RESULT_LIMITS.tests} tests.`)
export type CiTestResults = z.infer<typeof CiTestResultsSchema>

const CiHostRunIdSchema = z.uuid()
/** `durations` are Main's learned integration file durations; the commit's committed durations fill the gaps. */
const CiHostStartSchema = z.object({
  operation: z.literal('start'), runId: CiHostRunIdSchema, repository: CiRepositorySchema, commit: CommitSchema,
  suite: CiSuiteSchema, part: CiPartSchema.optional(), partition: CiPartitionSchema.optional(), durations: CiDurationsSchema.optional(),
  scope: CiScopeSchema.optional(), files: CiSelectedFilesSchema.optional(),
  expectedDurationMs: z.number().nonnegative().finite().optional(),
  gate: z.boolean().optional(), integrationShards: z.number().int().min(1).max(64).optional(),
  defaultBranch: WorkspaceRepositorySchema.shape.defaultBranch.optional(),
  baseCommit: CommitSchema.optional(),
}).strict().refine(value => value.gate
  ? value.suite === 'integration' && value.scope === 'full' && !!value.files?.length && !value.partition && !value.part
    && value.integrationShards !== undefined && value.files.every(file => /^apps\/api\/test\/[^/]+\.integration\.test\.ts$/.test(file))
  : validCiSelection(value) && value.integrationShards === undefined,
  'Gate jobs require full integration scope, assigned files and a shard count; other selections require affected scope.')
  .refine(validCiPart, 'The part and partition must belong to the requested suite.')
export const CiHostRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  CiHostStartSchema,
  // `durations: true` asks a finished test run for the file durations it measured, `testResults: true` for its
  // test results. Results are opt-in so a Worker never sends them to a Main whose reply schema predates them.
  z.object({ operation: z.literal('read'), runId: CiHostRunIdSchema, afterOffset: z.number().int().nonnegative(),
    maxBytes: z.number().int().min(1).max(CI_LOG_MAX_BYTES), durations: z.boolean().optional(), testResults: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal('cancel'), runId: CiHostRunIdSchema }).strict(),
])
export type CiHostRequest = z.infer<typeof CiHostRequestSchema>

const CiHostRunStateSchema = z.enum(['queued', 'starting', 'running', 'passed', 'failed', 'canceled', 'lost'])
const CiHostRunSchema = z.object({
  runId: CiHostRunIdSchema, state: CiHostRunStateSchema, step: z.string().max(80).nullable(),
  exitCode: z.number().int().nullable(), startedAt: TimestampSchema, finishedAt: TimestampSchema.nullable(),
  logBytes: z.number().int().nonnegative(), message: z.string().max(2000).nullable(),
}).strict()
export type CiHostRun = z.infer<typeof CiHostRunSchema>
export const CiUserSystemdSchema = z.object({ supported: z.boolean(), reason: z.string().max(300).nullable() }).strict()
export type CiUserSystemd = z.infer<typeof CiUserSystemdSchema>
export const CiHostStatusSchema = z.object({
  operation: z.literal('status'), ready: z.boolean(), reasons: z.array(z.string().max(300)).max(10),
  cpuCount: z.number().int().positive(), memoryBytes: z.number().int().positive(),
  availableMemoryBytes: z.number().int().nonnegative().optional(),
  slotsUsed: z.number().int().nonnegative().optional(), slotsTotal: z.number().int().positive().optional(),
  userSystemd: CiUserSystemdSchema.optional(),
  runs: z.array(CiHostRunSchema).max(50),
}).strict()
export type CiHostStatus = z.infer<typeof CiHostStatusSchema>
export const CiHostReplySchema = z.discriminatedUnion('operation', [
  CiHostStatusSchema,
  z.object({ operation: z.literal('start'), run: CiHostRunSchema }).strict(),
  z.object({ operation: z.literal('read'), run: CiHostRunSchema, text: z.string(), nextOffset: z.number().int().nonnegative(),
    durations: CiDurationsSchema.optional(), testResults: CiTestResultsSchema.optional() }).strict(),
  z.object({ operation: z.literal('cancel'), run: CiHostRunSchema }).strict(),
])
export type CiHostReply = z.infer<typeof CiHostReplySchema>

/** What an Agent or the Operator sees for one CI run. */
export const CiPrioritySchema = z.enum(['normal', 'high'])
export const CiPriorityReasonSchema = z.enum(['normal', 'requested', 'ci-infrastructure', 'gate'])
export const CiRunRecordSchema = z.object({
  id: CiHostRunIdSchema, workspaceId: IdSchema, suite: CiSuiteSchema, commit: CommitSchema, repository: CiRepositorySchema,
  scope: CiScopeSchema.default('full'), files: CiSelectedFilesSchema.default([]),
  priority: CiPrioritySchema.default('normal'), priorityReason: CiPriorityReasonSchema.default('normal'),
  gate: z.boolean().optional(), integrationShards: z.number().int().min(1).max(64).optional(),
  /** An omitted caller selection is computed on the runner; an explicit empty list is already complete. */
  deriveFiles: z.boolean().optional(), defaultBranch: WorkspaceRepositorySchema.shape.defaultBranch.optional(),
  baseCommit: CommitSchema.optional(),
  branch: WorkspaceRepositorySchema.shape.defaultBranch.nullable().optional(),
  noSupersede: z.boolean().optional(),
  supersededBy: CiHostRunIdSchema.optional(),
  partition: CiPartitionSchema.nullable(), groupId: CiHostRunIdSchema,
  part: CiPartSchema.nullable().default(null),
  state: z.enum(['queued', 'starting', 'running', 'passed', 'failed', 'canceled', 'lost']),
  computer: z.object({ hostRef: z.object({ kind: z.enum(['main', 'device', 'cloud']), mainId: z.string(), deviceId: z.string().optional(),
    provider: z.enum(['github', 'circleci']).optional(), slot: z.number().int().nonnegative().optional() }).strict(),
    label: z.string() }).strict().nullable(),
  step: z.string().nullable(), exitCode: z.number().int().nullable(), message: z.string().nullable(),
  queuedAt: TimestampSchema, startedAt: TimestampSchema.nullable(), finishedAt: TimestampSchema.nullable(),
  initiator: z.object({ principalId: IdSchema, executionId: IdSchema.nullable() }).strict(),
  /** The computer a weighted partition was sized for; another free computer may still take it. */
  plannedHostKey: z.string().nullable().optional(),
  /** Measured test time plus a fixed setup allowance; runner-derived selections use a full-suite upper estimate. */
  expectedDurationMs: z.number().nonnegative().finite().optional(),
  /** The planned slice contains files requiring a build computer. */
  requiresBuildComputer: z.boolean().optional(),
  /** A slow-tier part: it starts only after every other part of its request passed, and is skipped otherwise. */
  deferred: z.boolean().optional(),
  /** Providers that accepted a dispatch but exhausted retries without creating work. */
  unstartedProviders: z.array(z.enum(['github', 'circleci'])).max(2).optional(),
}).strict().refine(validCiPart, 'The part and partition must belong to the requested suite.')
export type CiRunRecord = z.infer<typeof CiRunRecordSchema>

/** Bounded lifecycle facts shared by Run history and activity snapshots. */
export const CiActivitySchema = z.object(CiRunRecordSchema.shape).pick({
  id: true, groupId: true, suite: true, part: true, partition: true, state: true,
  queuedAt: true, startedAt: true, finishedAt: true, exitCode: true,
}).extend({
  computer: CiRunRecordSchema.shape.computer.unwrap().extend({ label: z.string().max(100) }).nullable(),
  step: z.string().max(80).nullable(),
}).strict().refine(validCiPart, 'The part and partition must belong to the requested suite.')
export type CiActivity = z.infer<typeof CiActivitySchema>
