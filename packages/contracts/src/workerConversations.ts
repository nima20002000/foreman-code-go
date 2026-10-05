import { z } from 'zod'
import { HarnessProfileSelectionSchema } from './harnessProfileSelection.js'
import { DeviceSessionBindingSchema } from './deviceConnection.js'
import { NativeMessageSubmissionSchema } from './claude.js'
import {
  AgentConfigurationVersionSchema, OperatorConfigurationVersionSchema, AgentHarnessSchema,
  NativeSessionReferenceSchema, NativeHarnessEventSchema, PendingNativeInteractionSchema,
  ExecutionResultSchema, ApprovalResponseOptionSchema,
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
}).passthrough()

const binding = { binding: WorkerConversationBindingSchema }
const native = { ...binding, session: z.lazy(() => NativeSessionReferenceSchema) }
const prompt = {
  prompt: z.string().min(1).max(1_000_000), correlationId: id,
  sessionMode: SessionModeSchema.optional(), preferences: SessionPreferencesSchema.optional(),
}
export const WorkerConversationRpcRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('conversation.status'), ...binding }).strict(),
  z.object({ method: z.literal('conversation.open'), ...binding, operationId: id,
    configuration: WorkerConversationConfigurationSchema, mode: z.enum(['create', 'attach', 'fork']),
    source: z.lazy(() => NativeSessionReferenceSchema).optional(), preferences: SessionPreferencesSchema.optional(),
  }).strict(),
  z.object({ method: z.literal('conversation.initial-turn'), ...binding, ...prompt, operationId: id,
    configuration: WorkerConversationConfigurationSchema }).strict(),
  z.object({ method: z.literal('conversation.start-turn'), ...native, ...prompt }).strict(),
  z.object({ method: z.enum(['conversation.history', 'conversation.reconcile']), ...native,
    correlationId: id.optional(), before: id.optional() }).strict(),
  z.object({ method: z.enum(['conversation.capabilities', 'conversation.inspect-mcp']), ...binding,
    configuration: WorkerConversationConfigurationSchema }).strict(),
  z.object({ method: z.enum(['conversation.pending', 'conversation.controls-read', 'conversation.close']),
    ...native }).strict(),
  z.object({ method: z.literal('conversation.cancel'), ...native, nativeTurnId: id.optional() }).strict(),
  z.object({ method: z.literal('conversation.respond'), ...native, nativeRequestId: id,
    option: z.lazy(() => ApprovalResponseOptionSchema) }).strict(),
  z.object({ method: z.literal('conversation.preferences'), ...native, preferences: SessionPreferencesSchema }).strict(),
  z.object({ method: z.literal('conversation.compact'), ...native, requestId: id, correlationId: id }).strict(),
  z.object({ method: z.literal('conversation.compact-reconcile'), ...native, state: CompactionStateSchema }).strict(),
  z.object({ method: z.literal('conversation.steer'), ...native, prompt: prompt.prompt,
    correlationId: id, expectedTurnId: id }).strict(),
  z.object({ method: z.literal('conversation.reconcile-steers'), ...native,
    inputs: z.array(z.object({ clientCorrelationId: id, expectedTurnId: id }).strict()).max(1000) }).strict(),
])
export type WorkerConversationRpcRequest = z.infer<typeof WorkerConversationRpcRequestSchema>
