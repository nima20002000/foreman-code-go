import { GRAPHQL_MCP_ROLE_LABELS, graphqlToolRoles, type GraphqlMcpRole } from '@graphql/contracts'

/** The role policy is shared with the web app; see `GRAPHQL_AGENT_TOOLS` in contracts. */
export type McpRole = GraphqlMcpRole
export const MCP_ROLE_LABELS = GRAPHQL_MCP_ROLE_LABELS
export const toolRoles = graphqlToolRoles

export function roleList(roles: readonly McpRole[]): string {
  return roles.map((role) => MCP_ROLE_LABELS[role]).join(', ')
}

export function roleInstructions(role: McpRole): string {
  return `GraphQL app tools. Your credential has the ${MCP_ROLE_LABELS[role]} role, and you see only the tools enabled for you. `
    + 'Every call still checks your grants and scope.'
}
