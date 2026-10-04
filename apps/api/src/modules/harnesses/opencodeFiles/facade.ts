import { AgentFileApplyFormatEditInputSchema, AgentFileCreateWorkingCopyInputSchema,
  AgentFilePublishInputSchema, AgentFileWriteWorkingCopyInputSchema } from '@foreman-code/contracts/files'
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
  const credential = async (token: string | undefined) => {
    try { return await turn().fileCredential(token) }
    catch (error) {
      if (!(error instanceof OpenCodeFileError)) throw error
      throw new DomainError('FILE_SESSION_INVALID', 'The file credential does not belong to this native turn.', 401)
    }
  }
  return {
    sessions: {
      discover: async (token, tool) => {
        try { return await turn().discover(token, tool) }
        catch (error) {
          if (!(error instanceof OpenCodeFileError)) throw error
          throw new DomainError('FILE_SESSION_INVALID', 'The file connection does not belong to this native turn.', 401)
        }
      },
      authenticate: async (token, tool) => service.sessions.authenticate(await credential(token), tool),
    },
    list: async (token, input) => service.list(await credential(token), input),
    read: async (token, input) => service.read(await credential(token), input),
    createWorkingCopy: (token, input) => invoke(async () => {
      const acceptedToken = await credential(token)
      return turn().createWorkingCopy(acceptedToken,
        AgentFileCreateWorkingCopyInputSchema.parse(input), AbortSignal.timeout(120_000))
    }),
    publish: (token, input) => invoke(async () => {
      const acceptedToken = await credential(token)
      return turn().publish(acceptedToken, AgentFilePublishInputSchema.parse(input), AbortSignal.timeout(120_000))
    }),
    ...(service.writeWorkingCopy ? { writeWorkingCopy: (token: string, input: unknown) => invoke(async () => {
      return turn().writeWorkingCopy(await credential(token), AgentFileWriteWorkingCopyInputSchema.parse(input))
    }) } : {}),
    ...(service.applyFormatEdit ? { applyFormatEdit: (token: string, input: unknown) => invoke(async () => {
      return turn().applyFormatEdit(await credential(token), AgentFileApplyFormatEditInputSchema.parse(input))
    }) } : {}),
    workingCopyLocation: (token, artifactId) => invoke(async () =>
      turn().workingCopyLocation(await credential(token), artifactId)),
  }
}
