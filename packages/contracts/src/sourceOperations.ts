import { z } from 'zod'
import { IdSchema } from './schemaPrimitives.js'
import { SourceHashSchema, MaterializationReceiptSchema } from './sourceMaterialization.js'
import { SourceRootRecordSchema, SourceMaterializationRecordSchema, SourcePinSchema, SourceCwdAttestationSchema } from './sourceAdmission.js'
import { TransferIntentSchema } from './byteTransfer.js'
import { RootFilesystemIdentitySchema } from './workspaceRootPolicies.js'
export const SOURCE_OPERATION_EXTENSION = { namespace: 'source-operations-v1', version: 1, maxJsonBytes: 1048576, maxBinaryBytes: 0, maxPending: 2 } as const
export const SourceOperationAttemptSchema = z.object({ placementHash: SourceHashSchema, executionId: IdSchema, attemptId: IdSchema,
  keyRevision: z.number().int().positive().nullable(), authorizationRevision: z.number().int().positive().nullable() }).strict()
export const SourcePreparationIdentitySchema = z.object({ operationId: IdSchema, ownerPrincipalId: IdSchema, expiresAt: z.string().datetime() }).strict()
export const SourcePackageReferenceSchema = z.object({ transferId: z.uuid(), receiptId: z.uuid(), sha256: SourceHashSchema,
  byteSize: z.number().int().nonnegative().max(128 * 1024 * 1024) }).strict()
export const SourceFilesystemOperationSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(1), operation: z.literal('sources.prepare'), identity: SourcePreparationIdentitySchema,
    root: SourceRootRecordSchema, attempt: SourceOperationAttemptSchema, package: SourcePackageReferenceSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.verify'), record: SourceMaterializationRecordSchema,
    relativeCwd: z.string().max(1024).default('') }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.private-repository'), record: SourceMaterializationRecordSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.release'), record: SourceMaterializationRecordSchema }).strict(),
])
export type SourceFilesystemOperation = z.infer<typeof SourceFilesystemOperationSchema>
export const SourceOperationRequestSchema = z.union([SourceFilesystemOperationSchema,
  z.object({ version: z.literal(1), operation: z.literal('sources.authorize'), request: SourceFilesystemOperationSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.transfer-authorize'), transferId: z.uuid() }).strict()])
export type SourceOperationRequest = z.infer<typeof SourceOperationRequestSchema>
export const SourceOperationOwnerSchema = z.object({ identity: SourcePreparationIdentitySchema, root: SourceRootRecordSchema,
  attempt: SourceOperationAttemptSchema, source: SourcePinSchema, record: SourceMaterializationRecordSchema.nullable(),
  physicalClosureConfirmed: z.boolean() }).strict()
export type SourceOperationOwner = z.infer<typeof SourceOperationOwnerSchema>
export const PrivateSourceRepositoryResultSchema = z.object({ workTree: z.string().startsWith('/'), gitDirectory: z.string().startsWith('/'),
  generatedCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), sourceCommit: z.string().nullable() }).strict()
export const SourceOperationResponseSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(1), operation: z.literal('sources.prepare'), receipt: MaterializationReceiptSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.verify'), workTree: z.string().startsWith('/'),
    canonicalCwd: z.string().startsWith('/'), directoryIdentityHash: SourceHashSchema,
    filesystem: RootFilesystemIdentitySchema, accessMode: z.enum(['read-only', 'exclusive-write']),
    cwdAttestation: SourceCwdAttestationSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.private-repository'), repository: PrivateSourceRepositoryResultSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.release'), materializationId: z.uuid(), operationId: IdSchema, released: z.literal(true) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.authorize'), owner: SourceOperationOwnerSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.transfer-authorize'), intent: TransferIntentSchema }).strict(),
])
export type SourceOperationResponse = z.infer<typeof SourceOperationResponseSchema>
