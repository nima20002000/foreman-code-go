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
  bug_report: {
    label: 'Report a bug',
    description: 'Always available to workflow Agents. Report a Foreman Code feature or MCP tool failure. '
      + 'Summarize inputs without secrets; reporter, workspace, time and harness are derived by the server. '
      + 'Requires the scoped reporting grant. Retry the same commandId and input.',
    roles: ['operator', 'orchestrator', 'coder'],
  },
  context_get: { label: "Read run context", description: "Its own identity, role, scope and enabled tools.", roles: ["orchestrator", "coder"] },
  interaction_list: { label: "List interactions", description: "Approval requests in its run.", roles: ["operator", "orchestrator", "coder"] },
  interaction_get: { label: "Read an interaction", description: "One approval request and its options.", roles: ["operator", "orchestrator", "coder"] },
  interaction_respond: { label: "Respond to approvals", description: "Answer user-handled approvals as Operator or assigned approvals as Orchestrator, with scoped response grants.", roles: ["operator", "orchestrator"] },
  "files.native_output_create": {
    label: "Create workflow output", description: "Create an opaque output for this declared workflow turn.",
    roles: ["orchestrator", "coder"],
  },
  "files.native_output_append": {
    label: "Append workflow output", description: "Append bounded bytes to this turn's output.",
    roles: ["orchestrator", "coder"],
  },
  "files.native_output_seal": {
    label: "Seal workflow output", description: "Freeze this turn's output bytes before publication.",
    roles: ["orchestrator", "coder"],
  },
  "files.native_output_publish": {
    label: "Publish workflow output", description: "Publish this turn's sealed output under its saved permissions.",
    roles: ["orchestrator", "coder"],
  },
  ci_run: { label: "Run CI", description: "Run install, typecheck, lint, unit, build or integration directly on a build computer. Tests the requested commit, the Agent's current files published to GitHub, or the default branch head. Retry the same commandId and payload. Integration supports 2–12 partitions on separate computers.", roles: ["operator", "orchestrator", "coder"] },
  ci_get: { label: "Read CI result", description: "Read CI run state, current step, computer, exit code and bounded log tail by ticketId.", roles: ["operator", "orchestrator", "coder"] },
  ci_computers_list: { label: "List CI computers", description: "Read authorized build computers with readiness, GitHub login, size and running CI runs.", roles: ["operator", "orchestrator", "coder"] },
  ci_cancel: { label: "Cancel CI", description: "Cancel a queued or running CI run by ticketId. Requires jobs:cancel. Poll ci_get to confirm the outcome.", roles: ["operator", "orchestrator", "coder"] },
  ci_logs_read: { label: "Read CI logs", description: "Read CI log text by ticketId. Omit afterOffset for the last maxBytes, or continue with nextOffset.", roles: ["operator", "orchestrator", "coder"] },
} as const satisfies Record<string, { label: string; description: string; roles: readonly GraphqlMcpRole[] }>;

/** Explicit Operator catalog. Listing a tool never supplies a grant or native qualification. */
export const GRAPHQL_OPERATOR_TOOLS = {
  workspace_repository_get: {
    label: 'Read workspace project', description: 'Read the prepared repository or an incomplete import by its original command ID.',
    roles: ['operator'], action: 'read-workspace-repository',
    actions: ['workspaces:read', 'workspace_locations:read', 'sources:read', 'source_roots:read'],
    scope: 'workspace', readOnly: true,
  },
  workspace_repository_add: {
    label: 'Prepare workspace project', description: 'Clone a GitHub project, save its location, approve its tracked snapshot and bind its source in one revision-checked command.',
    roles: ['operator'], action: 'prepare-workspace-repository',
    actions: ['workspaces:read', 'workspaces:update', 'workspace_locations:read', 'workspace_locations:validate',
      'workspace_locations:update', 'workspace_locations:provision', 'sources:read', 'sources:approve', 'source_roots:read', 'source_roots:bind'],
    scope: 'workspace', readOnly: false,
  },
  operator_tool_schema_get: { label: 'Read Operator tool schema', description: 'Read one caller-available tool’s input schema and instructions; output schema is opt-in.', roles: ['operator'], action: 'read-operator-tool-schema', actions: ['capabilities:read'], scope: 'caller', readOnly: true },
  workspace_root_configuration_adopt: { label: "Adopt protected root configuration", description: "Audit adoption of the selected host's approved roots, including private product storage approved by human computer pairing. Arbitrary user paths require explicit local approval; caller paths are not accepted.", roles: ["operator"], action: "adopt-workspace-root-configuration", actions: ["source_roots:bind", "workspace_locations:update"], scope: "workspace", readOnly: false },
} as const satisfies Record<string, { label: string; description: string; roles: readonly GraphqlMcpRole[]; action: string; actions: readonly string[]; scope: "run" | "workspace" | "caller"; readOnly: boolean }>;

export const GraphqlAgentToolSchema = z.enum(
  Object.keys(GRAPHQL_AGENT_TOOLS) as [keyof typeof GRAPHQL_AGENT_TOOLS, ...(keyof typeof GRAPHQL_AGENT_TOOLS)[]],
);
export type GraphqlAgentTool = z.infer<typeof GraphqlAgentToolSchema>;

/** An Agent's default tools. Absent enables every role tool; bug_report is always included. */
export const GraphqlToolDefaultsSchema = z.array(GraphqlAgentToolSchema).max(100)
  .refine((tools) => new Set(tools).size === tools.length, "Foreman Code MCP tools must be unique");

/** A workflow node's tool changes. bug_report remains available even when named in remove. */
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

/** Applies saved tool choices within the role. Bug reporting is available to every workflow Agent. */
export function effectiveGraphqlTools(
  role: "orchestrator" | "coder", defaults?: readonly string[], override?: GraphqlToolOverride,
): GraphqlAgentTool[] {
  const roleTools = graphqlRoleTools(role);
  const enabled = new Set<string>(defaults ?? roleTools);
  for (const tool of override?.add ?? []) enabled.add(tool);
  for (const tool of override?.remove ?? []) enabled.delete(tool);
  enabled.add('bug_report');
  return roleTools.filter((tool) => enabled.has(tool));
}
