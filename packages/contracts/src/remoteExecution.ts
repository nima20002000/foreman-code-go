import { z } from 'zod'
import { DispatchIntentSchema, OwnerControlSchema, PlacementDigestSchema } from './nodePlacement.js'
import { DeviceConnectionIdentitySchema } from './deviceIdentity.js'

export const RemoteOperationPhaseSchema = z.enum(['received', 'native_entry_attempted', 'start_acknowledged', 'running', 'stop_requested', 'confirmed_terminal', 'uncertain'])
export const RemoteNativeIdentitySchema = z.object({
  sessionId: z.string().min(1), turnId: z.string().min(1),
  processIdentityDigest: PlacementDigestSchema,
}).strict()
export type RemoteNativeIdentity = z.infer<typeof RemoteNativeIdentitySchema>
export const RemoteOwnerControlSchema = OwnerControlSchema.extend({
  native: RemoteNativeIdentitySchema.optional(),
}).superRefine((value, context) => {
  if (value.action.kind === 'respond' && !value.native) context.addIssue({ code: 'custom', message: 'Respond requires the exact native session and turn.' })
})
export type RemoteOwnerControl = z.infer<typeof RemoteOwnerControlSchema>
export const RemoteTerminalEvidenceSchema = z.object({
  kind: z.enum(['completed', 'cancelled', 'not_started', 'failed']),
  /** W11/provider recovery attestation, never PID absence or a missed heartbeat. */
  closureEvidenceDigest: PlacementDigestSchema,
  resultDigest: PlacementDigestSchema.optional(),
}).strict()
export type RemoteTerminalEvidence = z.infer<typeof RemoteTerminalEvidenceSchema>
export const RemoteOperationReceiptSchema = z.object({
  schemaVersion: z.literal(1), intent: DispatchIntentSchema,
  connection: DeviceConnectionIdentitySchema, workerIncarnationId: z.uuid(),
  sequence: z.number().int().positive(), phase: RemoteOperationPhaseSchema,
  native: RemoteNativeIdentitySchema.optional(), terminal: RemoteTerminalEvidenceSchema.optional(),
  entryAttempted: z.boolean(), stopFence: z.boolean(), controls: z.array(RemoteOwnerControlSchema).max(128),
  uncertainty: z.string().max(500).optional(),
}).strict()
export type RemoteOperationReceipt = z.infer<typeof RemoteOperationReceiptSchema>
export type RemoteOperationStatus = { status: 'known'; receipt: RemoteOperationReceipt }
  | { status: 'unknown'; reason: 'journal_absence_requires_reconciliation' }
/** Grant renewal is for this original physical execution, never another start. */
export interface RemoteOwnerReconciliation {
  commandId: string
  operationId: string
  previousOwner: { grantId: string; epoch: string }
  nextOwner: { grantId: string; epoch: string }
  native: RemoteNativeIdentity
  evidenceDigest: string
}
