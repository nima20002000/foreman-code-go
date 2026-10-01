import { z } from 'zod'
import { DeviceConnectionIdentitySchema } from './deviceIdentity.js'
import { GraphIdSchema, IdSchema } from './schemaPrimitives.js'

/** v0 interface checkpoint uses wire version 1; unknown versions fail closed. */
export const PLACEMENT_CONTRACT_VERSION = 1 as const
export const PlacementDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const Revision = z.string().regex(/^[1-9][0-9]*$/)
export const MachineReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main'), mainId: z.uuid() }).strict(),
  z.object({ kind: z.literal('device'), mainId: z.uuid(), deviceId: z.uuid() }).strict(),
])
export const SavedNodePlacementSchema = z.object({
  schemaVersion: z.literal(1), hostRef: MachineReferenceSchema,
  rootPolicyId: IdSchema, rootPolicyRevision: Revision, locationRevision: Revision,
  projectRoot: z.string().min(1), cwdPolicy: z.enum(['project-root', 'project-subdirectory']),
  relativeCwd: z.string(), instanceId: IdSchema, instanceRevision: IdSchema,
  harnessInstallationId: IdSchema,
}).strict()
export type SavedNodePlacement = z.infer<typeof SavedNodePlacementSchema>
export const AcceptedDestinationSchema = z.object({
  canonicalProjectRoot: z.string().startsWith('/'), canonicalCwd: z.string().startsWith('/'),
  managedRuntimeRoot: z.string().startsWith('/'), directoryIdentityHash: PlacementDigestSchema,
  rootPolicyId: IdSchema, rootPolicyRevision: Revision, locationRevision: Revision,
  attestationId: IdSchema, attestationHash: PlacementDigestSchema,
}).strict()
const AgentPayload = z.object({
  kind: z.literal('agent'), agentId: IdSchema, agentConfigurationVersionId: IdSchema,
  driverId: IdSchema, driverRevision: IdSchema, instanceId: IdSchema, instanceRevision: IdSchema,
  harnessInstallationId: IdSchema, installationFingerprint: IdSchema,
  runtimeContractVersion: z.literal(1), protocolRevision: IdSchema,
  credentialScopeRefs: z.array(IdSchema),
}).strict()
const JobPayload = z.object({
  kind: z.literal('job'), jobConfigurationVersionId: IdSchema, scriptDigest: PlacementDigestSchema,
  argv: z.array(z.string()), environmentScopeRefs: z.array(IdSchema),
  isolationPolicyId: IdSchema, outputSpecDigest: PlacementDigestSchema,
}).strict()
export const AcceptedNodePlacementSchema = z.object({
  schemaVersion: z.literal(1), mainId: z.uuid(), runId: IdSchema, nodeId: GraphIdSchema,
  hostRef: MachineReferenceSchema, labelAtAcceptance: z.string().min(1).optional(),
  /** null only for original main-local installation; never invent device evidence. */
  registration: z.object({ workerInstallationId: z.uuid(), keyRevision: z.number().int().positive(),
    authorizationRevision: z.number().int().positive() }).strict().nullable(),
  mainInstallationId: IdSchema, destination: AcceptedDestinationSchema,
  source: z.object({ revisionId: IdSchema, manifestDigest: PlacementDigestSchema,
    materializationId: IdSchema, materializationDigest: PlacementDigestSchema }).strict(),
  payload: z.discriminatedUnion('kind', [AgentPayload, JobPayload]), bindingHash: PlacementDigestSchema,
}).strict().superRefine((value, context) => {
  if (value.mainId !== value.hostRef.mainId || (value.hostRef.kind === 'device') !== (value.registration !== null)) {
    context.addIssue({ code: 'custom', message: 'Placement main/registration identity mismatch.' })
  }
})
export type AcceptedNodePlacement = z.infer<typeof AcceptedNodePlacementSchema>
export const DispatchIntentSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.literal(1), mainId: z.uuid(), runId: IdSchema,
  nodeId: GraphIdSchema, executionId: IdSchema, occurrenceId: IdSchema,
  occurrenceIndex: z.number().int().nonnegative(), attemptId: IdSchema, operationId: IdSchema,
  bindingHash: PlacementDigestSchema, inputDigest: PlacementDigestSchema,
  owner: z.object({ grantId: IdSchema, epoch: Revision }).strict(),
}).strict()
export type DispatchIntent = z.infer<typeof DispatchIntentSchema>
export const PlacementStatusSchema = z.enum(['unavailable', 'revoked', 'placement_conflict', 'acknowledgment_unknown', 'recovery_required'])
export const WorkerObservationSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.literal(1), operationId: IdSchema,
  attemptId: IdSchema, executionId: IdSchema, bindingHash: PlacementDigestSchema,
  connection: DeviceConnectionIdentitySchema, workerIncarnationId: z.uuid(), sequence: Revision,
  phase: z.enum(['accepted', 'entered', 'running', 'terminal']),
  native: z.object({ processId: z.number().int().positive().optional(), processStartedAt: z.string().datetime().optional(),
    sessionId: IdSchema.optional(), turnId: IdSchema.optional(), containerId: IdSchema.optional(),
    exitCode: z.number().int().optional() }).strict().optional(),
  resultDigest: PlacementDigestSchema.optional(), artifactDigests: z.array(PlacementDigestSchema),
}).strict()
export type WorkerObservation = z.infer<typeof WorkerObservationSchema>
export const OwnerControlSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.literal(1), commandId: IdSchema,
  operationId: IdSchema, attemptId: IdSchema, executionId: IdSchema, bindingHash: PlacementDigestSchema,
  owner: z.object({ grantId: IdSchema, epoch: Revision }).strict(),
  action: z.discriminatedUnion('kind', [z.object({ kind: z.literal('stop') }).strict(),
    z.object({ kind: z.literal('respond'), interactionId: IdSchema, interactionRevision: Revision,
      nativeInteractionId: IdSchema, response: z.json() }).strict()]),
}).strict()
export type OwnerControl = z.infer<typeof OwnerControlSchema>
/** A read projection never infers observed execution from an accepted placement. */
export const NodePlacementReadbackSchema = z.discriminatedUnion('evidence', [
  z.object({ evidence: z.literal('accepted'), placement: AcceptedNodePlacementSchema,
    observations: z.array(WorkerObservationSchema) }).strict(),
  z.object({ evidence: z.literal('legacy_missing'), originalMainInstallationId: IdSchema.nullable() }).strict(),
])
export interface PlacementDispatchPort {
  deliver(intent: DispatchIntent, placement: AcceptedNodePlacement): Promise<void>
  reconcile(intent: DispatchIntent, placement: AcceptedNodePlacement): Promise<WorkerObservation | null>
  control(command: OwnerControl, placement: AcceptedNodePlacement): Promise<void>
}
