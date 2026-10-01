import { z } from 'zod'
import { NativeSessionReferenceSchema, NativeHarnessEventSchema, PendingNativeInteractionSchema,
  ExecutionResultSchema, AgentHarnessSchema, ApprovalResponseSemanticSchema } from './index.js'
import { NativeMessageSubmissionSchema } from './claude.js'
import { PlacementDigestSchema } from './nodePlacement.js'
import { RemoteOperationReceiptSchema } from './remoteExecution.js'
import { SourceMaterializationRecordSchema, VerifiedSourceWorkingTreeSchema, SourceCwdAttestationSchema } from './sourceAdmission.js'

const ProcessIdentitySchema = z.object({ pid: z.number().int().safe().gt(1), startTicks: z.string().regex(/^\d+$/) }).strict()
/** Internal original registry identities only; never a public process DTO. */
export const RemoteNativeLaunchObservationSchema = z.object({ owner: z.string().min(1).max(4096), launchId: z.uuid(), bootId: z.string().min(1),
  guardian: ProcessIdentitySchema, provider: ProcessIdentitySchema,
  boundary: z.object({ kind: z.literal('cgroup-v2'), path: z.string().startsWith('/'), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict(),
  lifecycle: z.enum(['active', 'ended', 'closure-unconfirmed', 'closed']),
  closureEvidence: z.enum(['linux_boot_changed', 'native_not_started', 'cgroup_v2_empty']).optional(),
}).strict()
export const RemoteRuntimeLeafAttestationSchema = z.object({ executionId: z.string().min(1), attemptId: z.string().min(1),
  operationId: z.string().min(1), bindingHash: PlacementDigestSchema, canonicalRuntimeDirectory: z.string().startsWith('/'),
  directoryIdentityHash: PlacementDigestSchema, materializationId: z.string().min(1), materializationDigest: PlacementDigestSchema }).strict()
/** The same bounded real NativeHistory contract used by the native proxy. */
export const RemoteNativeHistorySchema = z.object({ nativeSubmission: z.lazy(() => NativeMessageSubmissionSchema).optional(),
  correlationId: z.string().optional(), nativeTurnId: z.string().optional(), nativeMessageId: z.string().optional(), nextCursor: z.string().optional(),
  firstRetainedSequence: z.number().int().nonnegative().optional(), nextSequence: z.number().int().nonnegative().optional(),
  events: z.array(z.lazy(() => NativeHarnessEventSchema)).max(1024), pendingInteractions: z.array(z.lazy(() => PendingNativeInteractionSchema)).max(128),
  pendingInteraction: z.lazy(() => PendingNativeInteractionSchema).optional(), terminalResult: z.lazy(() => ExecutionResultSchema).optional(),
  terminalTurn: z.object({ correlationId: z.string(), providerId: z.string(), result: z.lazy(() => ExecutionResultSchema) }).strict().optional(),
  interactionDeliveries: z.array(z.object({ nativeRequestId: z.string(), state: z.enum(['pending','submitting','submitted','uncertain']), selectedOptionId: z.string().optional() }).strict()).max(128).optional(),
  responseDeliveries: z.array(z.object({ source: z.enum(['provider_acknowledgement','provider_history']), harness: z.lazy(() => AgentHarnessSchema),
    providerVersion: z.string(), nativeSessionId: z.string(), nativeRequestId: z.string(), nativeRequestType: z.string(), optionId: z.string(),
    semantic: z.lazy(() => ApprovalResponseSemanticSchema) }).strict()).max(128).optional(), canceledRequestIds: z.array(z.string()).max(128).optional(),
}).strict()
export const RemoteWorkflowPhysicalReadoutSchema = z.object({ version: z.literal(1), expiresAt: z.string().datetime(), receipt: RemoteOperationReceiptSchema,
  session: z.lazy(() => NativeSessionReferenceSchema), launch: RemoteNativeLaunchObservationSchema,
  observation: RemoteNativeLaunchObservationSchema, runtimeLeaf: RemoteRuntimeLeafAttestationSchema,
  source: z.object({ record: SourceMaterializationRecordSchema, workingTree: VerifiedSourceWorkingTreeSchema.extend({ cwdAttestation: SourceCwdAttestationSchema }) }).strict(),
  history: RemoteNativeHistorySchema.optional(),
  closure: z.object({ ownerClosed: z.literal(true), launch: RemoteNativeLaunchObservationSchema }).strict().optional(),
  output: z.object({ kind: z.literal('text-only'), result: z.lazy(() => ExecutionResultSchema).superRefine((value,context) => {
    if (value.output !== undefined && !z.object({ text: z.string() }).strict().safeParse(value.output).success)
      context.addIssue({ code: 'custom', message: 'Only the actual provider text-only result can attest zero result artifacts.' })
  }) }).strict().optional(),
}).strict()
export type RemoteWorkflowPhysicalReadout = z.infer<typeof RemoteWorkflowPhysicalReadoutSchema>
