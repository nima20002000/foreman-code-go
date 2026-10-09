import { z } from 'zod'
import { IdSchema, TimestampSchema } from '../schemaPrimitives.js'

/** Current execution semantics is independent of graph/native/MCP protocol
 * versions and immutable WorkflowVersion revision numbers. No rollout switch,
 * legacy union, old validator, or V3-to-V2 projection is retained here. */
import { ExecutionSemanticsVersionSchema } from './workflowShape.js'
export { EXECUTION_SEMANTICS_VERSION, ExecutionSemanticsVersionSchema } from './workflowShape.js'
export {
  DEFAULT_AGENT_ACTIVE_TIMEOUT_MS, MAX_AGENT_ACTIVE_TIMEOUT_MS, AgentActiveTimeoutMsSchema,
  WorkflowExecutionPolicySchema,
  ChoiceOutcomeSchema, ChoiceTargetSchema, WorkflowChoiceSchema,
  WorkflowExecutionRelationshipSchema, WorkflowApprovalRelationshipSchema, WorkflowRelationshipSchema,
} from './workflowShape.js'
export type { WorkflowChoice, WorkflowRelationship } from './workflowShape.js'
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
