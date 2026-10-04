import { z } from "zod";

/** Who is calling the one Foreman Code MCP server. Operator credentials manage the app; Worker
 * credentials belong to a workflow Agent whose pinned configuration sets its product role. */
export type GraphqlMcpRole = "operator" | "orchestrator" | "coder";

export const GRAPHQL_MCP_ROLE_LABELS: Record<GraphqlMcpRole, string> = {
  operator: "Operator", orchestrator: "Orchestrator", coder: "Coder",
};

/** Agent-facing Foreman Code MCP tools. Every other Foreman Code MCP tool is Operator-only and can
 * never be enabled for an Agent. Grants and scope are still checked per call. */
export const GRAPHQL_AGENT_TOOLS = {
  context_get: { label: "Read run context", description: "Its own identity, role, scope and enabled tools.", roles: ["orchestrator", "coder"] },
  interaction_list: { label: "List interactions", description: "Approval requests in its run.", roles: ["operator", "orchestrator", "coder"] },
  interaction_get: { label: "Read an interaction", description: "One approval request and its options.", roles: ["operator", "orchestrator", "coder"] },
  interaction_respond: { label: "Respond to approvals", description: "Answer approval requests it reviews.", roles: ["orchestrator"] },
} as const satisfies Record<string, { label: string; description: string; roles: readonly GraphqlMcpRole[] }>;

/** Explicit Operator catalog. Listing a tool never supplies a grant or native qualification. */
export const GRAPHQL_OPERATOR_TOOLS = {
  workspace_root_configuration_adopt: { label: "Adopt protected root configuration", description: "Audit adoption of the selected host's existing approved roots; no caller paths or execution authority.", roles: ["operator"], action: "adopt-workspace-root-configuration", actions: ["source_roots:bind", "workspace_locations:update"], scope: "workspace", readOnly: false },
} as const satisfies Record<string, { label: string; description: string; roles: readonly GraphqlMcpRole[]; action: string; actions: readonly string[]; scope: "run" | "workspace"; readOnly: boolean }>;

export const GraphqlAgentToolSchema = z.enum(
  Object.keys(GRAPHQL_AGENT_TOOLS) as [keyof typeof GRAPHQL_AGENT_TOOLS, ...(keyof typeof GRAPHQL_AGENT_TOOLS)[]],
);
export type GraphqlAgentTool = z.infer<typeof GraphqlAgentToolSchema>;

/** An Agent's default Foreman Code MCP tools. Absent means every tool its role allows. */
export const GraphqlToolDefaultsSchema = z.array(GraphqlAgentToolSchema).max(100)
  .refine((tools) => new Set(tools).size === tools.length, "Foreman Code MCP tools must be unique");

/** A workflow node's change to its Agent's default Foreman Code MCP tools. */
export const GraphqlToolOverrideSchema = z.object({
  add: z.array(GraphqlAgentToolSchema).max(100),
  remove: z.array(GraphqlAgentToolSchema).max(100),
}).strict().superRefine((value, context) => {
  const removed = new Set(value.remove);
  for (const [index, tool] of value.add.entries()) {
    if (removed.has(tool)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["add", index], message: "a Foreman Code MCP tool cannot be both added and removed" });
  }
});
export type GraphqlToolOverride = z.infer<typeof GraphqlToolOverrideSchema>;

export function graphqlToolRoles(name: string): readonly GraphqlMcpRole[] {
  return (GRAPHQL_AGENT_TOOLS as Record<string, { roles: readonly GraphqlMcpRole[] }>)[name]?.roles
    ?? (GRAPHQL_OPERATOR_TOOLS as Record<string, { roles: readonly GraphqlMcpRole[] }>)[name]?.roles ?? ["operator"];
}

/** The Agent tools a product role may be given, in catalog order. */
export function graphqlRoleTools(role: "orchestrator" | "coder"): GraphqlAgentTool[] {
  return GraphqlAgentToolSchema.options.filter((tool) => graphqlToolRoles(tool).includes(role));
}

/** Tools named here that the role can never use. */
export function graphqlToolsOutsideRole(role: "orchestrator" | "coder", tools: readonly string[]): string[] {
  return tools.filter((tool) => !graphqlToolRoles(tool).includes(role));
}

/** (agent default, or every role tool) + node additions - node removals, never beyond the role. */
export function effectiveGraphqlTools(
  role: "orchestrator" | "coder", defaults?: readonly string[], override?: GraphqlToolOverride,
): GraphqlAgentTool[] {
  const roleTools = graphqlRoleTools(role);
  const enabled = new Set<string>(defaults ?? roleTools);
  for (const tool of override?.add ?? []) enabled.add(tool);
  for (const tool of override?.remove ?? []) enabled.delete(tool);
  return roleTools.filter((tool) => enabled.has(tool));
}
