import type { createSdkMcpServer, tool, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  AgentFileListInputSchema, AgentFileReadInputSchema, AgentFileCreateWorkingCopyInputSchema,
  AgentFileWriteWorkingCopyInputSchema, AgentFileApplyFormatEditInputSchema, AgentFilePublishInputSchema,
} from '@graphql/contracts/files'
import { toolFailure, toolResult } from '../../../mcp/shared/results.js'
import { DomainError } from '../../errors.js'
import { ClaudeFileBridge, type ClaudeFileAdmission } from '../../harnesses/claudeSdk/files.js'
import type { ClaudeCallbackIdentity } from '../../harnesses/claudeSdk/interactions.js'
import type { AgentFileToolService } from '../tools/service.js'
import { isMutation } from '../tools/context.js'
import type { FileToolOperation } from '../tools/types.js'
import type { ClaudeMcpToolManifest } from '../../harnesses/claudeSdk/mcpPolicy.js'

export type ClaudeFileSdk = { createSdkMcpServer: typeof createSdkMcpServer; tool: typeof tool }
/** Resolves evidence captured by the native owner, never fields from tool arguments.
 * SDK 0.3.284 supplies `extra: unknown`; its installed provider-owned tool-use
 * metadata must resolve through the manager's unique observed root context.
 */
export interface ClaudeFileCallResolver {
  resolve(operation: FileToolOperation, extra: unknown): Promise<ClaudeCallbackIdentity | undefined>
}

/** Call after life admission. Importing/allocating an owner need not load an SDK,
 * create credentials or query native state. No token is exposed to the model.
 */
export function createClaudeFileMcpServer(input: {
  sdk: ClaudeFileSdk
  service: AgentFileToolService
  admission: ClaudeFileAdmission
  calls: ClaudeFileCallResolver
  allowMutation: boolean
}): { server: McpSdkServerConfigWithInstance; manifest: ClaudeMcpToolManifest; close(): Promise<void> } {
  const bridges = new Set<ClaudeFileBridge>()
  let closed = false
  const invoke = async (operation: FileToolOperation, args: unknown, extra: unknown): Promise<CallToolResult> => {
    try {
      if (closed || (isMutation(operation) && !input.allowMutation)) throw new DomainError(
        'CLAUDE_FILE_CONTEXT_DENIED', 'The admitted Claude owner does not allow this file operation.', 403)
      const identity = await input.calls.resolve(operation, extra)
      if (closed || !identity?.ownerPrincipalId || !identity.nativeSessionId || !identity.nativeMessageId
        || identity.nativeTurnId !== undefined || !identity.clientCorrelationId || !identity.attemptId
        || !identity.generation || !identity.toolUseId || identity.agentId || identity.parentToolUseId) {
        throw new DomainError('CLAUDE_FILE_NATIVE_CONTEXT_REQUIRED',
          'An exact observed native message and admitted root callback identity are required.', 403)
      }
      // The resolver binds each call; the bridge re-fetches admission and the
      // existing file service re-fetches the principal/grants for every effect.
      const bridge = new ClaudeFileBridge(identity, input.admission, input.service)
      bridges.add(bridge)
      let result: ReturnType<typeof toolResult>
      try {
        result = toolResult(await bridge.call(operation, args))
      } finally {
        await bridge.close()
        bridges.delete(bridge)
      }
      // The app uses MCP 2; the official Claude SDK uses MCP 1. Project only
      // shared text/structured result fields, without casting server protocols.
      return { content: result.content.filter(value => value.type === 'text').map(value => ({ type: 'text', text: value.text })),
        ...(result.structuredContent ? { structuredContent: Object.fromEntries(Object.entries(result.structuredContent)) } : {}) }
    } catch (error) {
      const result = toolFailure(error, 'The admitted Claude file service could not complete the request.')
      return { isError: true, content: result.content.filter(value => value.type === 'text').map(value => ({ type: 'text', text: value.text })) }
    }
  }
  const sdk = input.sdk
  const definitions = [
    sdk.tool('files.list', 'List metadata in the admitted conversation scope.',
      { ...AgentFileListInputSchema.shape, limit: AgentFileListInputSchema.shape.limit.unwrap().optional() },
      (args, extra) => invoke('files.list', args, extra), { annotations: { readOnlyHint: true, openWorldHint: false } }),
    sdk.tool('files.read', 'Read bounded bytes of exact file and revision pins.',
      { ...AgentFileReadInputSchema.shape, offset: AgentFileReadInputSchema.shape.offset.unwrap().optional(), length: AgentFileReadInputSchema.shape.length.unwrap().optional() },
      (args, extra) => invoke('files.read', args, extra), { annotations: { readOnlyHint: true, openWorldHint: false } }),
    ...(input.allowMutation ? [
      sdk.tool('files.create_working_copy', 'Create a temporary owned artifact from authorized pinned bytes.', AgentFileCreateWorkingCopyInputSchema.shape,
        (args, extra) => invoke('files.create_working_copy', args, extra)),
      sdk.tool('files.write_working_copy', 'Replace bytes of an owned temporary working copy.', AgentFileWriteWorkingCopyInputSchema.shape,
        (args, extra) => invoke('files.write_working_copy', args, extra)),
      sdk.tool('files.apply_format_edit', 'Edit an owned temporary working copy using the shared format contract.', AgentFileApplyFormatEditInputSchema.shape,
        (args, extra) => invoke('files.apply_format_edit', args, extra)),
      sdk.tool('files.publish_result', 'Publish a completed temporary artifact in its originating conversation.', AgentFilePublishInputSchema.shape,
        (args, extra) => invoke('files.publish_result', args, extra)),
    ] : []),
  ]
  const server = sdk.createSdkMcpServer({ name: 'graphql-files', version: '1.0.0', tools: definitions,
    instructions: 'File-only admitted native message tools. Scope fields assert the admitted conversation; they cannot select another owner. Permanent references are read-only.' })
  const manifest: ClaudeMcpToolManifest = { serverName: 'graphql-files',
    source: { kind: 'sdk', name: 'graphql-files', version: '1.0.0' },
    tools: definitions.map(definition => definition.name) }
  return { server, manifest, close: async () => {
    closed = true
    await Promise.all([...bridges].map(bridge => bridge.close()))
    bridges.clear()
    await server.instance.close()
  } }
}
