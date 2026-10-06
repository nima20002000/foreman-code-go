import { z } from 'zod'
import { FileMediaTypeSchema, FileRevisionSchema, MAX_FILE_BYTES,
  MessageAttachmentRefsSchema, TemporaryFileScopeSchema } from './files.js'
import { OpenCodeHarnessConfigurationSchema } from './index.js'
import { ManagementPrincipalSchema } from './management/index.js'

const id = z.string().min(1).max(1024)
const token = z.string().regex(/^gql_file_[A-Za-z0-9_-]{43}$/)
const tools = z.enum(['files.list', 'files.read', 'files.create_working_copy',
  'files.publish_result', 'files.write_working_copy', 'files.apply_format_edit'])

export const WorkerOpenCodeFileIdentitySchema = z.object({
  ownerAgentId: id,
  nativeSessionId: id,
  nativeTurnId: id,
  clientCorrelationId: id,
  directory: z.string().startsWith('/').max(4096),
  configuration: z.lazy(() => OpenCodeHarnessConfigurationSchema),
}).strict()
export type WorkerOpenCodeFileIdentity = z.infer<typeof WorkerOpenCodeFileIdentitySchema>

export const WorkerOpenCodeFileContextSchema = z.object({
  ownerPrincipalId: id,
  scope: TemporaryFileScopeSchema,
  nativeSessionId: id,
  turnId: id,
  messageId: id,
  allowMutation: z.boolean(),
  allowedTools: z.array(tools).max(6),
}).strict()
export const WorkerOpenCodeFilePreparationSchema = z.object({
  context: WorkerOpenCodeFileContextSchema,
  attachments: MessageAttachmentRefsSchema,
  expiresAt: z.iso.datetime(),
  sourceHost: z.object({ bootId: z.uuid(), storageRoot: z.string().startsWith('/').max(4096) }).strict(),
}).strict()
export const WorkerOpenCodeFileCallerSchema = z.object({
  context: WorkerOpenCodeFileContextSchema,
  principal: ManagementPrincipalSchema,
  binding: id,
}).strict()
export const WorkerOpenCodeArtifactSchema = z.object({
  artifactId: z.uuid(), binding: id, filename: z.string(), mediaType: FileMediaTypeSchema,
  createdAt: z.iso.datetime(), state: z.enum(['writing', 'complete', 'failed']), writeId: z.uuid(),
  source: z.object({ fileId: id, revisionId: id }).optional(), sourceSha256: z.string().optional(),
  snapshot: z.object({ storageKey: id, revision: FileRevisionSchema }).optional(),
  storageKeys: z.array(id).optional(), retiredAt: z.iso.datetime().optional(),
}).strict()

const artifact = { token, artifactId: z.uuid() }
export const WorkerOpenCodeArtifactRangeSchema = z.object({
  revision: FileRevisionSchema, offset: z.number().int().nonnegative(),
  contentBase64: z.string().max(87384), eof: z.boolean(),
}).strict()
const transfer = { ...artifact, transferId: z.uuid(), writeId: z.uuid() }
export const WorkerOpenCodeFileActionSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('prepare') }).strict(),
  z.object({ phase: z.literal('recover'), context: WorkerOpenCodeFileContextSchema }).strict(),
  z.object({ phase: z.literal('read-input'), input: z.object({ fileId: id, revisionId: id,
    offset: z.number().int().nonnegative(), length: z.number().int().min(1).max(65536) }).strict() }).strict(),
  z.object({ phase: z.literal('issue'), context: WorkerOpenCodeFileContextSchema,
    expiresAt: z.iso.datetime() }).strict(),
  z.object({ phase: z.literal('authorize-accepted'), tool: tools.optional() }).strict(),
  z.object({ phase: z.literal('authenticate'), token: z.string().max(1024).optional(), tool: tools.optional() }).strict(),
  z.object({ phase: z.literal('revoke'), token }).strict(),
  z.object({ phase: z.literal('service'), token, operation: z.enum(['list', 'read', 'createWorkingCopy',
    'writeWorkingCopy', 'applyFormatEdit', 'publish', 'publishedForTurn']), input: z.unknown().optional() }).strict(),
  z.object({ phase: z.literal('artifact-get'), ...artifact }).strict(),
  z.object({ phase: z.literal('artifact-read'), ...artifact,
    offset: z.number().int().nonnegative().max(MAX_FILE_BYTES), length: z.number().int().min(1).max(65536) }).strict(),
  z.object({ phase: z.literal('artifact-begin'), ...artifact, baseRevisionId: id.optional() }).strict(),
  z.object({ phase: z.literal('artifact-abort'), ...artifact, writeId: z.uuid() }).strict(),
  z.object({ phase: z.literal('write-begin'), ...transfer }).strict(),
  z.object({ phase: z.literal('write-chunk'), ...transfer, offset: z.number().int().min(0).max(MAX_FILE_BYTES),
    contentBase64: z.string().max(87384) }).strict(),
  z.object({ phase: z.literal('write-finish'), ...transfer }).strict(),
  z.object({ phase: z.literal('preserve-begin'), transferId: z.uuid(),
    id: z.string().regex(/^[a-f0-9]{64}$/), revision: FileRevisionSchema }).strict(),
  z.object({ phase: z.literal('preserve-chunk'), transferId: z.uuid(),
    offset: z.number().int().min(0).max(MAX_FILE_BYTES), contentBase64: z.string().max(87384) }).strict(),
  z.object({ phase: z.literal('preserve-finish'), transferId: z.uuid() }).strict(),
  z.object({ phase: z.literal('adopt'), context: WorkerOpenCodeFileContextSchema }).strict(),
  z.object({ phase: z.literal('close') }).strict(),
])
export type WorkerOpenCodeFileAction = z.infer<typeof WorkerOpenCodeFileActionSchema>
