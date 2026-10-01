import { z } from 'zod'
import { ExecutionResultSchema } from './index.js'
import { DispatchIntentSchema, OwnerControlSchema, PlacementDigestSchema } from './nodePlacement.js'
import { DeviceConnectionIdentitySchema } from './deviceIdentity.js'

export const RemoteOperationPhaseSchema = z.enum(['received', 'native_entry_attempted', 'start_acknowledged', 'running', 'stop_requested', 'confirmed_terminal', 'uncertain'])
export const RemoteNativeIdentitySchema = z.object({
  sessionId: z.string().min(1), turnId: z.string().min(1).optional(),
  processIdentityDigest: PlacementDigestSchema,
}).strict()
export type RemoteNativeIdentity = z.infer<typeof RemoteNativeIdentitySchema>
export const RemoteOwnerControlSchema = OwnerControlSchema.extend({
  native: RemoteNativeIdentitySchema.optional(),
}).superRefine((value, context) => {
  if (value.action.kind === 'respond' && !value.native?.turnId) context.addIssue({ code: 'custom', message: 'Respond requires the exact native session and turn.' })
})
export type RemoteOwnerControl = z.infer<typeof RemoteOwnerControlSchema>
export const RemoteTerminalEvidenceSchema = z.object({
  kind: z.enum(['completed', 'cancelled', 'not_started', 'failed']),
  /** W11/provider recovery attestation, never PID absence or a missed heartbeat. */
  closureEvidenceDigest: PlacementDigestSchema,
  resultDigest: PlacementDigestSchema.optional(),
  result: z.lazy(() => ExecutionResultSchema).optional(), artifactDigests: z.array(PlacementDigestSchema).max(128).optional(),
}).strict()
export type RemoteTerminalEvidence = z.infer<typeof RemoteTerminalEvidenceSchema>
export const RemoteInteractionTargetSchema = z.object({ interactionId: z.string().min(1), interactionRevision: z.string().regex(/^[1-9][0-9]*$/), nativeInteractionId: z.string().min(1), native: RemoteNativeIdentitySchema }).strict()
export type RemoteInteractionTarget = z.infer<typeof RemoteInteractionTargetSchema>
export const RemoteOperationReceiptSchema = z.object({
  schemaVersion: z.literal(1), intent: DispatchIntentSchema,
  connection: DeviceConnectionIdentitySchema, workerIncarnationId: z.uuid(),
  sequence: z.number().int().positive(), phase: RemoteOperationPhaseSchema,
  interaction: RemoteInteractionTargetSchema.optional(), native: RemoteNativeIdentitySchema.optional(), terminal: RemoteTerminalEvidenceSchema.optional(),
  entryAttempted: z.boolean(), turnEntryAttempted: z.boolean(), turnInput: z.object({ correlationId: z.string().min(1), promptDigest: PlacementDigestSchema }).strict().optional(), stopFence: z.boolean(), controls: z.array(RemoteOwnerControlSchema).max(128),
  uncertainty: z.string().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.native && !value.entryAttempted) context.addIssue({ code: 'custom', message: 'Native evidence requires an entry reservation.' })
  if ((value.phase === 'confirmed_terminal') !== (value.terminal !== undefined)) context.addIssue({ code: 'custom', message: 'Terminal phase requires exact closure evidence.' })
  if (['start_acknowledged', 'running'].includes(value.phase) && !value.native) context.addIssue({ code: 'custom', message: 'Acknowledged/running requires native ownership.' })
})
export type RemoteOperationReceipt = z.infer<typeof RemoteOperationReceiptSchema>
export type RemoteOperationStatus = { status: 'known'; receipt: RemoteOperationReceipt }
  | { status: 'unknown'; reason: 'journal_absence_requires_reconciliation' }
/** Grant renewal is for this original physical execution, never another start. */
export const RemoteOwnerReconciliationSchema = z.object({
  commandId: z.string().min(1), operationId: z.string().min(1),
  previousOwner: z.object({ grantId: z.string().min(1), epoch: z.string().regex(/^[1-9][0-9]*$/) }).strict(),
  nextOwner: z.object({ grantId: z.string().min(1), epoch: z.string().regex(/^[1-9][0-9]*$/) }).strict(),
  native: RemoteNativeIdentitySchema, evidenceDigest: PlacementDigestSchema,
}).strict()
export type RemoteOwnerReconciliation = z.infer<typeof RemoteOwnerReconciliationSchema>
