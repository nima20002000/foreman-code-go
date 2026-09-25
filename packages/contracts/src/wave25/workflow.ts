import { z } from 'zod'
import { IdSchema, TimestampSchema } from '../index.js'

/** Current execution semantics is independent of graph/native/MCP protocol
 * versions and immutable WorkflowVersion revision numbers. No rollout switch,
 * legacy union, old validator, or V3-to-V2 projection is retained here. */
export const EXECUTION_SEMANTICS_VERSION = 3 as const
export const ExecutionSemanticsVersionSchema = z.literal(EXECUTION_SEMANTICS_VERSION)
export {
  ChoiceOutcomeSchema, ChoiceTargetSchema, WorkflowChoiceSchema,
  WorkflowExecutionRelationshipSchema, WorkflowApprovalRelationshipSchema, WorkflowRelationshipSchema,
} from '../index.js'
export type { WorkflowChoice, WorkflowRelationship } from '../index.js'
export {
  CurrentChoiceResultEnvelopeSchema as ChoiceResultEnvelopeSchema,
  parseChoiceResultEnvelope,
} from './currentResult.js'
export type { CurrentChoiceResultEnvelope as ChoiceResultEnvelope } from './currentResult.js'

/** This is a saved execution pin, not launch permission. */
export const WorkflowSemanticsPinSchema = z.object({
  workflowVersionId: IdSchema, executionSemanticsVersion: ExecutionSemanticsVersionSchema,
  acceptedAt: TimestampSchema,
}).strict()
