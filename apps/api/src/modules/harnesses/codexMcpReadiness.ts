import { codexRequest } from './codexProtocol.js'
import type { CodexStdioTransport } from './codexStdioTransport.js'
import { HarnessExecutionError } from './errors.js'

/** Read the session's runtime catalog, since configured servers can fail during startup. */
export async function requireCodexAppMcp(
  transport: Pick<CodexStdioTransport, 'request'>, threadId: string, serverName: string, signal: AbortSignal,
): Promise<void> {
  const cursors = new Set<string>()
  let cursor: string | undefined
  try {
    do {
      const page = await codexRequest(transport, 'mcpServerStatus/list', {
        threadId, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}),
      }, signal)
      const server = page.data.find(entry => entry.name === serverName)
      if (server?.runtimeStatus === 'connected' && !server.toolsError && Object.keys(server.tools).length > 0) return
      if (server) break
      cursor = page.nextCursor ?? undefined
      if (cursor && cursors.has(cursor)) break
      if (cursor) cursors.add(cursor)
    } while (cursor)
  } catch (error) {
    signal.throwIfAborted()
    throw new HarnessExecutionError('CODEX_APP_MCP_NOT_READY',
      'Foreman Code MCP readiness could not be verified. Retry the activation.', true, { cause: error })
  }
  throw new HarnessExecutionError('CODEX_APP_MCP_NOT_READY',
    'Foreman Code MCP did not start or exposes no tools in this session. Retry the activation.', true)
}
