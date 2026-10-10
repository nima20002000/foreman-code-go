import { z } from 'zod'

export const SourceRootReferenceSchema = z.object({
  rootId: z.uuid(),
  bindingRevision: z.number().int().positive(),
}).strict()
export type SourceRootReference = z.infer<typeof SourceRootReferenceSchema>

export const AgentBranchPrefixSchema = z.string().regex(/^foreman\/[A-Za-z0-9._/-]{1,200}$/)
  .refine(value => !value.includes('\n') && !value.includes('\r') && !value.includes('..') && !value.includes('//')
    && !value.endsWith('/') && !value.endsWith('.')
    && value.split('/').every(part => !part.endsWith('.lock') && !part.startsWith('.')),
  'Use a valid foreman/ Agent branch prefix.')

export const WorkflowWorktreeSettingsSchema = z.object({
  rootBinding: SourceRootReferenceSchema,
  branchPrefix: AgentBranchPrefixSchema.optional(),
}).strict()
export type WorkflowWorktreeSettings = z.infer<typeof WorkflowWorktreeSettingsSchema>

export const AgentWorktreeSettingsSchema = z.object({
  branchPrefix: AgentBranchPrefixSchema,
}).strict()
export type AgentWorktreeSettings = z.infer<typeof AgentWorktreeSettingsSchema>
