import { z } from 'zod'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'

/** Host CI: a build computer runs a suite directly in a git worktree of the commit, like a self-hosted runner.
 * It fetches with its own GitHub CLI login and installs packages normally; a systemd unit caps CPU and memory. */
export const CI_HOST_NAMESPACE = 'ci-host-v1'

export const CiSuiteSchema = z.enum(['install', 'typecheck', 'lint', 'unit', 'build', 'integration'])
export type CiSuite = z.infer<typeof CiSuiteSchema>
const CommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
export const CiRepositorySchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
export const CiPartitionSchema = z.object({ index: z.number().int().nonnegative(), count: z.number().int().min(2).max(12) })
  .strict().refine(value => value.index < value.count, 'The partition index must be below its count.')
export type CiPartition = z.infer<typeof CiPartitionSchema>

export const CiHostRunIdSchema = z.uuid()
export const CiHostStartSchema = z.object({
  operation: z.literal('start'), runId: CiHostRunIdSchema, repository: CiRepositorySchema, commit: CommitSchema,
  suite: CiSuiteSchema, partition: CiPartitionSchema.optional(),
}).strict()
export const CiHostRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  CiHostStartSchema,
  z.object({ operation: z.literal('read'), runId: CiHostRunIdSchema, afterOffset: z.number().int().nonnegative(),
    maxBytes: z.number().int().min(1).max(65_536) }).strict(),
  z.object({ operation: z.literal('cancel'), runId: CiHostRunIdSchema }).strict(),
])
export type CiHostRequest = z.infer<typeof CiHostRequestSchema>

export const CiHostRunStateSchema = z.enum(['starting', 'running', 'passed', 'failed', 'canceled', 'lost'])
export const CiHostRunSchema = z.object({
  runId: CiHostRunIdSchema, state: CiHostRunStateSchema, step: z.string().max(80).nullable(),
  exitCode: z.number().int().nullable(), startedAt: TimestampSchema, finishedAt: TimestampSchema.nullable(),
  logBytes: z.number().int().nonnegative(), message: z.string().max(2000).nullable(),
}).strict()
export type CiHostRun = z.infer<typeof CiHostRunSchema>
export const CiHostStatusSchema = z.object({
  operation: z.literal('status'), ready: z.boolean(), reasons: z.array(z.string().max(300)).max(10),
  cpuCount: z.number().int().positive(), memoryBytes: z.number().int().positive(),
  runs: z.array(CiHostRunSchema).max(50),
}).strict()
export const CiHostReplySchema = z.discriminatedUnion('operation', [
  CiHostStatusSchema,
  z.object({ operation: z.literal('start'), run: CiHostRunSchema }).strict(),
  z.object({ operation: z.literal('read'), run: CiHostRunSchema, text: z.string(), nextOffset: z.number().int().nonnegative() }).strict(),
  z.object({ operation: z.literal('cancel'), run: CiHostRunSchema }).strict(),
])
export type CiHostReply = z.infer<typeof CiHostReplySchema>

/** One deterministic, duration-balanced slice of the integration files: the longest files go first, each to the
 * partition with the least recorded time. Files without a recorded duration count as the median. */
export function integrationPartition(files: readonly string[], durations: Readonly<Record<string, number>>,
  partition: CiPartition): string[] {
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
  const known = files.map(file => durations[file]).filter(valid).sort((a, b) => a - b)
  const fallback = known.length ? known[Math.floor(known.length / 2)]! : 1
  const weight = (file: string) => valid(durations[file]) ? durations[file] : fallback
  const loads = Array<number>(partition.count).fill(0)
  const owner = new Map<string, number>()
  for (const file of [...files].sort((left, right) => weight(right) - weight(left) || (left < right ? -1 : 1))) {
    let lightest = 0
    for (let index = 1; index < loads.length; index++) if (loads[index]! < loads[lightest]!) lightest = index
    loads[lightest]! += weight(file)
    owner.set(file, lightest)
  }
  return files.filter(file => owner.get(file) === partition.index)
}

/** What an Agent or the Operator sees for one CI run. */
export const CiRunRecordSchema = z.object({
  id: CiHostRunIdSchema, workspaceId: IdSchema, suite: CiSuiteSchema, commit: CommitSchema, repository: CiRepositorySchema,
  partition: CiPartitionSchema.nullable(), groupId: CiHostRunIdSchema,
  state: z.enum(['queued', 'starting', 'running', 'passed', 'failed', 'canceled', 'lost']),
  computer: z.object({ hostRef: z.object({ kind: z.enum(['main', 'device']), mainId: z.string(), deviceId: z.string().optional() }).strict(),
    label: z.string() }).strict().nullable(),
  step: z.string().nullable(), exitCode: z.number().int().nullable(), message: z.string().nullable(),
  queuedAt: TimestampSchema, startedAt: TimestampSchema.nullable(), finishedAt: TimestampSchema.nullable(),
  initiator: z.object({ principalId: IdSchema, executionId: IdSchema.nullable() }).strict(),
}).strict()
export type CiRunRecord = z.infer<typeof CiRunRecordSchema>
