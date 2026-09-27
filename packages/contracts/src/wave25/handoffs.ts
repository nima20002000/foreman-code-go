import { z } from 'zod'
import { ExecutionResultSchema } from '../index.js'
import { TimestampSchema } from '../schemaPrimitives.js'
import { GraphDigestSchema, GraphIdSchema, RunGraphScopeSchema } from './graphPrimitives.js'
import type { WorkflowDefinitionV3 } from './workflowShape.js'
import { canonicalGraphJson } from './json.js'
export { HANDOFF_CONTRACT_VERSION, WorkHandoffPolicyV1Schema } from './workflowShape.js'
export type { WorkHandoffPolicyV1 } from './workflowShape.js'

const Count = z.number().int().min(0).max(2147483647)

/** Logical work is independent of native attempts, approval exchanges and turns. */
export const WorkHandoffScopeSchema = RunGraphScopeSchema
export const WorkHandoffConnectionSchema = z.object({
  relationshipId: GraphIdSchema, sourceNodeId: GraphIdSchema, targetNodeId: GraphIdSchema,
  maxWorkHandoffsPerRun: z.number().int().min(1).max(2147483647).optional(),
  workRequestDirection: z.enum(['source_to_target', 'both']),
}).strict().refine((value) => value.sourceNodeId !== value.targetNodeId, 'HANDOFF_SELF_CONNECTION')
export const WorkHandoffUsageSchema = z.object({
  scope: WorkHandoffScopeSchema, relationshipId: GraphIdSchema,
  used: Count, maxWorkHandoffsPerRun: z.number().int().min(1).max(2147483647).nullable(),
}).strict().refine((value) => value.maxWorkHandoffsPerRun === null || value.used <= value.maxWorkHandoffsPerRun,
  'HANDOFF_USAGE_EXCEEDS_LIMIT')
export type WorkHandoffUsage = z.infer<typeof WorkHandoffUsageSchema>
export function canAdmitWorkHandoff(usage: WorkHandoffUsage): boolean {
  return usage.maxWorkHandoffsPerRun === null || usage.used < usage.maxWorkHandoffsPerRun
}

/** A saved execution edge is the sole authority for a business work route. */
export function workConnectionForRequest(definition: WorkflowDefinitionV3, requesterNodeId: string, destinationNodeId: string) {
  if (!definition.handoffs || requesterNodeId === destinationNodeId) return undefined
  return definition.edges.find((edge) => edge.kind === 'execution' && (
    edge.source === requesterNodeId && edge.target === destinationNodeId
    || edge.workRequestDirection === 'both' && edge.source === destinationNodeId && edge.target === requesterNodeId
  ))
}

export const WorkActivationIdentitySchema = z.object({
  scope: WorkHandoffScopeSchema, activationId: GraphIdSchema, workflowNodeId: GraphIdSchema,
  /** The exact accepted request, return or denial that caused this activation. */
  cause: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('entry') }).strict(),
    z.object({ kind: z.literal('dependency'), resolutionId: GraphIdSchema }).strict(),
    z.object({ kind: z.literal('work_request'), requestId: GraphIdSchema }).strict(),
    z.object({ kind: z.literal('work_return'), returnId: GraphIdSchema }).strict(),
    z.object({ kind: z.literal('limit_denial'), denialId: GraphIdSchema }).strict(),
  ]),
}).strict()
export type WorkActivationIdentity = z.infer<typeof WorkActivationIdentitySchema>

export const WorkRequestSchema = z.object({
  scope: WorkHandoffScopeSchema, requestId: GraphIdSchema, relationshipId: GraphIdSchema,
  requesterActivationId: GraphIdSchema, requesterExecutionId: GraphIdSchema,
  destinationActivationId: GraphIdSchema,
  requesterNodeId: GraphIdSchema, destinationNodeId: GraphIdSchema,
  payloadDigest: GraphDigestSchema, acceptedAt: TimestampSchema,
  /** One accepted request reserves exactly one slot, regardless of delivery outcome. */
  ordinal: z.number().int().min(1).max(2147483647),
}).strict().refine((value) => value.requesterNodeId !== value.destinationNodeId, 'HANDOFF_SELF_REQUEST')
export type WorkRequest = z.infer<typeof WorkRequestSchema>

export const WorkReturnSchema = z.object({
  scope: WorkHandoffScopeSchema, returnId: GraphIdSchema, requestId: GraphIdSchema,
  sourceActivationId: GraphIdSchema, sourceExecutionId: GraphIdSchema, requesterActivationId: GraphIdSchema,
  continuationActivationId: GraphIdSchema.optional(),
  acceptedResultDigest: GraphDigestSchema, outcome: z.enum(['accepted', 'needs_changes']),
  latestDeliverable: z.json(), remainingFindings: z.array(z.json()).max(1000), returnedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.outcome === 'needs_changes') !== (value.continuationActivationId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['continuationActivationId'], message: 'HANDOFF_RETURN_CONTINUATION_CONFLICT' })
  }
  if (value.latestDeliverable === null) context.addIssue({ code: 'custom', path: ['latestDeliverable'], message: 'HANDOFF_DELIVERABLE_REQUIRED' })
  try { canonicalGraphJson(value, 64 * 1024) } catch { context.addIssue({ code: 'custom', message: 'HANDOFF_RETURN_TOO_LARGE' }) }
})
export type WorkReturn = z.infer<typeof WorkReturnSchema>

export const WorkLimitDenialSchema = z.object({
  scope: WorkHandoffScopeSchema, denialId: GraphIdSchema, requestId: GraphIdSchema,
  relationshipId: GraphIdSchema, requesterActivationId: GraphIdSchema, destinationNodeId: GraphIdSchema,
  payloadDigest: GraphDigestSchema, used: z.number().int().min(1).max(2147483647),
  maxWorkHandoffsPerRun: z.number().int().min(1).max(2147483647), deniedAt: TimestampSchema,
}).strict().refine((value) => value.used === value.maxWorkHandoffsPerRun, 'HANDOFF_DENIAL_NOT_EXHAUSTED')
export type WorkLimitDenial = z.infer<typeof WorkLimitDenialSchema>

export const WorkNoticeSchema = z.object({
  scope: WorkHandoffScopeSchema, noticeId: GraphIdSchema, requesterActivationId: GraphIdSchema,
  cause: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('last_return'), returnId: GraphIdSchema }).strict(),
    z.object({ kind: z.literal('limit_denial'), denialId: GraphIdSchema }).strict(),
  ]),
  continuationActivationId: GraphIdSchema,
  delivery: z.enum(['queued', 'pending', 'delivered', 'unknown', 'failed']),
  acknowledgementId: GraphIdSchema.optional(),
}).strict().refine((value) => (value.delivery === 'delivered') === (value.acknowledgementId !== undefined),
  'HANDOFF_NOTICE_ACKNOWLEDGEMENT_CONFLICT')
export type WorkNotice = z.infer<typeof WorkNoticeSchema>

/** A typed native decision; the server resolves and validates saved routes. */
export const WorkHandoffResultSchema = z.object({
  routing: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('request'), outcome: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/) }).strict(),
    z.object({ kind: z.literal('return'), requestId: GraphIdSchema, outcome: z.enum(['accepted', 'needs_changes']) }).strict(),
    z.object({ kind: z.literal('finish') }).strict(),
  ]),
  data: z.object({ latestDeliverable: z.json(), remainingFindings: z.array(z.json()).max(1000) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.data.latestDeliverable === null) context.addIssue({ code: 'custom', path: ['data', 'latestDeliverable'], message: 'HANDOFF_DELIVERABLE_REQUIRED' })
  try { canonicalGraphJson(value, 64 * 1024) } catch { context.addIssue({ code: 'custom', message: 'HANDOFF_RESULT_TOO_LARGE' }) }
})
export type WorkHandoffResult = z.infer<typeof WorkHandoffResultSchema>

/** Parse only the exact native result carrier; route IDs are resolved server-side. */
export function parseWorkHandoffResult(result: unknown): WorkHandoffResult {
  const accepted = ExecutionResultSchema.parse(result)
  if (accepted.outcome !== 'succeeded') throw new Error('HANDOFF_RESULT_NOT_SUCCESSFUL')
  let output: unknown = accepted.output
  if (output !== null && typeof output === 'object' && !Array.isArray(output)
    && Object.keys(output).length === 1 && 'text' in output && typeof output.text === 'string') output = output.text
  if (typeof output === 'string') {
    if (new TextEncoder().encode(output).byteLength > 64 * 1024) throw new Error('HANDOFF_RESULT_TOO_LARGE')
    output = JSON.parse(output)
  }
  return WorkHandoffResultSchema.parse(output)
}

export const WorkHandoffOperationKindSchema = z.enum([
  'work_request', 'work_return', 'permission_exchange', 'approval_exchange',
  'technical_retry', 'replay', 'progress', 'system_notice', 'delivery_acknowledgement',
])
export type WorkHandoffOperationKind = z.infer<typeof WorkHandoffOperationKindSchema>
export function consumesWorkHandoffSlot(kind: WorkHandoffOperationKind): boolean {
  return kind === 'work_request'
}
