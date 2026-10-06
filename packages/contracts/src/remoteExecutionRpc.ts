import { CompactionStateSchema, SessionModeSchema, SessionPreferencesSchema } from './sessionControls.js'
import { RemoteNativeIdentitySchema } from './remoteExecution.js'
import { z } from 'zod'
import { DeviceExecutionAdmissionFields } from './deviceResources.js'
import { AgentConfigurationVersionSchema, HarnessExecutionRequestSchema, ApprovalResponseOptionSchema, NativeSessionReferenceSchema } from './index.js'
import { NativeExecutionPlacementSchema, AcceptedNodePlacementSchema, DispatchIntentSchema, CurrentAcceptedNodePlacementSchema, CurrentDispatchIntentSchema } from './nodePlacement.js'
import { RemoteOwnerControlSchema, RemoteOwnerReconciliationSchema, RemoteApplicationAccessSchema } from './remoteExecution.js'
export * from './workerConversations.js'
export * from './workerOpenCodeFiles.js'
const binding = { intent: DispatchIntentSchema, placement: AcceptedNodePlacementSchema, executionPlacement: NativeExecutionPlacementSchema.optional() }
export const RemoteExecutionRpcRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.enum(['physical-readout','physical-ack']), ...binding, receiptSequence: z.number().int().positive(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ method: z.literal('prepare'), ...binding, request: z.lazy(() => HarnessExecutionRequestSchema), applicationAccess: RemoteApplicationAccessSchema.optional(), sessionPreferences: SessionPreferencesSchema.optional() }).strict(),
  z.object({ method: z.literal('reattach'), ...binding, request: z.lazy(() => HarnessExecutionRequestSchema), session: z.lazy(() => NativeSessionReferenceSchema) }).strict(),
  z.object({ method: z.literal('start-turn'), ...binding, prompt: z.string().min(1).max(1_000_000), correlationId: z.string().min(1), sessionMode: SessionModeSchema.optional() }).strict(),
  z.object({ method: z.enum(['history', 'pending', 'status']), ...binding }).strict(),
  z.object({ method: z.enum(['capabilities', 'inspect-mcp']), ...binding, configuration: z.lazy(() => AgentConfigurationVersionSchema) }).strict(),
  z.object({ method: z.literal('reconcile-response'), ...binding, response: z.object({ nativeRequestId: z.string().min(1), nativeRequestType: z.string().min(1), option: z.lazy(() => ApprovalResponseOptionSchema) }).strict() }).strict(),
  z.object({ method: z.literal('session-controls-read'), ...binding, native: RemoteNativeIdentitySchema }).strict(),
  z.object({ method: z.literal('session-preferences-apply'), ...binding, native: RemoteNativeIdentitySchema, preferences: SessionPreferencesSchema }).strict(),
  z.object({ method: z.literal('session-compact'), ...binding, native: RemoteNativeIdentitySchema,
    requestId: z.string().min(8), clientCorrelationId: z.string().min(1) }).strict(),
  z.object({ method: z.literal('session-compact-reconcile'), ...binding, native: RemoteNativeIdentitySchema,
    state: CompactionStateSchema }).strict(),
  z.object({ method: z.literal('renew-owner'), ...binding, transition: RemoteOwnerReconciliationSchema }).strict(),
  z.object({ method: z.literal('control'), ...binding, command: RemoteOwnerControlSchema }).strict(),
])
export type RemoteExecutionRpcRequest = z.infer<typeof RemoteExecutionRpcRequestSchema>
/** W07 authenticated extension kind. Frame bounds/operation grant remain carrier-owned. */
export const REMOTE_EXECUTION_EXTENSION = 'execution-v1' as const

/** New native entry/turn must use this stricter envelope; historical status and Stop remain supported. */
export const CurrentRemoteExecutionRpcRequestSchema = RemoteExecutionRpcRequestSchema.superRefine((value, ctx) => {
  if (!['prepare', 'start-turn'].includes(value.method)) return
  const placement = CurrentAcceptedNodePlacementSchema.safeParse(value.placement)
  const intent = CurrentDispatchIntentSchema.safeParse(value.intent)
  if (!placement.success || !intent.success || value.intent.bindingHash !== value.placement.bindingHash
    || value.intent.mainId !== value.placement.mainId || value.intent.runId !== value.placement.runId
    || value.intent.nodeId !== value.placement.nodeId || Object.keys(DeviceExecutionAdmissionFields).some(field =>
    value.intent[field as keyof typeof DeviceExecutionAdmissionFields] !== value.placement[field as keyof typeof DeviceExecutionAdmissionFields]))
    ctx.addIssue({ code: 'custom', message: 'Native entry requires the identical original resource policy and device approval.' })
})
export type CurrentRemoteExecutionRpcRequest = z.infer<typeof CurrentRemoteExecutionRpcRequestSchema>
