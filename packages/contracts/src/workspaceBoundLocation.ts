import { z } from 'zod'
import { ExecutionLocationSchema } from './index.js'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'
import { WorkspaceRootSelectionSchema, WorkspaceRootPolicySchema, WorkspaceRootAttestationSchema, WorkspaceRootBrowseResultSchema } from './workspaceRootPolicies.js'

export const WorkspaceBoundLocationGetInputSchema = z.object({ workspaceId: IdSchema }).strict()
export const WorkspaceBoundLocationValidateInputSchema = WorkspaceRootSelectionSchema
export const WorkspaceBoundLocationBrowseInputSchema = WorkspaceRootSelectionSchema
export const WorkspaceBoundLocationSetInputSchema = WorkspaceRootSelectionSchema.extend({ commandId: z.string().min(8).max(200) }).strict()
export const WorkspaceBoundLocationValidationSchema = z.object({ workspaceId: IdSchema,
  selection: WorkspaceRootSelectionSchema, attestation: WorkspaceRootAttestationSchema, checkedAt: TimestampSchema }).strict()
export const WorkspaceBoundLocationBrowseResultSchema = z.object({ workspaceId: IdSchema,
  selection: WorkspaceRootSelectionSchema, browse: WorkspaceRootBrowseResultSchema }).strict()
export const WorkspaceBoundLocationReadbackSchema = z.discriminatedUnion('evidence', [
  z.object({ evidence: z.literal('bound'), workspaceId: IdSchema, locationRevision: z.number().int().nonnegative(),
    executionLocation: ExecutionLocationSchema, binding: WorkspaceRootPolicySchema }).strict(),
  z.object({ evidence: z.literal('legacy_missing'), workspaceId: IdSchema, locationRevision: z.number().int().nonnegative(),
    executionLocation: ExecutionLocationSchema }).strict(),
  z.object({ evidence: z.literal('unconfigured'), workspaceId: IdSchema, locationRevision: z.number().int().nonnegative(),
    executionLocation: z.null() }).strict(),
])
export const WorkspaceBoundLocationSetResultSchema = z.object({ value: WorkspaceBoundLocationReadbackSchema, replayed: z.boolean() }).strict()
export type WorkspaceBoundLocationReadback = z.infer<typeof WorkspaceBoundLocationReadbackSchema>
export type WorkspaceBoundLocationSetInput = z.infer<typeof WorkspaceBoundLocationSetInputSchema>
export type WorkspaceBoundLocationGetInput = z.infer<typeof WorkspaceBoundLocationGetInputSchema>
export type WorkspaceBoundLocationValidateInput = z.infer<typeof WorkspaceBoundLocationValidateInputSchema>
export type WorkspaceBoundLocationBrowseInput = z.infer<typeof WorkspaceBoundLocationBrowseInputSchema>
export type WorkspaceBoundLocationValidation = z.infer<typeof WorkspaceBoundLocationValidationSchema>
export type WorkspaceBoundLocationBrowseResult = z.infer<typeof WorkspaceBoundLocationBrowseResultSchema>
export type WorkspaceBoundLocationSetResult = z.infer<typeof WorkspaceBoundLocationSetResultSchema>
