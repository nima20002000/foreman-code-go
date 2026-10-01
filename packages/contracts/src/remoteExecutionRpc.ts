import { z } from 'zod'
import { AgentConfigurationVersionSchema, HarnessExecutionRequestSchema, ApprovalResponseOptionSchema } from './index.js'
import { NativeExecutionPlacementSchema, AcceptedNodePlacementSchema, DispatchIntentSchema } from './nodePlacement.js'
import { RemoteOwnerControlSchema, RemoteOwnerReconciliationSchema, RemoteApplicationAccessSchema } from './remoteExecution.js'
const binding = { intent: DispatchIntentSchema, placement: AcceptedNodePlacementSchema, executionPlacement: NativeExecutionPlacementSchema.optional() }
export const RemoteExecutionRpcRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('physical-readout'), ...binding, receiptSequence: z.number().int().positive(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ method: z.literal('prepare'), ...binding, request: z.lazy(() => HarnessExecutionRequestSchema), applicationAccess: RemoteApplicationAccessSchema.optional() }).strict(),
  z.object({ method: z.literal('start-turn'), ...binding, prompt: z.string().min(1).max(1_000_000), correlationId: z.string().min(1) }).strict(),
  z.object({ method: z.enum(['history', 'pending', 'status']), ...binding }).strict(),
  z.object({ method: z.enum(['capabilities', 'inspect-mcp']), ...binding, configuration: z.lazy(() => AgentConfigurationVersionSchema) }).strict(),
  z.object({ method: z.literal('reconcile-response'), ...binding, response: z.object({ nativeRequestId: z.string().min(1), nativeRequestType: z.string().min(1), option: z.lazy(() => ApprovalResponseOptionSchema) }).strict() }).strict(),
  z.object({ method: z.literal('renew-owner'), ...binding, transition: RemoteOwnerReconciliationSchema }).strict(),
  z.object({ method: z.literal('control'), ...binding, command: RemoteOwnerControlSchema }).strict(),
])
export type RemoteExecutionRpcRequest = z.infer<typeof RemoteExecutionRpcRequestSchema>
/** W07 authenticated extension kind. Frame bounds/operation grant remain carrier-owned. */
export const REMOTE_EXECUTION_EXTENSION = 'execution-v1' as const
