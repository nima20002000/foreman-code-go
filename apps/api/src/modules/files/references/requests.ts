import { z } from 'zod'
import {
  AgentFileListInputSchema, AgentFileReadInputSchema, AgentFileReadResultSchema,
  FileWithRevisionSchema, MessageAttachmentRefSchema, PermanentFileScopeSchema,
  FileRetentionSaveInputSchema, MAX_FILE_BYTES,
} from '@foreman-code/contracts/files'
import { FileUploadRequestSchema } from '../requests.js'

/** Backend transport composition only; the frozen contracts have no reference mutation envelopes. */
export const MAX_REFERENCE_BASE64_CHARACTERS = 4 * Math.ceil(MAX_FILE_BYTES / 3)
// Full-sized MCP add remains usable without granting host paths/URLs or requiring an HTTP side channel.
export const MAX_REFERENCE_MCP_BODY_BYTES = MAX_REFERENCE_BASE64_CHARACTERS + 64 * 1024
export const FileReferenceListInputSchema = AgentFileListInputSchema.extend({ scope: PermanentFileScopeSchema })
export const FileReferenceReadInputSchema = AgentFileReadInputSchema.extend({ scope: PermanentFileScopeSchema })
export const FileReferenceReadResultSchema = z.object({ value: AgentFileReadResultSchema }).strict()
export const FileReferenceAddInputSchema = z.object({
  scope: PermanentFileScopeSchema,
  upload: FileUploadRequestSchema,
  contentBase64: z.string().max(MAX_REFERENCE_BASE64_CHARACTERS),
}).strict()
export const FileReferenceRemoveBodySchema = z.object({
  commandId: FileRetentionSaveInputSchema.shape.commandId,
}).strict()
export const FileReferenceRemoveInputSchema = FileReferenceRemoveBodySchema.extend(MessageAttachmentRefSchema.shape)
export const FileReferenceRemoveToolInputSchema = FileReferenceRemoveInputSchema.extend({ scope: PermanentFileScopeSchema })
export const FileReferenceMutationResultSchema = z.object({
  value: FileWithRevisionSchema.refine((row) => row.file.scope.kind !== 'temporary', 'Expected a permanent reference'),
  replayed: z.boolean(),
}).strict()
