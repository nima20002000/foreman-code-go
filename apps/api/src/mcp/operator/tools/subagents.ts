import type { McpServer } from '@modelcontextprotocol/server'
import { RunSubagentsListInputSchema, RunSubagentGetInputSchema, RunSubagentItemsInputSchema, RunSubagentInputSchema, RunSubagentInterruptSchema,
  RunSubagentsPageSchema, RunSubagentDetailSchema, RunSubagentMessagesPageSchema, RunSubagentToolsPageSchema,
  RunSubagentCommandReceiptSchema, RunSubagentRespondSchema } from '@foreman-code/contracts/subagents'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerSubagentTools(server: McpServer, context: OperatorRequestContext) {
  if (!context.services.runs?.subagents) return
  const service = context.services.runs.subagents
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  const command = { ...read, readOnlyHint: false }
  if (operatorToolAvailable(context, 'run_subagents_list_v1')) server.registerTool('run_subagents_list_v1', {
    description: 'List durable native children attached to one exact Run, including completed children, native mode, evidence, coverage and qualified capabilities. Requires scoped runs:read. These records never edit the saved Board.',
    inputSchema: RunSubagentsListInputSchema, outputSchema: RunSubagentsPageSchema, annotations: read,
  }, input => invokeOperatorTool(context, 'run_subagents_list_v1', () => service.list(context.principal, input)))
  if (operatorToolAvailable(context, 'run_subagent_get_v1')) server.registerTool('run_subagent_get_v1', {
    description: 'Read the exact child, its pending native interaction and currently available actions. Native protocol support, app qualification and live computer ownership are separate; unavailable controls grant no session access. Codex supports child turn steering, idle input, targeted interruption and explicit approval/input responses through its admitted owner.',
    inputSchema: RunSubagentGetInputSchema, outputSchema: RunSubagentDetailSchema, annotations: read,
  }, input => invokeOperatorTool(context, 'run_subagent_get_v1', () => service.get(context.principal, input)))
  if (operatorToolAvailable(context, 'run_subagent_messages_list_v1')) server.registerTool('run_subagent_messages_list_v1', {
    description: 'Read a bounded chronological child transcript page with native identity, provenance, finality and truncation/coverage. Re-read from the start to refresh changed messages; cursor is for older immutable ordering, scoped to this child.',
    inputSchema: RunSubagentItemsInputSchema, outputSchema: RunSubagentMessagesPageSchema, annotations: read,
  }, input => invokeOperatorTool(context, 'run_subagent_messages_list_v1', () => service.messages(context.principal, input)))
  if (operatorToolAvailable(context, 'run_subagent_tools_list_v1')) server.registerTool('run_subagent_tools_list_v1', {
    description: 'Read child tool calls and native results with sanitized arguments, errors, timings and truncation/coverage. Tool-like model text is never execution evidence. Requires scoped runs:read.',
    inputSchema: RunSubagentItemsInputSchema, outputSchema: RunSubagentToolsPageSchema, annotations: read,
  }, input => invokeOperatorTool(context, 'run_subagent_tools_list_v1', () => service.tools(context.principal, input)))
  if (operatorToolAvailable(context, 'run_subagent_input_v1')) server.registerTool('run_subagent_input_v1', {
    description: 'Send exact child input only where qualified, currently available and owned by its admitted computer manager. Requires runs:read plus explicit runs:subagents:input on the same Run. Pin expectedRevision and retain commandId. A native ACK is acceptance, not consumption. Uncertain retries read the receipt without resending. Codex active input targets the child turn; idle input preserves the child settings. Claude direct input is unavailable.',
    inputSchema: RunSubagentInputSchema, outputSchema: RunSubagentCommandReceiptSchema, annotations: command,
  }, input => invokeOperatorTool(context, 'run_subagent_input_v1', () => service.input(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'run_subagent_interrupt_v1')) server.registerTool('run_subagent_interrupt_v1', {
    description: 'Interrupt one exact active child only with qualified targeted cancellation, current computer lease, scoped runs:stop and runs:read. Pin expectedRevision and retain commandId. ACK never marks the child finished; observed provider cancellation remains required. Codex interruption addresses the child thread and turn.',
    inputSchema: RunSubagentInterruptSchema, outputSchema: RunSubagentCommandReceiptSchema, annotations: { ...command, destructiveHint: true },
  }, input => invokeOperatorTool(context, 'run_subagent_interrupt_v1', () => service.interrupt(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'run_subagent_respond_v1')) server.registerTool('run_subagent_respond_v1', {
    description: 'Answer the owned child callback from run_subagent_get_v1 using its nativeRequestId and an offered '
      + 'optionId. Supply response for questions/forms. Requires scoped runs:read and interactions:respond. '
      + 'Pin expectedRevision and reuse commandId with identical input after response loss; uncertain responses are never resent.',
    inputSchema: RunSubagentRespondSchema, outputSchema: RunSubagentCommandReceiptSchema, annotations: command,
  }, input => invokeOperatorTool(context, 'run_subagent_respond_v1', () => service.respond(context.principal, 'mcp', input)))
}
