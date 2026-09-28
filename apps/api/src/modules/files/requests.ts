import { z } from 'zod'
import {
  AgentFileListInputSchema, FileRevisionSchema, TemporaryFileScopeSchema,
  type TemporaryFileScope,
} from '@graphql/contracts/files'

/** Backend transport envelope only. FIL-02 has no upload/finalize HTTP contracts.
 * Do not duplicate file metadata or scope validation; compose the frozen schemas. */
const description = FileRevisionSchema.unwrap().shape
export const FileUploadRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  filename: description.filename, mediaType: description.mediaType,
  byteSize: description.byteSize, sha256: description.sha256,
}).strict().superRefine((input, context) => {
  const revision = FileRevisionSchema.safeParse({ filename: input.filename, mediaType: input.mediaType,
    byteSize: input.byteSize, sha256: input.sha256, fileId: 'validation', revisionId: 'validation',
    origin: 'upload', createdAt: '2000-01-01T00:00:00.000Z' })
  if (!revision.success) for (const issue of revision.error.issues) {
    context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
  }
})
export type FileUploadRequest = z.infer<typeof FileUploadRequestSchema>

export const FileListQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: z.coerce.number().int().optional(),
}).strict()
export const EmptyFileCommandSchema = z.object({}).strict()

/** Fixed key order is intentional: object key order is not idempotency identity. */
export function fileScopeIdentity(input: TemporaryFileScope): string {
  const scope = TemporaryFileScopeSchema.parse(input)
  const chat = scope.chat
  return JSON.stringify(chat.kind === 'operator'
    ? ['temporary', 'operator', chat.ownerPrincipalId, chat.operatorId, chat.conversationId]
    : ['temporary', 'agent', chat.conversationId, chat.agentId, chat.workspaceId, chat.workflowId,
      chat.runId ?? null, chat.executionId ?? null])
}
export function fileListInput(scope: TemporaryFileScope, query: unknown) {
  return AgentFileListInputSchema.parse({ scope, ...FileListQuerySchema.parse(query) })
}
