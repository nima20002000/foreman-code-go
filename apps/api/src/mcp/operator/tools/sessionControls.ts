import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { SessionControlRequestSchema, SessionControlStateSchema } from '@graphql/contracts'
import type { OperatorRequestContext } from '../types.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'

export function registerSessionControlTools(server: McpServer, context: OperatorRequestContext) {
  const id = z.string().min(1)
  for (const role of ['operator', 'agent'] as const) {
    const chat = role === 'operator' ? context.services.operatorChat : context.services.agentChat
    if (!chat) continue
    const target = z.object({ conversationId: id, workspaceId: id.optional() }).strict()
    const get = `${role}_chat_controls_get` as const
    const update = `${role}_chat_controls_update` as const
    const read = async (conversationId: string, workspaceId?: string) => {
      if (role === 'operator') return context.services.operatorChat!.readSessionControls(conversationId, context.principal)
      return context.services.agentChat!.readSessionControls(context.principal, id.parse(workspaceId), conversationId)
    }
    if (operatorToolAvailable(context, get)) server.registerTool(get, {
      description: 'Read native session controls, capabilities, context and desired/applied settings for this conversation. Agent chat requires workspaceId. No model turn is sent. Requires the matching chat read grant.',
      inputSchema: target, outputSchema: SessionControlStateSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ conversationId, workspaceId }) => invokeOperatorTool(context, get, () => read(conversationId, workspaceId)))
    if (operatorToolAvailable(context, update)) server.registerTool(update, {
      description: 'Compact the existing idle native session or change subsequent-turn mode/context preferences. Requires matching chat write and read grants. Use expectedRevision from controls_get; reuse requestId and identical input after response loss. Read to recover uncertain compaction; never issue a second identity. A running Operator cannot compact itself. Mode changes do not send a task or broaden permissions.',
      inputSchema: target.extend({ request: SessionControlRequestSchema }), outputSchema: SessionControlStateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ conversationId, workspaceId, request }) => invokeOperatorTool(context, update, () => role === 'operator'
      ? context.services.operatorChat!.changeSessionControls(conversationId, request, context.principal, 'mcp')
      : context.services.agentChat!.changeSessionControls(context.principal, id.parse(workspaceId), conversationId, request, 'mcp')))
  }
}
