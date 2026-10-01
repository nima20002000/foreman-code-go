import { z } from 'zod'
import { GraphIdSchema } from './schemaPrimitives.js'
import { WorkflowChoiceSchema } from './wave25/workflowShape.js'
/** A real job reference; no Agent/provider/native-session fields are admitted. */
export const JobWorkflowNodeSchema = z.object({
  kind:z.literal('job'),id:GraphIdSchema,jobDefinitionId:GraphIdSchema,jobDefinitionRevision:z.number().int().positive(),jobDefinitionVersionId:GraphIdSchema,
  name:z.string().trim().min(1).optional(),label:z.string().trim().min(1).optional(),description:z.string().optional(),
  position:z.object({x:z.number().finite(),y:z.number().finite()}).strict().optional(),
  width:z.number().finite().positive().optional(),height:z.number().finite().positive().optional(),
  join:z.object({mode:z.literal('all')}).strict().optional(),choice:z.lazy(()=>WorkflowChoiceSchema).optional(),
}).strict().superRefine((node,context)=>{
  if(!node.name&&!node.label) context.addIssue({code:'custom',path:['name'],message:'a workflow node requires name or label'})
})
export type JobWorkflowNode=z.infer<typeof JobWorkflowNodeSchema>
export const JobWorkflowExecutionReferenceSchema=z.object({
  kind:z.literal('job'),workspaceId:GraphIdSchema,workflowId:GraphIdSchema,runId:GraphIdSchema,workflowVersionId:GraphIdSchema,
  nodeId:GraphIdSchema,nodeExecutionId:GraphIdSchema,jobExecutionId:GraphIdSchema,
  occurrenceId:GraphIdSchema.nullable(),occurrenceIndex:z.number().int().nonnegative(),
}).strict()
export type JobWorkflowExecutionReference=z.infer<typeof JobWorkflowExecutionReferenceSchema>

export const JobWorkflowAdmissionReferenceSchema=JobWorkflowExecutionReferenceSchema.omit({jobExecutionId:true})
export type JobWorkflowAdmissionReference=z.infer<typeof JobWorkflowAdmissionReferenceSchema>
