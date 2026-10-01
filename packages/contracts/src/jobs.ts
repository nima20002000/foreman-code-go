import { z } from 'zod'
import { AcceptedNodePlacementSchema, PlacementDigestSchema } from './nodePlacement.js'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'

export const JOB_CONTRACT_VERSION = 1 as const
const Revision = z.number().int().positive()
const RelativePath = z.string().min(1).max(1024).refine(path =>
  !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.' || part === '') && !path.includes('\\') && !path.includes('\0'), 'Expected a bounded relative path.')
export const JobSourceSchema = z.object({
  approvedSourceId: z.uuid(), snapshotId: z.uuid(), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  manifestDigest: PlacementDigestSchema, materializationId: z.uuid(), materializationDigest: PlacementDigestSchema,
}).strict()
export const JobInputRevisionSchema = z.object({
  fileId: IdSchema, revisionId: IdSchema, sha256: PlacementDigestSchema, byteSize: z.number().int().nonnegative(),
}).strict()
export const JobPolicySchema = z.object({
  isolationPolicyId: IdSchema, isolationPolicyRevision: Revision, imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  toolchainDigest: PlacementDigestSchema, environmentScopeRefs: z.array(IdSchema).max(32),
  network: z.enum(['none', 'approved-dependency-fetch']),
  queueTimeoutMs: z.number().int().positive(), preparationTimeoutMs: z.number().int().positive(), executionTimeoutMs: z.number().int().positive(),
  cancellationGraceMs: z.number().int().nonnegative(), maxLogChunkBytes: z.number().int().positive().max(65536),
  maxLogBytes: z.number().int().positive(), maxWorkerSpoolBytes: z.number().int().positive(),
  logOverflow: z.enum(['stop', 'explicit-truncation']), maxOutputBytes: z.number().int().positive(), retentionSeconds: z.number().int().positive(),
}).strict()
export const JobOutputSpecSchema = z.object({
  path: RelativePath, required: z.boolean(), mediaType: z.enum(['text/plain', 'application/json', 'text/html', 'application/zip', 'application/gzip', 'application/octet-stream']),
}).strict()
/** Job targets reuse W08 identity/root binding without inventing a Run or Agent. */
export const JobTargetSchema = AcceptedNodePlacementSchema.omit({ runId: true, nodeId: true, payload: true, source: true, bindingHash: true })
export const JobDefinitionSpecSchema = z.object({
  source: JobSourceSchema, target: JobTargetSchema, argv: z.array(z.string().max(8192)).min(1).max(128),
  relativeCwd: RelativePath.optional(), inputs: z.array(JobInputRevisionSchema).max(128),
  policy: JobPolicySchema, outputs: z.array(JobOutputSpecSchema).max(64),
}).strict()
export const JobDefinitionSchema = z.object({
  schemaVersion: z.literal(1), id: IdSchema, workspaceId: IdSchema, name: z.string().trim().min(1).max(200),
  revision: Revision, versionId: IdSchema, spec: JobDefinitionSpecSchema, createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict()
export const JobDefinitionSaveSchema = z.object({
  commandId: IdSchema, id: IdSchema.optional(), expectedRevision: Revision.nullable(), name: z.string().trim().min(1).max(200), spec: JobDefinitionSpecSchema,
}).strict()
export const JobStartSchema = z.object({ commandId: IdSchema, definitionId: IdSchema, expectedRevision: Revision }).strict()
export const AcceptedJobSpecSchema = JobDefinitionSpecSchema.extend({
  definitionId: IdSchema, definitionRevision: Revision, definitionVersionId: IdSchema,
  scriptDigest: PlacementDigestSchema, outputSpecDigest: PlacementDigestSchema, specDigest: PlacementDigestSchema, bindingHash: PlacementDigestSchema,
}).strict()
export const JobProcessStateSchema = z.object({
  phase: z.enum(['queued', 'preparing', 'running', 'terminal']),
  outcome: z.enum(['succeeded', 'build_failed', 'cancelled', 'timed_out', 'preparation_failed']).nullable(),
  exitCode: z.number().int().nullable(), signal: z.string().nullable(), processStopped: z.boolean(),
}).strict()
export const JobExecutionSchema = z.object({
  schemaVersion: z.literal(1), id: IdSchema, workspaceId: IdSchema, acceptedSpec: AcceptedJobSpecSchema,
  operationId: IdSchema, attemptId: IdSchema, owner: z.object({ grantId: IdSchema, epoch: z.string().regex(/^[1-9][0-9]*$/) }).strict(),
  workflow: z.object({ runId: IdSchema, nodeId: IdSchema, nodeExecutionId: IdSchema }).strict().nullable(),
  process: JobProcessStateSchema, transport: z.enum(['connected', 'offline', 'unknown']),
  publication: z.enum(['pending', 'collecting', 'complete', 'failed', 'expired']),
  cancelRequestedAt: TimestampSchema.nullable(), createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict()
export const JobLogChunkSchema = z.object({
  executionId: IdSchema, attemptId: IdSchema, sequence: z.number().int().positive(), stream: z.enum(['stdout', 'stderr']),
  text: z.string().max(65536), byteSize: z.number().int().nonnegative().max(65536), createdAt: TimestampSchema,
}).strict()
export const JobLogPageSchema = z.object({
  chunks: z.array(JobLogChunkSchema), nextCursor: z.number().int().nonnegative(),
  truncated: z.boolean(), gap: z.object({ from: z.number().int().positive(), to: z.number().int().positive() }).strict().nullable(),
}).strict()
export const JobArtifactSchema = JobInputRevisionSchema.extend({
  executionId: IdSchema, publicationId: IdSchema, path: RelativePath, mediaType: z.string(), state: z.enum(['available', 'expired', 'tombstoned']),
}).strict()
export const JobValidationSchema = z.object({ valid: z.boolean(), reasons: z.array(z.string()), sideEffects: z.literal(false) }).strict()
export type JobDefinition = z.infer<typeof JobDefinitionSchema>
export type JobDefinitionSpec = z.infer<typeof JobDefinitionSpecSchema>
export type JobDefinitionSave = z.infer<typeof JobDefinitionSaveSchema>
export type JobStart = z.infer<typeof JobStartSchema>
export type AcceptedJobSpec = z.infer<typeof AcceptedJobSpecSchema>
export type JobExecution = z.infer<typeof JobExecutionSchema>
export type JobLogChunk = z.infer<typeof JobLogChunkSchema>
export type JobLogPage = z.infer<typeof JobLogPageSchema>
export type JobArtifact = z.infer<typeof JobArtifactSchema>
export type JobValidation = z.infer<typeof JobValidationSchema>
/** HTTP, MCP and workflow admission share this authority boundary. */
export interface JobsService {
  listDefinitions(workspaceId: string): Promise<JobDefinition[]>
  getDefinition(workspaceId: string, id: string): Promise<JobDefinition>
  saveDefinition(workspaceId: string, input: JobDefinitionSave): Promise<JobDefinition>
  validate(workspaceId: string, spec: JobDefinitionSpec): Promise<JobValidation>
  start(workspaceId: string, input: JobStart): Promise<JobExecution>
  getExecution(workspaceId: string, id: string): Promise<JobExecution>
  listExecutions(workspaceId: string): Promise<JobExecution[]>
  cancel(workspaceId: string, id: string, commandId: string): Promise<JobExecution>
  readLogs(workspaceId: string, id: string, afterSequence: number, limit: number): Promise<JobLogPage>
  listArtifacts(workspaceId: string, id: string): Promise<JobArtifact[]>
}
