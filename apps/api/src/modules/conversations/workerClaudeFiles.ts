import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ClaudeNativeSessionManager } from '../harnesses/claudeSdk/sessionManager.js'
import type { createWorkerClaudeAuthority } from './workerClaudeAuthority.js'
import { createClaudeFileCallResolver } from '../files/claude/callResolver.js'
import { createClaudeFileTools, type ClaudeFileSdk } from '../files/claude/sdkServer.js'
import { toolFailure, toolResult } from '../../mcp/shared/results.js'
import { DomainError } from '../errors.js'

export function createWorkerClaudeFiles(input: {
  sdk: ClaudeFileSdk
  manager(): ClaudeNativeSessionManager | undefined
  authority: Pick<ReturnType<typeof createWorkerClaudeAuthority>, 'file'>
  allowMutation: boolean
  signal: AbortSignal
}) {
  const calls = createClaudeFileCallResolver(input)
  let closed = false
  const { server, manifest } = createClaudeFileTools({ sdk: input.sdk, allowMutation: input.allowMutation,
    async invoke(operation, args, extra): Promise<CallToolResult> {
      try {
        if (closed) throw new DomainError('CLAUDE_FILE_CONTEXT_DENIED', 'The file tool owner is closed.', 403)
        const identity = await calls.resolve(operation, extra)
        if (!identity || closed || identity.agentId || identity.parentToolUseId || identity.nativeTurnId
          || !identity.nativeMessageId || !identity.clientCorrelationId || !identity.generation) {
          throw new DomainError('CLAUDE_FILE_NATIVE_CONTEXT_REQUIRED',
          'The file call requires an observed root SDK callback.', 403)
        }
        const result = toolResult(await input.authority.file(identity, operation, args, input.signal))
        return { content: result.content.filter(value => value.type === 'text')
          .map(value => ({ type: 'text', text: value.text })),
        ...(result.structuredContent ? { structuredContent: { ...result.structuredContent } } : {}) }
      } catch (error) {
        const result = toolFailure(error, 'The admitted Claude file request failed.')
        return { isError: true, content: result.content.filter(value => value.type === 'text')
          .map(value => ({ type: 'text', text: value.text })) }
      }
    },
  })
  return { server, manifest, async close() { closed = true; await server.instance.close() } }
}
