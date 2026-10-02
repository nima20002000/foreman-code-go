import { z } from 'zod'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema, FileDescriptionSchema,
  FileSha256Schema, MAX_FILE_BYTES, MAX_FILE_READ_BYTES } from './files.js'

// Tool arguments contain no path, execution scope or native authority. The host
// supplies these from the original admitted callback and qualified private store.
export const MAX_NATIVE_OUTPUT_APPEND_BYTES = MAX_FILE_READ_BYTES
const commandId = AgentFilePublishInputSchema.shape.commandId
const artifactId = AgentFilePublishInputSchema.shape.artifactId
export const WorkerNativeOutputOperationSchema = z.enum(['create', 'append', 'seal', 'publish'])
export type WorkerNativeOutputOperation = z.infer<typeof WorkerNativeOutputOperationSchema>
export const WorkerNativeOutputBytesSchema = z.string().max(4 * Math.ceil(MAX_FILE_READ_BYTES / 3))
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/)
  .refine(value => value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
    <= MAX_FILE_READ_BYTES, 'Expected at most 64 KiB of canonical base64')
export const WorkerNativeOutputPublicationInputSchema = FileDescriptionSchema.safeExtend({ commandId, artifactId })
export type WorkerNativeOutputPublicationInput = z.infer<typeof WorkerNativeOutputPublicationInputSchema>
export const WorkerNativeOutputCommandSchema = z.discriminatedUnion('operation', [
  FileDescriptionSchema.safeExtend({ operation: z.literal('create'), commandId }),
  z.object({ operation: z.literal('append'), commandId, artifactId,
    offset: z.number().int().min(0).max(MAX_FILE_BYTES), contentBase64: WorkerNativeOutputBytesSchema }).strict(),
  z.object({ operation: z.literal('seal'), commandId, artifactId }).strict(),
  z.object({ operation: z.literal('publish'), publication: WorkerNativeOutputPublicationInputSchema }).strict(),
])
export type WorkerNativeOutputCommand = z.infer<typeof WorkerNativeOutputCommandSchema>
export const WorkerNativeOutputReplySchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), artifactId, byteSize: z.literal(0) }).strict(),
  z.object({ operation: z.literal('append'), artifactId, byteSize: z.number().int().min(0).max(MAX_FILE_BYTES) }).strict(),
  z.object({ operation: z.literal('seal'), artifactId, sha256: FileSha256Schema,
    byteSize: z.number().int().min(0).max(MAX_FILE_BYTES) }).strict(),
  z.object({ operation: z.literal('publish'), result: AgentFilePublishResultSchema }).strict(),
])
export type WorkerNativeOutputReply = z.infer<typeof WorkerNativeOutputReplySchema>
// Descriptions/mapping do not grant authority. Main and the qualified host check
// current original owner, native turn, accepted sandbox and allowlist each call.
export const WORKER_NATIVE_OUTPUT_FILE_OPERATIONS = {
  create: 'files.write_working_copy', append: 'files.write_working_copy',
  seal: 'files.write_working_copy', publish: 'files.publish_result',
} as const
export const WORKER_NATIVE_OUTPUT_TOOL_NAMES = {
  create: 'files.native_output_create', append: 'files.native_output_append',
  seal: 'files.native_output_seal', publish: 'files.native_output_publish',
} as const
