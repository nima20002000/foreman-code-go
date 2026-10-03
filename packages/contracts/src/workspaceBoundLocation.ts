import { z } from 'zod'
import { ExecutionLocationSchema } from './executionLocation.js'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'
import { WorkspaceRootSelectionSchema, WorkspaceRootPolicySchema, WorkspaceRootAttestationSchema, WorkspaceRootBrowseResultSchema, WorkspaceRootHostSchema, ApprovedRootAllowlistSchema } from './workspaceRootPolicies.js'

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

/** Audited adoption of an existing protected host configuration; never caller-selected paths. */
export const WorkspaceRootConfigurationAdoptSchema = z.object({
  workspaceId: IdSchema, commandId: WorkspaceBoundLocationSetInputSchema.shape.commandId, hostRef: WorkspaceRootHostSchema,
}).strict()
export const WorkspaceRootConfigurationAdoptResultSchema = z.object({ value: ApprovedRootAllowlistSchema, replayed: z.boolean() }).strict()
export type WorkspaceRootConfigurationAdopt = z.infer<typeof WorkspaceRootConfigurationAdoptSchema>
export type WorkspaceRootConfigurationAdoptResult = z.infer<typeof WorkspaceRootConfigurationAdoptResultSchema>
