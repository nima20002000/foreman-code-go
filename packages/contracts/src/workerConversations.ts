import { z } from 'zod'
import { HarnessProfileSelectionSchema } from './harnessProfileSelection.js'
import { DeviceSessionBindingSchema } from './deviceConnection.js'
import { NativeMessageSubmissionSchema } from './claude.js'
import {
  AgentConfigurationVersionSchema, OperatorConfigurationVersionSchema, AgentHarnessSchema,
  NativeSessionReferenceSchema, NativeHarnessEventSchema, PendingNativeInteractionSchema,
  ExecutionResultSchema, ApprovalResponseOptionSchema, ApprovalResponseSemanticSchema,
} from './index.js'
import { RemoteNativeIdentitySchema } from './remoteExecution.js'
import { CompactionStateSchema, SessionModeSchema, SessionPreferencesSchema } from './sessionControls.js'

const id = z.string().min(1).max(1024)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const directory = z.string().startsWith('/').max(4096).refine(value => !value.includes('\0'))
const owner = { conversationId: id, configurationVersionId: id, configurationHash: digest }
export const WorkerConversationOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ ...owner, kind: z.literal('operator'), operatorId: id }).strict(),
  z.object({ ...owner, kind: z.literal('agent'), agentId: id, workspaceId: id,
    workflowId: id, workflowNodeId: id }).strict(),
])
export const WorkerConversationBindingSchema = z.object({
  owner: WorkerConversationOwnerSchema,
  harness: z.lazy(() => AgentHarnessSchema),
  profile: HarnessProfileSelectionSchema,
  workingDirectory: directory,
  appMcpAccess: z.enum(['scoped', 'none']),
}).strict().superRefine((value, context) => {
  if (value.profile.target.hostRef.kind !== 'device') {
    context.addIssue({ code: 'custom', message: 'A worker conversation requires its selected device profile.' })
  }
  if (value.owner.kind === 'agent' && value.appMcpAccess !== 'none') {
    context.addIssue({ code: 'custom', message: 'Agent chat cannot receive management MCP access.' })
  }
})
export type WorkerConversationBinding = z.infer<typeof WorkerConversationBindingSchema>
export const WorkerConversationConfigurationSchema = z.union([
  z.lazy(() => OperatorConfigurationVersionSchema), z.lazy(() => AgentConfigurationVersionSchema),
])
export type WorkerConversationConfiguration = z.infer<typeof WorkerConversationConfigurationSchema>

export const WorkerConversationTurnSchema = z.object({
  correlationId: id, inputHash: digest,
  status: z.enum(['reserved', 'submitted', 'completed', 'uncertain']),
  nativeTurnId: id.nullable(), nativeSubmission: NativeMessageSubmissionSchema.optional(),
  result: z.lazy(() => ExecutionResultSchema).optional(),
}).strict()
export const WorkerConversationReceiptSchema = z.object({
  binding: WorkerConversationBindingSchema,
  connection: DeviceSessionBindingSchema,
  revision: z.number().int().positive(),
  closed: z.boolean(), closing: z.boolean(),
  creation: z.object({ operationId: id, inputHash: digest }).strict().optional(),
  session: z.lazy(() => NativeSessionReferenceSchema).optional(),
  nativeOwner: RemoteNativeIdentitySchema.optional(),
  turns: z.array(WorkerConversationTurnSchema).max(1000),
  compactions: z.array(z.object({ inputHash: digest, state: CompactionStateSchema }).strict()).max(1000),
  desiredPreferences: SessionPreferencesSchema.nullable(),
  appliedPreferences: SessionPreferencesSchema.nullable(),
}).strict()
export type WorkerConversationReceipt = z.infer<typeof WorkerConversationReceiptSchema>

export const WorkerConversationHistorySchema = z.object({
  correlationId: id.optional(), nativeTurnId: id.optional(), nativeMessageId: id.optional(),
  nativeSubmission: NativeMessageSubmissionSchema.optional(),
  nextCursor: id.optional(), firstRetainedSequence: z.number().int().nonnegative().optional(),
  nextSequence: z.number().int().nonnegative().optional(),
  events: z.array(z.lazy(() => NativeHarnessEventSchema)),
  pendingInteractions: z.array(z.lazy(() => PendingNativeInteractionSchema)),
  pendingInteraction: z.lazy(() => PendingNativeInteractionSchema).optional(),
  terminalResult: z.lazy(() => ExecutionResultSchema).optional(),
  terminalTurn: z.object({ correlationId: id, providerId: id, result: z.lazy(() => ExecutionResultSchema) }).optional(),
  interactionDeliveries: z.array(z.object({ nativeRequestId: id,
    state: z.enum(['pending', 'submitting', 'submitted', 'uncertain']), selectedOptionId: id.optional() }).strict()).optional(),
  responseDeliveries: z.array(z.object({ source: z.enum(['provider_acknowledgement', 'provider_history']),
    harness: z.lazy(() => AgentHarnessSchema), providerVersion: id, nativeSessionId: id,
    nativeRequestId: id, nativeRequestType: id, optionId: id,
    semantic: z.lazy(() => ApprovalResponseSemanticSchema) }).strict()).optional(),
  canceledRequestIds: z.array(id).optional(),
}).passthrough()

const binding = { binding: WorkerConversationBindingSchema, admissionId: z.uuid().optional() }
const native = { ...binding, session: z.lazy(() => NativeSessionReferenceSchema) }
const prompt = {
  prompt: z.string().min(1).max(1_000_000), correlationId: id,
  sessionMode: SessionModeSchema.optional(), preferences: SessionPreferencesSchema.optional(),
}
const applicationAccess = z.object({ kind: z.literal('operator-chat-mcp'), token: z.string().min(1).max(16384) }).strict()
export const WorkerResponseAvailabilityQuerySchema = z.object({
  nativeRequestId: id, nativeRequestType: id, expectedNativeTurnId: id.optional(),
  expectedNativeMessageId: id.optional(), expectedGeneration: id.optional(),
}).strict()
export const WorkerResponseAvailabilitySchema = z.object({
  nativeSessionId: id, nativeRequestId: id, nativeRequestType: id, nativeTurnId: id.optional(),
  nativeMessageId: id.optional(), generation: id.optional(), qualified: z.boolean(),
  state: z.enum(['available', 'recovery_required', 'unavailable']),
  path: z.enum(['live_callback', 'qualified_recovery']).nullable(),
  reason: z.enum(['live_callback', 'qualified_recovery', 'request_consumed', 'callback_lost', 'session_closed',
    'unqualified', 'identity_mismatch', 'response_in_flight', 'unsupported']),
}).strict()
export const WorkerConversationRpcRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('conversation.status'), ...binding }).strict(),
  z.object({ method: z.literal('conversation.open'), ...binding, operationId: id,
    configuration: WorkerConversationConfigurationSchema, mode: z.enum(['create', 'attach', 'fork']),
    source: z.lazy(() => NativeSessionReferenceSchema).optional(), preferences: SessionPreferencesSchema.optional(),
    applicationAccess: applicationAccess.optional(),
  }).strict(),
  z.object({ method: z.literal('conversation.initial-turn'), ...binding, ...prompt, operationId: id,
    configuration: WorkerConversationConfigurationSchema, applicationAccess: applicationAccess.optional() }).strict(),
  z.object({ method: z.literal('conversation.start-turn'), ...native, ...prompt }).strict(),
  z.object({ method: z.enum(['conversation.history', 'conversation.reconcile']), ...native,
    correlationId: id.optional(), before: id.optional() }).strict(),
  z.object({ method: z.enum(['conversation.capabilities', 'conversation.inspect-mcp']), ...binding,
    configuration: WorkerConversationConfigurationSchema }).strict(),
  z.object({ method: z.literal('conversation.inspect-entry'), ...binding,
    configuration: WorkerConversationConfigurationSchema, inspection: z.object({
      harness: z.lazy(() => AgentHarnessSchema), runnerId: id, workingDirectory: directory, serverName: id,
      phase: z.enum(['configuration', 'health']).optional(),
    }).strict() }).strict(),
  z.object({ method: z.enum(['conversation.pending', 'conversation.controls-read', 'conversation.close']),
    ...native }).strict(),
  z.object({ method: z.literal('conversation.cancel'), ...native, nativeTurnId: id.optional() }).strict(),
  z.object({ method: z.literal('conversation.respond'), ...native, nativeRequestId: id,
    option: z.lazy(() => ApprovalResponseOptionSchema) }).strict(),
  z.object({ method: z.literal('conversation.response-availability'), ...native,
    query: WorkerResponseAvailabilityQuerySchema }).strict(),
  z.object({ method: z.literal('conversation.response-reconcile'), ...native, response: z.object({
    nativeRequestId: id, nativeRequestType: id, option: z.lazy(() => ApprovalResponseOptionSchema),
  }).strict() }).strict(),
  z.object({ method: z.literal('conversation.preferences'), ...native, preferences: SessionPreferencesSchema }).strict(),
  z.object({ method: z.literal('conversation.compact'), ...native, requestId: id, correlationId: id }).strict(),
  z.object({ method: z.literal('conversation.compact-reconcile'), ...native, state: CompactionStateSchema }).strict(),
  z.object({ method: z.literal('conversation.compact-read'), ...native, state: CompactionStateSchema,
    configuration: WorkerConversationConfigurationSchema, correlationId: id }).strict(),
  z.object({ method: z.literal('conversation.steer'), ...native, prompt: prompt.prompt,
    correlationId: id, expectedTurnId: id }).strict(),
  z.object({ method: z.literal('conversation.reconcile-steers'), ...native,
    inputs: z.array(z.object({ clientCorrelationId: id, expectedTurnId: id }).strict()).max(1000) }).strict(),
]).superRefine((request, context) => {
  if ('applicationAccess' in request && request.applicationAccess
    && (request.binding.owner.kind !== 'operator' || request.binding.appMcpAccess !== 'scoped')) {
    context.addIssue({ code: 'custom', message: 'Management MCP credentials require a scoped Operator conversation.' })
  }
})
export type WorkerConversationRpcRequest = z.infer<typeof WorkerConversationRpcRequestSchema>

const callback = { admissionId: z.uuid(), binding: WorkerConversationBindingSchema }
export const WorkerConversationCallbackSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('conversation.authorize'), ...callback, request: WorkerConversationRpcRequestSchema }).strict(),
  z.object({ method: z.literal('conversation.session-observed'), ...callback,
    session: z.lazy(() => NativeSessionReferenceSchema) }).strict(),
  z.object({ method: z.literal('conversation.submitted'), ...callback, correlationId: id,
    identity: z.object({ nativeTurnId: id.optional(), nativeSubmission: NativeMessageSubmissionSchema.optional() }).strict()
      .refine(value => Boolean(value.nativeTurnId || value.nativeSubmission), 'A provider submission identity is required') }).strict(),
  z.object({ method: z.literal('conversation.settings-applied'), ...callback, correlationId: id }).strict(),
])
export type WorkerConversationCallback = z.infer<typeof WorkerConversationCallbackSchema>

export const WorkerMcpInspectionSchema = z.object({
  harness: z.lazy(() => AgentHarnessSchema), providerVersion: id, runnerId: id,
  workingDirectory: directory, inspectedAt: z.iso.datetime(), generation: id.optional(), authorizationScope: id.optional(),
  entry: z.object({ name: id, transport: z.enum(['streamable-http', 'sse', 'stdio', 'unknown']),
    automaticEndpoint: z.boolean().optional(), endpoint: z.string().optional(), enabled: z.boolean().optional(),
    credentialEnvironmentVariable: id.optional(),
    credentialArrangement: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('environment_variable'), environmentVariable: id }).strict(),
      z.object({ kind: z.literal('unknown') }).strict(),
      z.object({ kind: z.literal('scoped_http_header'), acknowledgement: z.object({
        source: z.literal('sdk_set_mcp_servers'), serverName: id, endpoint: z.string(), generation: id, authorizationScope: id,
      }).strict() }).strict(),
    ]).optional(),
    status: z.enum(['connected', 'disabled', 'authentication_required', 'broken', 'status_unavailable']).optional(),
    detail: z.string().optional(), enabledTools: z.array(id).optional(), disabledTools: z.array(id).optional(),
    nativeFilterDiagnostics: z.array(z.string()).optional(),
  }).strict().optional(),
}).strict()
