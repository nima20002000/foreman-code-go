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
export const MaterializationReceiptSchema = z.object({
  version: z.literal(1), materializationId: z.uuid(), binding: RootBindingSchema,
  placementHash: SourceHashSchema, executionId: IdSchema, attemptId: IdSchema,
  keyRevision: z.number().int().positive().nullable(), authorizationRevision: z.number().int().positive().nullable(),
  verifiedManifestDigest: SourceHashSchema, verifiedEntries: z.number().int().nonnegative(),
  verifiedBytes: z.number().int().nonnegative(), verifiedAt: z.string().datetime(),
  localTreeIdentity: z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/), mountId: z.string().regex(/^\d+$/) }).strict(),
}).strict()
export type MaterializationReceipt = z.infer<typeof MaterializationReceiptSchema>
