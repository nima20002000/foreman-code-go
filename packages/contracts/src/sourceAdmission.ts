import { z } from 'zod'
import { IdSchema } from './schemaPrimitives.js'
import { SourceManifestSchema, SourceHashSchema, RootBindingSchema, MaterializationReceiptSchema } from './sourceMaterialization.js'

export const SourceActionSchema = z.enum(['sources:read', 'sources:approve', 'source_roots:read', 'source_roots:bind'])
export const SourceToolNameSchema = z.enum(['source_list', 'source_get', 'source_approve', 'source_root_bind', 'source_root_get'])
export type SourceAction = z.infer<typeof SourceActionSchema>
export type SourceToolName = z.infer<typeof SourceToolNameSchema>
export const SourcePinSchema = z.object({ approvedSourceId: z.uuid(), snapshotId: z.uuid(), manifestDigest: SourceHashSchema }).strict()
export type ApprovedSourcePin = z.infer<typeof SourcePinSchema>
export const SourceApproveInputSchema = z.object({ workspaceId: IdSchema, commandId: z.string().min(8).max(200),
  expectedLocationRevision: z.number().int().positive(), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  approvedPaths: z.array(z.string().min(1).max(1024)).min(1).max(4096), executablePolicy: z.enum(['strip', 'preserve-approved']),
}).strict()
export type SourceApproveInput = z.infer<typeof SourceApproveInputSchema>
export const ApprovedSourceSchema = z.object({ version: z.literal(1), workspaceId: IdSchema, ownerPrincipalId: IdSchema,
  approvedByPrincipalId: IdSchema, locationRevision: z.number().int().positive(),
  mainId: z.uuid(), originIdentityHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  manifest: SourceManifestSchema, approvedAt: z.string().datetime(), availability: z.enum(['retained', 'unavailable']),
}).strict()
export type ApprovedSource = z.infer<typeof ApprovedSourceSchema>
export const SourceApproveResultSchema = z.object({ value: ApprovedSourceSchema, replayed: z.boolean() }).strict()
export const SourceGetInputSchema = z.object({ workspaceId: IdSchema, ...SourcePinSchema.shape }).strict()
export const SourceListInputSchema = z.object({ workspaceId: IdSchema, limit: z.number().int().positive().max(100).default(100),
  afterSnapshotId: z.uuid().optional() }).strict()
export const SourceListResultSchema = z.object({ items: z.array(ApprovedSourceSchema).max(100), nextSnapshotId: z.uuid().nullable() }).strict()
export const SourceHostSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main'), mainId: z.uuid() }).strict(),
  z.object({ kind: z.literal('device'), mainId: z.uuid(), deviceId: z.uuid() }).strict(),
])
export const SourceRootSelectionSchema = z.object({ hostRef: SourceHostSchema, rootPolicyId: IdSchema,
  rootPolicyRevision: z.string().regex(/^[1-9][0-9]*$/), locationRevision: z.string().regex(/^[1-9][0-9]*$/),
}).strict()
export type SourceRootSelection = z.infer<typeof SourceRootSelectionSchema>
export const SourceRootBindInputSchema = z.object({ workspaceId: IdSchema, commandId: z.string().min(8).max(200),
  source: SourcePinSchema, selection: SourceRootSelectionSchema,
  expectedBindingRevision: z.number().int().nonnegative(), accessMode: z.enum(['read-only', 'exclusive-write']),
}).strict()
export type SourceRootBindInput = z.infer<typeof SourceRootBindInputSchema>
export const SourceRootRecordSchema = z.object({ version: z.literal(1), source: SourcePinSchema,
  selection: SourceRootSelectionSchema, binding: RootBindingSchema, ownerPrincipalId: IdSchema,
  authorizedByPrincipalId: IdSchema, attestationId: IdSchema, attestationDigest: SourceHashSchema,
  boundAt: z.string().datetime(),
}).strict()
export type SourceRootRecord = z.infer<typeof SourceRootRecordSchema>
export const SourceRootBindResultSchema = z.object({ value: SourceRootRecordSchema, replayed: z.boolean() }).strict()
export const SourceRootGetInputSchema = z.object({ workspaceId: IdSchema, rootId: z.uuid(), bindingRevision: z.number().int().positive() }).strict()
export const SourceMaterializationRecordSchema = z.object({ receipt: MaterializationReceiptSchema,
  rootPolicyId: IdSchema, rootPolicyRevision: z.string().regex(/^[1-9][0-9]*$/), operationId: IdSchema,
  reservationId: z.uuid(), state: z.enum(['prepared', 'running', 'uncertain', 'closed']),
}).strict()
export type SourceMaterializationRecord = z.infer<typeof SourceMaterializationRecordSchema>
