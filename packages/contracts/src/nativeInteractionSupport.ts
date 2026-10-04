import { z } from 'zod'

export const NativeInteractionSupportSchema = z.object({
  kind: z.string().min(1),
  nativeMethod: z.string().min(1),
  label: z.string().min(1),
  supported: z.string().min(1),
  unsupported: z.string().min(1),
}).strict()
export type NativeInteractionSupport = z.infer<typeof NativeInteractionSupportSchema>

/** Application response support, independent of native installation readiness. */
export const CODEX_INTERACTION_SUPPORT: NativeInteractionSupport[] = [
  {
    kind: 'tool_user_input', nativeMethod: 'item/tool/requestUserInput', label: 'MCP tool approval questions',
    supported: 'One blocking question with an mcp_tool_call_approval_ ID, header “Approve app tool call?”, '
      + 'no free-text or secret input, and Allow and Cancel choices. Optional choices are '
      + 'Allow for this session and Allow and don\'t ask me again. Only offered choices can be selected; '
      + 'ephemeral sessions do not offer session allowances.',
    unsupported: 'Generic questions, multiple questions, free-text or secret input, nonblocking questions, '
      + 'and other approval question shapes are unsupported. No answers are supplied for them.',
  },
  {
    kind: 'mcp_elicitation', nativeMethod: 'mcpServer/elicitation/request', label: 'MCP confirmations',
    supported: 'Requests belonging to the active turn: URL authorization confirmations with a URL and '
      + 'elicitation ID, or form, openai/form and openaiForm confirmations with an object schema, '
      + 'no properties or required fields, and only type, properties, required, additionalProperties, '
      + 'title, description and $schema keywords. additionalProperties must be boolean when present. '
      + 'Session or persistent allowances require explicit MCP tool approval metadata; '
      + 'ephemeral sessions do not offer session allowances.',
    unsupported: 'Data-entry forms, other form schemas, and standalone elicitations without an active turn '
      + 'are unsupported and are declined without supplying data.',
  },
]

export const CODEX_UNSUPPORTED_INTERACTION_ERRORS = {
  CODEX_GENERIC_QUESTION_UNSUPPORTED: 'Generic Codex questions are unsupported. '
    + 'Only the supported MCP tool approval question can be answered; no answers were supplied.',
  CODEX_MCP_DATA_ENTRY_UNSUPPORTED: 'MCP data-entry forms are unsupported. '
    + 'Only URL authorization and no-data confirmations are supported; no form data was supplied.',
  CODEX_MCP_FORM_SCHEMA_UNSUPPORTED: 'This MCP elicitation schema is unsupported. '
    + 'Only URL authorization and no-data object confirmations are supported; no form data was supplied.',
  CODEX_STANDALONE_ELICITATION_UNSUPPORTED: 'Standalone MCP elicitations are unsupported. '
    + 'Confirmations must belong to the active Codex turn; no data was supplied.',
} as const
export type CodexUnsupportedInteractionCode = keyof typeof CODEX_UNSUPPORTED_INTERACTION_ERRORS

export function codexUnsupportedInteractionMessage(code: unknown): string | undefined {
  if (typeof code !== 'string' || !Object.hasOwn(CODEX_UNSUPPORTED_INTERACTION_ERRORS, code)) return undefined
  return CODEX_UNSUPPORTED_INTERACTION_ERRORS[code as CodexUnsupportedInteractionCode]
}
