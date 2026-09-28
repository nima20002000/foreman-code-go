import { z } from 'zod'
import {
  AgentFileCreateWorkingCopyInputSchema, AgentFileListInputSchema, AgentFilePublishInputSchema,
  AgentFileReadInputSchema, FileWithRevisionSchema, MessageAttachmentRefsSchema,
  TemporaryFileScopeSchema, MAX_FILE_BYTES, MAX_FILE_READ_BYTES, MAX_MESSAGE_ATTACHMENTS,
  parseAgentFileReadResult,
} from '@graphql/contracts/files'
import type { FileToolName } from '../../files/tools/types.js'
import type { NativeImageOptions, ImageMediaType } from '../../files/images/index.js'
import { CODEX_FILE_TOOL_ALIASES, CodexFileTurn, type CodexFileTurnDependencies } from './turn.js'
import type { AcceptedCodexFileTurn } from './port.js'

export { CodexFileTurn, CODEX_FILE_TOOL_ALIASES } from './turn.js'
export type * from './port.js'

const schemas = {
  'files.list': AgentFileListInputSchema,
  'files.read': AgentFileReadInputSchema,
  'files.create_working_copy': AgentFileCreateWorkingCopyInputSchema,
  'files.publish_result': AgentFilePublishInputSchema,
} satisfies Record<FileToolName, z.ZodType>
const descriptions: Record<FileToolName, string> = {
  'files.list': 'List a bounded metadata manifest in an authorized file scope. No file contents.',
  'files.read': 'Read a bounded byte range from the exact fileId and revisionId. Never follows a newer revision.',
  'files.create_working_copy': 'Create a detached temporary working copy in this conversation. In Write mode the result includes its registered execution-host path.',
  'files.publish_result': 'Publish a completed registered working copy as a new immutable temporary file in this turn. Does not replace a source or permanent reference.',
}

/** v0.157 DynamicToolSpec function form. Register only the accepted allowlist.
 * These are native callbacks into FIL-05, not the workflow GraphQL App MCP server.
 * Schema refinements are enforced again on every call, before runner side effects. */
export function codexFileDynamicTools(turn: Pick<CodexFileTurn, 'allowedTools'>) {
  const allowed = turn.allowedTools()
  return Object.entries(CODEX_FILE_TOOL_ALIASES).filter(([, name]) => allowed.includes(name))
    .map(([name, tool]) => ({ type: 'function' as const, name,
      description: descriptions[tool],
      inputSchema: z.toJSONSchema(schemas[tool], { target: 'draft-7', io: 'input' }),
      deferLoading: false,
    }))
}

export interface PrepareCodexFileTurnDependencies extends Omit<CodexFileTurnDependencies,
  'limits' | 'parseCall' | 'parseRead' | 'prepareImage'> {
  /** Supply the accepted model's actual image capabilities; no implicit model claim. */
  nativeImageOptions?: NativeImageOptions
}

/** Composition seam; deliberately not installed into production by this partial lane.
 * source and host MUST come from the authenticated persisted chat/execution, not HTTP fields. */
export async function prepareCodexFileTurn(accepted: AcceptedCodexFileTurn,
  dependencies: PrepareCodexFileTurnDependencies, signal?: AbortSignal): Promise<CodexFileTurn> {
  const { nativeImageOptions, ...rest } = dependencies
  const value: AcceptedCodexFileTurn = { ...accepted,
    scope: TemporaryFileScopeSchema.parse(accepted.scope),
    attachments: MessageAttachmentRefsSchema.parse(accepted.attachments),
  }
  return CodexFileTurn.prepare(value, {
    ...rest,
    source: {
      open: async (ref) => {
        const opened = await dependencies.source.open(ref)
        try { return { value: FileWithRevisionSchema.parse(opened.value), stream: opened.stream } }
        catch (error) { opened.stream.destroy(); throw error }
      },
      recheck: async (ref) => FileWithRevisionSchema.parse(await dependencies.source.recheck(ref)),
    },
    limits: { fileBytes: MAX_FILE_BYTES, readBytes: MAX_FILE_READ_BYTES, attachments: MAX_MESSAGE_ATTACHMENTS },
    parseCall: (tool, arguments_) => schemas[tool].parse(arguments_),
    parseRead: parseAgentFileReadResult,
    ...(nativeImageOptions ? { prepareImage: async (bytes: Uint8Array, mediaType: string) => {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
        throw new Error('CODEX_IMAGE_PREPARATION_INVALID')
      }
      const { prepareNativeImage } = await import('../../files/images/index.js')
      return prepareNativeImage({ bytes, mediaType: mediaType as ImageMediaType }, nativeImageOptions)
    } } : {}),
  }, signal)
}
