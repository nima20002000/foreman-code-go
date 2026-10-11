import { z } from 'zod'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'
import { exclusiveIntegrationFiles, requirements } from './integrationScheduling.mjs'

/** Host CI: a build computer runs a suite directly in a git worktree of the commit, like a self-hosted runner.
 * It fetches with its own GitHub CLI login and installs packages normally; a systemd unit caps CPU and memory. */
export const CI_HOST_NAMESPACE = 'ci-host-v1'

export const CiSuiteSchema = z.enum(['install', 'typecheck', 'lint', 'unit', 'build', 'integration'])
export type CiSuite = z.infer<typeof CiSuiteSchema>
export const CiPartSchema = z.enum(['unit-api', 'unit-web', 'unit-web-heavy', 'unit-other',
  'lint-api', 'lint-other', 'typecheck-api', 'typecheck-other', 'build-api', 'build-other'])
export type CiPart = z.infer<typeof CiPartSchema>
export type CiExecutionSuite = CiSuite | CiPart
export function validCiPart(value: { suite: CiSuite; part?: CiPart | null | undefined; partition?: CiPartition | null | undefined }) {
  if (!value.part) return !value.partition || value.suite === 'integration'
  if (!value.part.startsWith(`${value.suite}-`)) return false
  return !value.partition || value.part === 'unit-api' || value.part === 'unit-web'
}
export const CiScopeSchema = z.enum(['affected', 'full'])
export type CiScope = z.infer<typeof CiScopeSchema>
export const CiSelectedFilesSchema = z.array(z.string().min(1).max(300)
  .regex(/^(?:apps\/(?:api|web|worker)|packages\/contracts|scripts)\/[A-Za-z0-9_./-]+$/)
  .refine(file => !file.split('/').some(part => part === '..' || part === '.' || part === ''))).max(2000)

export function validCiSelection(value: { suite: CiSuite; scope?: CiScope | undefined; files?: string[] | undefined }) {
  if (value.scope !== 'affected') return !value.files?.length
  if (!value.files || !['unit', 'integration', 'typecheck', 'lint'].includes(value.suite)) return false
  if (value.suite === 'integration') return value.files.every(file => /^apps\/api\/test\/[^/]+\.integration\.test\.ts$/.test(file))
  if (value.suite === 'unit') return value.files.every(file => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
    && !(file.startsWith('apps/api/') && /\.(?:integration|acceptance)\.test\.ts$/.test(file)))
  return value.files.every(file => /\.[cm]?[jt]sx?$/.test(file) && !file.startsWith('scripts/'))
}
const CommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
export const CiRepositorySchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
/** `weights` gives each slice's relative speed (its computer's measured throughput), so slices finish together. */
export const CiPartitionSchema = z.object({ index: z.number().int().nonnegative(), count: z.number().int().min(2).max(32),
  weights: z.array(z.number().positive().finite()).optional() }).strict()
  .refine(value => value.index < value.count, 'The partition index must be below its count.')
  .refine(value => !value.weights || value.weights.length === value.count, 'Give one weight per partition.')
export type CiPartition = z.infer<typeof CiPartitionSchema>

/** Test file -> wall milliseconds. Bounded so a start request or read reply stays far below the device
 * channel's 1 MiB message limit. */
export const CiDurationsSchema = z.record(z.string().min(1).max(300), z.number().positive().finite().max(24 * 3_600_000))
  .refine(value => Object.keys(value).length <= 1000, 'Give at most 1000 file durations.')
export type CiDurations = z.infer<typeof CiDurationsSchema>

export const CiHostRunIdSchema = z.uuid()
/** `durations` are Main's learned integration file durations; the commit's committed durations fill the gaps. */
export const CiHostStartSchema = z.object({
  operation: z.literal('start'), runId: CiHostRunIdSchema, repository: CiRepositorySchema, commit: CommitSchema,
  suite: CiSuiteSchema, part: CiPartSchema.optional(), partition: CiPartitionSchema.optional(), durations: CiDurationsSchema.optional(),
  scope: CiScopeSchema.optional(), files: CiSelectedFilesSchema.optional(),
}).strict().refine(validCiSelection, 'Affected scope requires selected files for a supported suite; full scope runs all files.')
  .refine(validCiPart, 'The part and partition must belong to the requested suite.')
export const CiHostRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  CiHostStartSchema,
  // `durations: true` asks a finished test run for the file durations it measured.
  z.object({ operation: z.literal('read'), runId: CiHostRunIdSchema, afterOffset: z.number().int().nonnegative(),
    maxBytes: z.number().int().min(1).max(65_536), durations: z.boolean().optional() }).strict(),
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
  z.object({ operation: z.literal('read'), run: CiHostRunSchema, text: z.string(), nextOffset: z.number().int().nonnegative(),
    durations: CiDurationsSchema.optional() }).strict(),
  z.object({ operation: z.literal('cancel'), run: CiHostRunSchema }).strict(),
])
export type CiHostReply = z.infer<typeof CiHostReplySchema>

/** Spread capability-dependent and host-exclusive files before balancing the remaining durations by computer speed.
 * Files without a recorded duration count as the median. */
export function integrationPartition(files: readonly string[], durations: Readonly<Record<string, number>>,
  partition: CiPartition): string[] {
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
  const known = files.map(file => durations[file]).filter(valid).sort((a, b) => a - b)
  const fallback = known.length ? known[Math.floor(known.length / 2)]! : 1
  const weight = (file: string) => valid(durations[file]) ? durations[file] : fallback
  const loads = Array<number>(partition.count).fill(0)
  const speed = (index: number) => partition.weights?.[index] ?? 1
  const owner = new Map<string, number>()
  const heavy = new Set([...requirements.keys(), ...exclusiveIntegrationFiles])
  const heavyCounts = Array<number>(partition.count).fill(0)
  const ordered = [...files].sort((left, right) => Number(heavy.has(right)) - Number(heavy.has(left))
    || weight(right) - weight(left) || (left < right ? -1 : 1))
  for (const file of ordered) {
    // Heavy files use each partition once per round before host speed breaks ties.
    const isHeavy = heavy.has(file)
    let lightest = 0
    const finish = (index: number) => (loads[index]! + weight(file)) / speed(index)
    for (let index = 1; index < loads.length; index++) {
      const fewerHeavy = isHeavy && heavyCounts[index]! < heavyCounts[lightest]!
      const sameHeavy = !isHeavy || heavyCounts[index] === heavyCounts[lightest]
      if (fewerHeavy || (sameHeavy && finish(index) < finish(lightest))) lightest = index
    }
    if (isHeavy) heavyCounts[lightest]!++
    loads[lightest]! += weight(file)
    owner.set(file, lightest)
  }
  return files.filter(file => owner.get(file) === partition.index)
}

/** What an Agent or the Operator sees for one CI run. */
export const CiRunRecordSchema = z.object({
  id: CiHostRunIdSchema, workspaceId: IdSchema, suite: CiSuiteSchema, commit: CommitSchema, repository: CiRepositorySchema,
  scope: CiScopeSchema.default('full'), files: CiSelectedFilesSchema.default([]),
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
}).strict().refine(validCiPart, 'The part and partition must belong to the requested suite.')
export type CiRunRecord = z.infer<typeof CiRunRecordSchema>
