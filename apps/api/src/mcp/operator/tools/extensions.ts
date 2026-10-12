import type { McpServer } from '@modelcontextprotocol/server'
import { requireAuthorization } from '../../../modules/access/policy.js'
import * as contracts from '@foreman-code/contracts/management'
import { SavedWorkflowVersionPageSchema, SavedWorkflowVersionDetailSchema } from '@foreman-code/contracts/wave25'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorRequestContext } from '../types.js'

export function registerExtendedOperatorTools(server: McpServer, context: OperatorRequestContext): void {
  const extension = context.services.extensions
  if (!extension) return
  if (operatorToolAvailable(context, 'harness_configuration_check')) server.registerTool('harness_configuration_check', {
    description: "Check a proposed native configuration without creating a session or model turn.", inputSchema: contracts.NativeConfigurationCheckInputSchema, outputSchema: contracts.NativeConfigurationCheckResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input, extra) => invokeOperatorTool(context, 'harness_configuration_check', () => context.services.harnesses.checkConfiguration(context.principal, input.configuration, extra.mcpReq.signal)))
  if (operatorToolAvailable(context, 'harness_options_get')) server.registerTool('harness_options_get', {
    description: "Discover authenticated native model IDs, release dates or native default preference, supported efforts/variants, native Agents and field support. Claude uses an owned zero-input SDK control query without a model turn; installation and execution qualification remain separate. No secrets are returned.", inputSchema: contracts.HarnessOptionsInputSchema, outputSchema: contracts.HarnessOptionsResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'harness_options_get', async () => {
    requireAuthorization(context.principal, 'harnesses:read')
    return extension.native.options(input.harness)
  }))
  if (operatorToolAvailable(context, 'harness_options_refresh')) server.registerTool('harness_options_refresh', {
    description: "Reread the configured qualified CLI's model catalog without requesting a models.dev cache update. Requires harnesses:read.", inputSchema: contracts.HarnessOptionsInputSchema, outputSchema: contracts.HarnessOptionsResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'harness_options_refresh', async () => {
    requireAuthorization(context.principal, 'harnesses:read')
    context.services.harnesses.invalidateChecks()
    return extension.native.refreshOptions(input.harness, 'catalog')
  }))
  if (operatorToolAvailable(context, 'harness_mcp_detection_get')) server.registerTool('harness_mcp_detection_get', {
    description: "Inspect MCP configuration in the validated saved workspace directory; requires location-read permission.", inputSchema: contracts.HarnessMcpDetectionInputSchema, outputSchema: contracts.HarnessMcpDetectionResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'harness_mcp_detection_get', () => extension.workspace.diagnostics(context.principal,input)))
  if (operatorToolAvailable(context, 'agent_create')) server.registerTool('agent_create', {
    description: "Create a standalone workspace Agent from an explicit native configuration or a role template. prompt.system holds persistent Agent instructions; assignedSkills lists exact {skillId, version} references from this workspace (skill_list/skill_get), delivered in order after the instructions. Assigning skills needs skills:read; archived, missing or other-workspace skills are rejected. nativeTools overrides the copied role loading policy: mcpServers is an allowlist ([] = Foreman Code only), apps controls apps/connectors and Claude SDK plugins. Omitted policy inherits the role template; {} inherits host settings. Existing credentials do not gain new grants automatically. graphqlTools sets its default Foreman Code MCP tools (absent = every tool its role allows); a workflow node can add/remove tools via its graphqlTools field.", inputSchema: contracts.AgentCreateInputSchema, outputSchema: contracts.AgentMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'agent_create', () => extension.agents.create(context.principal,input)))
  if (operatorToolAvailable(context, 'agent_update')) server.registerTool('agent_update', {
    description: "Revision-check Agent metadata/configuration. nativeTools replaces native MCP/app loading policy; mcpServers is an allowlist, apps is on/off, {} restores host settings, omission keeps the saved policy. Foreman Code is always available under existing role/access grants. Read agent_get to verify persisted policy. graphqlTools replaces its default Foreman Code MCP tools, within its role. Requires authority across every referencing workflow and rejects busy Agents. assignedSkills replaces the ordered exact skill versions; a newer skill version is used only when you set it here. Returns affectedWorkflowIds for every referencing workflow. Re-save those workflows with the returned Agent configuration version before running changed settings. Workflow save updates this Agent’s explicit node placements to the selected profile on the same computer; a different computer is rejected with a node-specific issue. Historical workflow versions and Runs retain their original placements.", inputSchema: contracts.AgentUpdateInputSchema, outputSchema: contracts.AgentMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'agent_update', () => extension.agents.update(context.principal,input)))
  if (operatorToolAvailable(context, 'agent_clone')) server.registerTool('agent_clone', {
    description: "Clone an authorized workspace Agent, including one outside the current board. Does not copy live execution state.", inputSchema: contracts.AgentCloneInputSchema, outputSchema: contracts.AgentMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'agent_clone', () => extension.agents.clone(context.principal,input)))
  if (operatorToolAvailable(context, 'workflow_versions_list')) server.registerTool('workflow_versions_list', {
    description: "List immutable workflow versions in increasing numeric version order.", inputSchema: contracts.WorkflowVersionListInputSchema, outputSchema: SavedWorkflowVersionPageSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'workflow_versions_list', () => extension.history.workflows(context.principal,input)))
  if (operatorToolAvailable(context, 'workflow_version_get')) server.registerTool('workflow_version_get', {
    description: "Inspect one immutable current-semantics-3 version. Re-author its definition through workflow_validate_v3 and workflow_save_v3 with today’s exact base/configuration/location pins; historical versions are never edited.", inputSchema: contracts.WorkflowVersionGetInputSchema, outputSchema: SavedWorkflowVersionDetailSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'workflow_version_get', () => extension.history.workflow(context.principal,input)))
  if (operatorToolAvailable(context, 'agent_configuration_versions_list')) server.registerTool('agent_configuration_versions_list', {
    description: "List immutable Agent configuration versions. Reading resolved skill contents additionally requires skills:read.", inputSchema: contracts.AgentVersionListInputSchema, outputSchema: contracts.AgentVersionPageSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'agent_configuration_versions_list', () => extension.history.agents(context.principal,input)))
  if (operatorToolAvailable(context, 'agent_configuration_version_get')) server.registerTool('agent_configuration_version_get', {
    description: "Inspect a historical Agent configuration in the authorized workspace. Does not start or change an execution.", inputSchema: contracts.AgentVersionGetInputSchema, outputSchema: contracts.AgentVersionResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'agent_configuration_version_get', () => extension.history.agent(context.principal,input)))
  if (operatorToolAvailable(context, 'agent_configuration_restore')) server.registerTool('agent_configuration_restore', {
    description: "Restore historical settings into a new current Agent configuration, with revision, shared-workflow, idle, skill, and native qualification checks.", inputSchema: contracts.AgentVersionRestoreInputSchema, outputSchema: contracts.AgentMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'agent_configuration_restore', () => extension.agents.restore(context.principal,input)))
  if (operatorToolAvailable(context, 'workspace_restore')) server.registerTool('workspace_restore', {
    description: "Unarchive a workspace with an expected revision. Does not restore its children or start work.", inputSchema: contracts.WorkspaceLifecycleInputSchema, outputSchema: contracts.LifecycleResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'workspace_restore', () => extension.lifecycle.restoreWorkspace(context.principal,input)))
  if (operatorToolAvailable(context, 'workflow_restore')) server.registerTool('workflow_restore', {
    description: "Unarchive a workflow in an active workspace without changing history or starting work.", inputSchema: contracts.WorkflowLifecycleInputSchema, outputSchema: contracts.LifecycleResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'workflow_restore', () => extension.lifecycle.restoreWorkflow(context.principal,input)))
  if (operatorToolAvailable(context, 'agent_archive')) server.registerTool('agent_archive', {
    description: "Archive an unused idle Agent; reject saved-workflow or active-draft references. Immutable history is retained.", inputSchema: contracts.AgentLifecycleInputSchema, outputSchema: contracts.LifecycleResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'agent_archive', () => extension.lifecycle.agent(context.principal,input,true)))
  if (operatorToolAvailable(context, 'agent_restore')) server.registerTool('agent_restore', {
    description: "Restore an archived workspace Agent without launching a native session.", inputSchema: contracts.AgentLifecycleInputSchema, outputSchema: contracts.LifecycleResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'agent_restore', () => extension.lifecycle.agent(context.principal,input,false)))
  if (operatorToolAvailable(context, 'workspace_location_clear')) server.registerTool('workspace_location_clear', {
    description: "Clear the location for future Runs using its expected revision. Existing accepted Run snapshots are unchanged.", inputSchema: contracts.LocationClearInputSchema, outputSchema: contracts.LocationClearResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'workspace_location_clear', () => extension.workspace.clear(context.principal,input)))
  if (operatorToolAvailable(context, 'workspace_location_provision')) server.registerTool('workspace_location_provision', {
    description: "Provision and select one runner-owned workspace directory below the explicitly configured private provisioning root. No arbitrary paths, shell commands, or sandbox expansion.", inputSchema: contracts.LocationProvisionInputSchema, outputSchema: contracts.LocationProvisionResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'workspace_location_provision', () => extension.workspace.provision(context.principal,input)))
  if (operatorToolAvailable(context, 'runner_list')) server.registerTool('runner_list', {
    description: "Discover the available local runner and whether controlled provisioning is configured. Remote dispatch is not supported.", inputSchema: contracts.RunnerListInputSchema, outputSchema: contracts.RunnerListResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'runner_list', () => extension.workspace.runners(context.principal,input.workspaceId)))
  // Skill tools stay listed for every Operator credential: the service checks grants and
  // workspace scope on each call, so a forbidden call returns an audited ACCESS_DENIED
  // instead of an unknown-tool error.
  const skillTools = Boolean(extension.skills)
  if (skillTools) server.registerTool('skill_list', {
    description: "List logical skills, one row per skill with its current version, name, description and archive state. Omit workspaceId to list every workspace you may read. Never returns instruction bodies; use skill_get.", inputSchema: contracts.SkillListInputSchema, outputSchema: contracts.SkillPageSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'skill_list', () => extension.skills.list(context.principal,input)))
  if (skillTools) server.registerTool('skill_get', {
    description: "Read a skill's current head and the instructions of its current version, or of one exact immutable version.", inputSchema: contracts.SkillGetInputSchema, outputSchema: contracts.SkillGetResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'skill_get', () => extension.skills.get(context.principal,input)))
  if (skillTools) server.registerTool('skill_versions_list', {
    description: "List a skill's immutable versions, newest first, without instruction bodies.", inputSchema: contracts.SkillVersionListInputSchema, outputSchema: contracts.SkillVersionPageSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'skill_versions_list', () => extension.skills.versions(context.principal,input)))
  if (skillTools) server.registerTool('skill_create', {
    description: "Create a workspace skill from Markdown instruction text. The server assigns the skill ID and version 1. Text is stored literally: no packages, scripts, URLs or includes. Retry the same commandId after an uncertain reply. Assign it to an Agent by exact version through agent_create/agent_update or the board.", inputSchema: contracts.SkillCreateInputSchema, outputSchema: contracts.SkillMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'skill_create', () => extension.skills.create(context.principal,input,'mcp')))
  if (skillTools) server.registerTool('skill_update', {
    description: "Save a skill's name, description and instructions as a new immutable version. Requires expectedRevision from skill_get/skill_list; a stale revision returns SKILL_REVISION_CONFLICT. An identical save creates no version (changed=false). Existing Agent assignments stay pinned to their versions until explicitly updated; skill_usage_get lists them and skill_users_update moves them and their workflows to the new version.", inputSchema: contracts.SkillUpdateInputSchema, outputSchema: contracts.SkillMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'skill_update', () => extension.skills.update(context.principal,input,'mcp')))
  if (skillTools) server.registerTool('skill_archive', {
    description: "Archive (archived=true) or restore a skill. Requires skills:publish and skills:read in its workspace because the result includes the current version. Archived skills are hidden from default lists and cannot be newly assigned; versions and pinned Agent snapshots are kept.", inputSchema: contracts.SkillArchiveInputSchema, outputSchema: contracts.SkillMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'skill_archive', () => extension.skills.archive(context.principal,input,'mcp')))
  if (skillTools) server.registerTool('skill_usage_get', {
    description: "List all Agents still assigned an older version of this skill and their affected saved workflows, including workflows still pinned before a consumer's Agent update. Unrelated Agents and workflows are excluded. Requires skills:read.", inputSchema: contracts.SkillUsageInputSchema, outputSchema: contracts.SkillUsageSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'skill_usage_get', () => extension.skillUsage.usage(context.principal,input)))
  if (skillTools) server.registerTool('skill_users_update', {
    description: "Move this skill's consumers to its current version through normal Agent and workflow saves. Requires skills:read, agents:update and the saves' scoped graph/workflow permissions. Unrelated workflow pins are preserved; concurrent configuration changes can cause per-item conflicts. Running Agents keep their saved version. The original head and consumer plan are retained before any child save: retry the same commandId to resume failures or replay the completed result. Use a new commandId to include newer skill versions or new consumers.", inputSchema: contracts.SkillUsersUpdateInputSchema, outputSchema: contracts.SkillUsersUpdateResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'skill_users_update', () => extension.skillUsage.updateUsers(context.principal,'mcp',input)))
}
