import { z } from 'zod'
import { ArtifactEdgeBindingSchema } from './artifactEdges.js'
import { AgentFilePublishInputSchema } from './files.js'

const OutputKeys = z.array(ArtifactEdgeBindingSchema.shape.outputKey).min(1).max(64)
  .refine(keys => new Set(keys).size === keys.length, 'Artifact output keys must be unique.')

/** Saved names only; bytes and publication authority come from the original execution. */
export const WorkflowArtifactOutputsV1Schema = z.object({ version: z.literal(1), outputKeys: OutputKeys }).strict()
export type WorkflowArtifactOutputsV1 = z.infer<typeof WorkflowArtifactOutputsV1Schema>
export const WorkflowArtifactInputsV1Schema = z.object({ version: z.literal(1), outputKeys: OutputKeys }).strict()
export type WorkflowArtifactInputsV1 = z.infer<typeof WorkflowArtifactInputsV1Schema>
export const WorkflowArtifactResultV1Schema = z.object({
  version: z.literal(1), outputs: z.array(z.object({
    outputKey: ArtifactEdgeBindingSchema.shape.outputKey,
    commandId: AgentFilePublishInputSchema.shape.commandId,
  }).strict()).min(1).max(64),
}).strict().refine(value => new Set(value.outputs.map(output => output.outputKey)).size === value.outputs.length,
  'Artifact result keys must be unique.')
export type WorkflowArtifactResultV1 = z.infer<typeof WorkflowArtifactResultV1Schema>
