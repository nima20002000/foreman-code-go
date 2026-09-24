import { z } from 'zod'
import { IdSchema } from '../index.js'
import {
  GraphDraftSchema, GraphDraftOperationSchema, GraphDraftApplyInputSchema,
  GraphDraftApplyResultSchema, GraphSaveInputSchema, GraphSaveResultSchema, RunStartInputSchema, RunStartResultSchema, RunPageSchema,
} from '../management/index.js'
import { WorkflowDefinitionV2Schema, WorkflowVersionV2Schema, WorkflowNodeV2Schema, WorkflowRelationshipSchema, WorkflowChoiceSchema, WorkflowRunV2Schema, CompatibleWorkflowRunSchema } from './workflow.js'

/** Separate v2 boundary. Do not broaden legacy strict draft/command responses. */
export const GraphDraftV2Schema = GraphDraftSchema.extend({ graph: WorkflowDefinitionV2Schema }).strict()
export type GraphDraftV2 = z.infer<typeof GraphDraftV2Schema>
// Old geometry/Agent/settings operations retain their exact validation. Operations
// which construct structural records must use the explicit typed v2 alternatives.
const LegacySafeDraftOperationSchema = GraphDraftOperationSchema.superRefine((operation, context) => {
  if (['edge.put', 'edge.connect', 'node.replace', 'workflow.restore_version'].includes(operation.type)) {
    context.addIssue({ code: 'custom', message: 'use the explicitly typed v2 structural operation' })
  }
})
export const GraphDraftOperationV2Schema = z.union([
  z.object({ type: z.literal('workflow.set_entry'), entryNodeId: IdSchema.nullable() }).strict(),
  z.object({ type: z.literal('node.set_choice'), nodeId: IdSchema, choice: WorkflowChoiceSchema.nullable() }).strict(),
  z.object({ type: z.literal('relationship.put'), relationship: WorkflowRelationshipSchema }).strict(),
  z.object({ type: z.literal('node.replace_v2'), node: WorkflowNodeV2Schema }).strict(),
  z.object({ type: z.literal('workflow.restore_version_v2'), versionId: IdSchema }).strict(),
  LegacySafeDraftOperationSchema,
])
export type GraphDraftOperationV2 = z.infer<typeof GraphDraftOperationV2Schema>
export const GraphDraftApplyV2InputSchema = GraphDraftApplyInputSchema.extend({
  executionSemanticsVersion: z.literal(2), operations: z.array(GraphDraftOperationV2Schema).min(1).max(100),
}).strict()
export const GraphDraftApplyV2ResultSchema = GraphDraftApplyResultSchema.extend({
  draft: GraphDraftV2Schema, previousDraft: GraphDraftSchema.or(GraphDraftV2Schema).optional(),
}).strict()
export const GraphDraftCommandV2ResultSchema = z.object({ value: GraphDraftApplyV2ResultSchema, replayed: z.boolean() }).strict()
export const GraphSaveV2InputSchema = GraphSaveInputSchema.extend({ executionSemanticsVersion: z.literal(2) }).strict()
export const GraphSaveV2ResultSchema = GraphSaveResultSchema.extend({ draft: GraphDraftV2Schema, version: WorkflowVersionV2Schema }).strict()
export const GraphSaveCommandV2ResultSchema = z.object({ value: GraphSaveV2ResultSchema, replayed: z.boolean() }).strict()
export const RunStartV2InputSchema = RunStartInputSchema.safeExtend({ executionSemanticsVersion: z.literal(2) })
export const RunStartV2ResultSchema = RunStartResultSchema.extend({ run: WorkflowRunV2Schema }).strict()
export const CompatibleRunPageSchema = RunPageSchema.extend({ items: CompatibleWorkflowRunSchema.array() }).strict()
