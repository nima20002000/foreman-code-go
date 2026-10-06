import { z } from 'zod'
import { IdSchema } from './schemaPrimitives.js'

export const SourceHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const SourceEntrySchema = z.object({
  path: z.string().min(1).max(1024), kind: z.literal('file'),
  byteSize: z.number().int().nonnegative().max(16 * 1024 * 1024),
  sha256: SourceHashSchema, executable: z.boolean(),
}).strict()
export const SourceManifestSchema = z.object({
  version: z.literal(1), snapshotId: z.uuid(), approvedSourceId: z.uuid(),
  capturePolicy: z.enum(['git-tree-v1', 'exclusive-explicit-bytes-v1']),
  executablePolicy: z.enum(['strip', 'preserve-approved']),
  git: z.object({ commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), objectFormat: z.enum(['sha1', 'sha256']) }).strict().optional(),
  entries: z.array(SourceEntrySchema).max(4096),
  deletions: z.array(z.string().min(1).max(1024)).max(4096),
  overlayBaseDigest: SourceHashSchema.optional(),
  totalEntries: z.number().int().nonnegative().max(4096),
  totalBytes: z.number().int().nonnegative().max(128 * 1024 * 1024),
  manifestDigest: SourceHashSchema,
}).strict()
export type SourceEntry = z.infer<typeof SourceEntrySchema>
export type SourceManifest = z.infer<typeof SourceManifestSchema>

export const RootBindingSchema = z.object({
  version: z.literal(1), mainId: z.uuid(), deviceId: z.uuid().nullable(), workerInstallationId: z.uuid().nullable(),
  workspaceId: IdSchema, rootId: z.uuid(), bindingRevision: z.number().int().positive(),
  locationRevision: z.number().int().positive(), canonicalPath: z.string().min(1),
  filesystem: z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/), mountId: z.string().regex(/^\d+$/) }).strict(),
  accessMode: z.enum(['read-only', 'exclusive-write']), snapshotId: z.uuid(), manifestDigest: SourceHashSchema,
}).strict()
export type RootBinding = z.infer<typeof RootBindingSchema>
export const SourceProjectQuotaSlotSchema = z.object({
  namespace: z.uuid(), projectId: z.number().int().min(1).max(4294967295),
  hardLimitBytes: z.number().int().positive(), hardInodes: z.number().int().positive(),
  filesystem: RootBindingSchema.shape.filesystem,
}).strict()
export type SourceProjectQuotaSlot = z.infer<typeof SourceProjectQuotaSlotSchema>
export const MaterializationReceiptSchema = z.object({
  version: z.literal(1), materializationId: z.uuid(), binding: RootBindingSchema,
  quota: SourceProjectQuotaSlotSchema.optional(),
  placementHash: SourceHashSchema, executionId: IdSchema, attemptId: IdSchema,
  keyRevision: z.number().int().positive().nullable(), authorizationRevision: z.number().int().positive().nullable(),
  verifiedManifestDigest: SourceHashSchema, verifiedEntries: z.number().int().nonnegative(),
  verifiedBytes: z.number().int().nonnegative(), verifiedAt: z.string().datetime(),
  claimScope: z.literal('execution').optional(),
  sharedTree: z.object({ id: z.uuid(), referenceIdentity: RootBindingSchema.shape.filesystem }).strict().optional(),
  localTreeIdentity: z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/), mountId: z.string().regex(/^\d+$/) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.sharedTree && (value.binding.accessMode !== 'exclusive-write' || value.claimScope !== 'execution')) {
    context.addIssue({ code: 'custom', path: ['sharedTree'], message: 'Shared working trees require a writable execution claim.' })
  }
})
export type MaterializationReceipt = z.infer<typeof MaterializationReceiptSchema>

export function sourceMaterializationComponents(receipt: Pick<MaterializationReceipt, 'materializationId' | 'quota'>): string[] {
  return [...(receipt.quota ? [receipt.quota.namespace] : []), receipt.materializationId]
}
export function sourceMaterializationParent(receipt: MaterializationReceipt): string {
  return [receipt.binding.canonicalPath.replace(/\/$/, ''), ...sourceMaterializationComponents(receipt)].join('/')
}
