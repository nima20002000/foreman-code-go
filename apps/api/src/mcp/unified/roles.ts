/** Who is calling the one GraphQL MCP server. Operator credentials manage the app; Worker
 * credentials belong to a workflow Agent whose pinned configuration sets its product role. */
export type McpRole = 'operator' | 'orchestrator' | 'coder'

export const MCP_ROLE_LABELS: Record<McpRole, string> = { operator: 'Operator', orchestrator: 'Orchestrator', coder: 'Coder' }

/** Agent-facing tools. Every other GraphQL MCP tool is Operator-only. Grants and scope are
 * still checked per call by the owning service; a role here is necessary, never sufficient. */
const AGENT_TOOL_ROLES: Readonly<Record<string, readonly McpRole[]>> = {
  context_get: ['orchestrator', 'coder'],
  interaction_list: ['operator', 'orchestrator', 'coder'],
  interaction_get: ['operator', 'orchestrator', 'coder'],
  interaction_respond: ['orchestrator'],
}

export function toolRoles(name: string): readonly McpRole[] {
  return AGENT_TOOL_ROLES[name] ?? ['operator']
}

export function roleList(roles: readonly McpRole[]): string {
  return roles.map((role) => MCP_ROLE_LABELS[role]).join(', ')
}

export function roleInstructions(role: McpRole): string {
  const label = MCP_ROLE_LABELS[role]
  return `GraphQL app tools. Your credential has the ${label} role. Every role sees the same tool names, `
    + 'but a tool whose description starts with a role list (for example "Operator only") is not available to you: '
    + 'calling it returns ROLE_NOT_ALLOWED. Use the other tools; they still check your grants and scope on every call.'
}
