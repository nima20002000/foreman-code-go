import { AgentChatQuerySchema } from '@foreman-code/contracts/agent-chat'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { SessionControlRequestSchema, SessionControlStateSchema } from '@foreman-code/contracts'
import type { OperatorRequestContext } from '../types.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'

export function registerSessionControlTools(server: McpServer, context: OperatorRequestContext) {
  const id = z.string().min(1)
  for (const role of ['operator', 'agent'] as const) {
    const chat = role === 'operator' ? context.services.operatorChat : context.services.agentChat
    if (!chat) continue
    const target = z.object({ conversationId: id.optional(), context: AgentChatQuerySchema.optional(), executionId: id.optional(), workspaceId: role === 'agent' ? id : z.never().optional() }).strict().superRefine((value, issue) => {
      if (role === 'operator' && (!value.conversationId || value.context)) issue.addIssue({ code: 'custom', message: 'Operator controls require conversationId.' })
      if (role === 'agent' && (!!value.conversationId === !!value.context)) issue.addIssue({ code: 'custom', message: 'Supply one conversationId or node context.' })
    })
    const get = `${role}_chat_controls_get` as const
    const update = `${role}_chat_controls_update` as const
    const read = async (conversationId: string | undefined, workspaceId?: string, selector?: import('@foreman-code/contracts/agent-chat').AgentChatQuery, executionId?: string) => {
      if (role === 'operator') return context.services.operatorChat!.readSessionControls(id.parse(conversationId), context.principal)
      if (!conversationId && selector) return context.services.agentChat!.readContextControls(context.principal, { workspaceId: id.parse(workspaceId), ...selector }, executionId)
      return context.services.agentChat!.readSessionControls(context.principal, id.parse(workspaceId), id.parse(conversationId))
    }
    if (operatorToolAvailable(context, get)) server.registerTool(get, {
      description: 'Read native session controls, capabilities, context and desired/applied settings for this conversation. Unloaded sessions return saved controls with nativeStatus: resume-required and stale context; a subsequent message or control resumes the native session. Agent chat requires workspaceId and either conversationId or context; fresh context may have no conversation. Historical context requires the selected executionId when multiple executions exist. No model turn is sent. Requires the matching chat read grant.',
      inputSchema: target, outputSchema: SessionControlStateSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ conversationId, workspaceId, context: selector, executionId }) => invokeOperatorTool(context, get, () => read(conversationId, workspaceId, selector, executionId)))
    if (operatorToolAvailable(context, update)) server.registerTool(update, {
      description: 'Compact the existing idle native session or change subsequent-turn mode/context preferences. Requires matching chat write and read grants. Use expectedRevision from controls_get; reuse requestId and identical input after response loss. Read to recover uncertain compaction; never issue a second identity. A running Operator cannot compact itself. Mode changes do not send a task or broaden permissions. Saving future defaults validates supported options and model capacity independently of current history usage, and additionally requires settings:update for Operator or scoped agents:update for agent chat.',
      inputSchema: target.extend({ request: SessionControlRequestSchema }), outputSchema: SessionControlStateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ conversationId, workspaceId, request, context: selector, executionId }) => invokeOperatorTool(context, update, () => role === 'operator'
      ? context.services.operatorChat!.changeSessionControls(id.parse(conversationId), request, context.principal, 'mcp')
      : !conversationId && selector ? context.services.agentChat!.changeContextControls(context.principal, { workspaceId: id.parse(workspaceId), ...selector }, request, 'mcp', executionId)
      : context.services.agentChat!.changeSessionControls(context.principal, id.parse(workspaceId), id.parse(conversationId), request, 'mcp')))
  }
}
