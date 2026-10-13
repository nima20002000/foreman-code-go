import { z } from 'zod'
export { WorkerConversationMcpRequestSchema, WorkerConversationMcpAuthorizationSchema,
  type WorkerConversationMcpRequest } from './workerConversationMcp.js'
import { DispatchIntentSchema, AcceptedNodePlacementSchema } from './nodePlacement.js'
import { WorkerNativeOutputOperationSchema } from './workerNativeOutput.js'
import { RemoteApplicationAccessSchema } from './remoteExecution.js'
import { TemporaryFileScopeSchema } from './files.js'
export const WorkerMcpRelayRequestSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(1), operation: z.literal('worker-mcp.authorize'), intent: DispatchIntentSchema,
    placement: AcceptedNodePlacementSchema, applicationAccess: RemoteApplicationAccessSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('worker-mcp.authorize-native-output'), intent: DispatchIntentSchema,
    placement: AcceptedNodePlacementSchema, applicationAccess: RemoteApplicationAccessSchema,
    outputOperation: WorkerNativeOutputOperationSchema, nativeSessionId: z.string().min(1).max(500),
    turnId: z.string().min(1).max(500) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('worker-mcp.authorize-native-output-declarations'),
    intent: DispatchIntentSchema, placement: AcceptedNodePlacementSchema, applicationAccess: RemoteApplicationAccessSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('worker-mcp.native-output-readiness'),
    intent: DispatchIntentSchema, placement: AcceptedNodePlacementSchema, applicationAccess: RemoteApplicationAccessSchema,
    nativeSessionId: z.string().min(1).max(500), turnId: z.string().min(1).max(500) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('worker-mcp.request'), intent: DispatchIntentSchema,
    placement: AcceptedNodePlacementSchema, applicationAccess: RemoteApplicationAccessSchema,
    body: z.json(), protocolVersion: z.string().max(64).optional() }).strict(),
])
export type WorkerMcpRelayRequest = z.infer<typeof WorkerMcpRelayRequestSchema>
export const WorkerMcpRelayAuthorizationSchema = z.object({ version: z.literal(1), mainId: z.uuid(),
  audience: z.literal('worker'), principalId: z.string().min(1), executionId: z.string().min(1), agentId: z.string().min(1),
  operationId: z.string().min(1), attemptId: z.string().min(1), bindingHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime() }).strict()
export const WorkerMcpRelayResponseSchema = z.object({ statusCode: z.number().int().min(100).max(599),
  contentType: z.enum(['application/json', 'text/event-stream', 'empty']), body: z.string().max(1_000_000) }).strict()
export const WORKER_MCP_EXTENSION = { namespace: 'worker-mcp-v1', version: 1, maxJsonBytes: 1_048_576, maxBinaryBytes: 0 } as const

export const WorkerNativeOutputAuthorizationSchema = WorkerMcpRelayAuthorizationSchema.extend({
  outputOperation: WorkerNativeOutputOperationSchema, nativeSessionId: z.string().min(1).max(500), turnId: z.string().min(1).max(500),
  scope: TemporaryFileScopeSchema,
}).strict().refine(value => value.scope.chat.kind === 'agent' && value.scope.chat.agentId === value.agentId
  && value.scope.chat.executionId === value.executionId && value.scope.chat.runId !== undefined,
  'Native output requires the original workflow Agent file scope')
/** Permission to declare tools, before a native turn exists. This is not host qualification or mutation authority. */
export const WorkerNativeOutputDeclarationsPolicySchema = z.object({ agentConfigurationVersionId: z.string().min(1),
  outputOperations: z.tuple([z.literal('create'), z.literal('append'), z.literal('seal'), z.literal('publish')]) }).strict()
export const WorkerNativeOutputDeclarationsAuthorizationSchema = WorkerMcpRelayAuthorizationSchema
  .extend(WorkerNativeOutputDeclarationsPolicySchema.shape).strict()
export type WorkerNativeOutputDeclarationsPolicy = z.infer<typeof WorkerNativeOutputDeclarationsPolicySchema>
/** Readiness never grants a mutation or substitutes for operation authorization. */
export const WorkerNativeOutputReadinessSchema = WorkerMcpRelayAuthorizationSchema.extend({
  nativeSessionId: z.string().min(1).max(500), turnId: z.string().min(1).max(500), ready: z.boolean(),
}).strict()
