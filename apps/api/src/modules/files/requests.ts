import { z } from 'zod'
import {
  AgentFileListInputSchema, FileRevisionSchema, FileScopeSchema,
  type FileScope,
} from '@foreman-code/contracts/files'

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
export function fileScopeIdentity(input: FileScope): string {
  const scope = FileScopeSchema.parse(input)
  if (scope.kind === 'job_execution') return JSON.stringify([scope.kind, scope.workspaceId, scope.jobExecutionId])
  if (scope.kind === 'workspace_reference') return JSON.stringify([scope.kind, scope.workspaceId])
  if (scope.kind === 'workflow_reference') return JSON.stringify([scope.kind, scope.workspaceId, scope.workflowId])
  const chat = scope.chat
  return JSON.stringify(chat.kind === 'operator'
    ? ['temporary', 'operator', chat.ownerPrincipalId, chat.operatorId, chat.conversationId]
    : ['temporary', 'agent', chat.conversationId, chat.agentId, chat.workspaceId, chat.workflowId,
      chat.runId ?? null, chat.executionId ?? null])
}
export function fileListInput(scope: FileScope, query: unknown) {
  return AgentFileListInputSchema.parse({ scope, ...FileListQuerySchema.parse(query) })
}
