import { z } from 'zod'
import { JobExecutionSchema, JobLogChunkSchema, type JobExecution } from './jobs.js'
import { MachineReferenceSchema, PlacementDigestSchema } from './nodePlacement.js'
import { DeviceConnectionIdentitySchema } from './deviceIdentity.js'
import { RemoteOperationPhaseSchema } from './remoteExecution.js'

/** New job envelopes use genuine subjects; existing workflow dispatch contracts are unchanged. */
export const RemoteExecutionSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workflow-node'), workspaceId: z.string().min(1), workflowId: z.string().min(1),
    runId: z.string().min(1), nodeId: z.string().min(1), nodeExecutionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('manual-job'), workspaceId: z.string().min(1), jobExecutionId: z.string().min(1), definitionId: z.string().min(1) }).strict(),
])
export type RemoteExecutionSubject = z.infer<typeof RemoteExecutionSubjectSchema>
export const RemoteJobDispatchIntentSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.literal(1), mainId: z.uuid(), subject: RemoteExecutionSubjectSchema,
  executionId: z.string().min(1), attemptId: z.string().min(1), operationId: z.string().min(1),
  bindingHash: PlacementDigestSchema, inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  owner: z.object({ grantId: z.string().min(1), epoch: z.string().regex(/^[1-9][0-9]*$/) }).strict(),
}).strict().superRefine((intent, context) => {
  if (intent.subject.kind === 'manual-job' && intent.subject.jobExecutionId !== intent.executionId) context.addIssue({ code: 'custom', message: 'Manual job subject must name its actual execution.' })
})
export type RemoteJobDispatchIntent = z.infer<typeof RemoteJobDispatchIntentSchema>
export const RemoteJobNativeIdentitySchema = z.object({
  containerId: z.string().min(1), supervisorIdentity: z.string().min(1), processIdentityDigest: PlacementDigestSchema, startedAt: z.string().datetime().optional(),
}).strict()
export type RemoteJobNativeIdentity = z.infer<typeof RemoteJobNativeIdentitySchema>
export const RemoteJobOwnerControlSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.literal(1), commandId: z.string().min(1),
  operationId: z.string().min(1), attemptId: z.string().min(1), executionId: z.string().min(1), bindingHash: PlacementDigestSchema,
  subject: RemoteExecutionSubjectSchema, owner: RemoteJobDispatchIntentSchema.shape.owner,
  action: z.object({ kind: z.literal('stop') }).strict(), native: RemoteJobNativeIdentitySchema.optional(),
}).strict()
export type RemoteJobOwnerControl = z.infer<typeof RemoteJobOwnerControlSchema>
export const RemoteJobTerminalEvidenceSchema = z.object({
  finishedAt: z.string().datetime(), closureEvidenceDigest: PlacementDigestSchema, outcome: z.enum(['succeeded','build_failed','spawn_failed','preparation_failed','cancelled','timed_out']),
  exitCode: z.number().int().nullable(), signal: z.string().nullable(), processStopped: z.literal(true),
  resultDigest: PlacementDigestSchema, logGapPossible: z.boolean(), logsTruncated: z.boolean(),
  outputCollectionError: z.boolean(), artifactDigests: z.array(PlacementDigestSchema).max(128),
}).strict()
export type RemoteJobTerminalEvidence = z.infer<typeof RemoteJobTerminalEvidenceSchema>
export const RemoteJobConnectionIdentitySchema = z.union([DeviceConnectionIdentitySchema, z.object({ kind: z.literal('main'), mainId: z.uuid(), mainInstallationId: z.string().min(1), bootId: z.uuid() }).strict()])
export type RemoteJobConnectionIdentity = z.infer<typeof RemoteJobConnectionIdentitySchema>
export const RemoteJobOperationReceiptSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('job'), intent: RemoteJobDispatchIntentSchema, execution: z.lazy(() => JobExecutionSchema),
  connection: RemoteJobConnectionIdentitySchema, workerIncarnationId: z.uuid(), sequence: z.number().int().positive(), observedAt: z.string().datetime(), phase: RemoteOperationPhaseSchema,
  entryAttempted: z.boolean(), stopFence: z.boolean(), native: RemoteJobNativeIdentitySchema.optional(),
  controls: z.array(RemoteJobOwnerControlSchema).max(128), terminal: RemoteJobTerminalEvidenceSchema.optional(), publication: z.enum(['pending','process_recorded','collecting','complete','failed']), uncertainty: z.string().max(500).optional(),
}).strict()
export type RemoteJobOperationReceipt = z.infer<typeof RemoteJobOperationReceiptSchema>
export type RemoteJobOperationStatus = { status: 'known'; receipt: RemoteJobOperationReceipt } | { status: 'unknown'; reason: 'journal_absence_requires_reconciliation' }
export interface RemoteJobDispatchPort {
  deliver(intent: RemoteJobDispatchIntent, execution: JobExecution): Promise<RemoteJobOperationStatus>
  reconcile(intent: RemoteJobDispatchIntent): Promise<RemoteJobOperationStatus>
  control(command: RemoteJobOwnerControl): Promise<RemoteJobOperationStatus>
}
/** Host facts for job dispatch are CI's AcceptedJobSpec.target, never a fabricated node placement. */
export const RemoteJobHostReferenceSchema = MachineReferenceSchema

export const RemoteJobExecutionRpcRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('job-dispatch'), intent: RemoteJobDispatchIntentSchema, execution: z.lazy(() => JobExecutionSchema) }).strict(),
  z.object({ method: z.literal('job-status'), intent: RemoteJobDispatchIntentSchema }).strict(),
  z.object({ method: z.literal('job-control'), intent: RemoteJobDispatchIntentSchema, command: RemoteJobOwnerControlSchema }).strict(),
])

export const RemoteJobMainRpcRequestSchema = z.discriminatedUnion('method', [
 z.object({ method: z.literal('job-report'), receipt: RemoteJobOperationReceiptSchema }).strict(),
 z.object({ method: z.literal('job-log'), intent: RemoteJobDispatchIntentSchema, chunk: JobLogChunkSchema }).strict(),
 z.object({ method: z.literal('job-authorize'), intent: RemoteJobDispatchIntentSchema, action: z.enum(['start','read','control','publish']) }).strict(),
])
