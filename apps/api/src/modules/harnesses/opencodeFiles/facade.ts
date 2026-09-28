import { AgentFileApplyFormatEditInputSchema, AgentFileCreateWorkingCopyInputSchema,
  AgentFilePublishInputSchema, AgentFileWriteWorkingCopyInputSchema } from '@graphql/contracts/files'
import { DomainError } from '../../errors.js'
import type { FileMcpService } from '../../files/tools/mcp.js'
import { OpenCodeFileError, type OpenCodeFileService } from './types.js'
import type { OpenCodeFileTurn } from './turn.js'

/** Mount on a dedicated file-only MCP listener for this native turn. Do NOT replace the shared
 * endpoint with a permissive unknown-token fallback: recovered tokens must rebind explicitly.
 * Lazy resolution permits binding the listener before the native token is issued.
 */
export function createOpenCodeFileMcpFacade(service: OpenCodeFileService, turn: () => OpenCodeFileTurn): FileMcpService {
  const invoke = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation() }
    catch (error) {
      if (error instanceof OpenCodeFileError) {
        const forbidden = ['FILE_CONTEXT_DENIED', 'FILE_TOOL_DENIED', 'FILE_TURN_CLOSED'].includes(error.code)
        throw new DomainError(error.code, error.message, forbidden ? 403 : 409)
      }
      throw error
    }
  }
  const owned = (token: string | undefined) => {
    try { const current: OpenCodeFileTurn = turn(); current.assertCredential(token) }
    catch { throw new DomainError('FILE_SESSION_INVALID', 'The file credential does not belong to this native turn.', 401) }
  }
  return {
    sessions: { authenticate: async (token, tool) => {
      owned(token)
      return service.sessions.authenticate(token, tool)
    } },
    list: (token, input) => { owned(token); return service.list(token, input) },
    read: (token, input) => { owned(token); return service.read(token, input) },
    createWorkingCopy: (token, input) => invoke(async () => {
      owned(token)
      return turn().createWorkingCopy(token, AgentFileCreateWorkingCopyInputSchema.parse(input), AbortSignal.timeout(120_000))
    }),
    publish: (token, input) => invoke(async () => {
      owned(token)
      return turn().publish(token, AgentFilePublishInputSchema.parse(input), AbortSignal.timeout(120_000))
    }),
    ...(service.writeWorkingCopy ? { writeWorkingCopy: (token: string, input: unknown) => invoke(async () => {
      owned(token)
      return turn().writeWorkingCopy(token, AgentFileWriteWorkingCopyInputSchema.parse(input))
    }) } : {}),
    ...(service.applyFormatEdit ? { applyFormatEdit: (token: string, input: unknown) => invoke(async () => {
      owned(token)
      return turn().applyFormatEdit(token, AgentFileApplyFormatEditInputSchema.parse(input))
    }) } : {}),
    workingCopyLocation: (token, artifactId) => invoke(() => turn().workingCopyLocation(token, artifactId)),
  }
}
