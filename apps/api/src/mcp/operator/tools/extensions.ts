import type { McpServer } from '@modelcontextprotocol/server'
import { requireAuthorization } from '../../../modules/access/policy.js'
import * as contracts from '@graphql/contracts/management'
import { SavedWorkflowVersionPageSchema, SavedWorkflowVersionDetailSchema } from '@graphql/contracts/wave25'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorRequestContext } from '../types.js'

export function registerExtendedOperatorTools(server: McpServer, context: OperatorRequestContext): void {
  const extension = context.services.extensions
  if (!extension) return
  if (operatorToolAvailable(context, 'harness_configuration_check')) server.registerTool('harness_configuration_check', {
    description: "Check a proposed native configuration without creating a session or model turn.", inputSchema: contracts.NativeConfigurationCheckInputSchema, outputSchema: contracts.NativeConfigurationCheckResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'harness_configuration_check', () => context.services.harnesses.checkConfiguration(context.principal, input.configuration)))
  if (operatorToolAvailable(context, 'harness_options_get')) server.registerTool('harness_options_get', {
    description: "Discover native model IDs, efforts/variants, native Agents, authentication evidence, and field support. No secrets or native configuration are returned.", inputSchema: contracts.HarnessOptionsInputSchema, outputSchema: contracts.HarnessOptionsResultSchema,
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
  if (operatorToolAvailable(context, 'opencode_models_cache_update')) server.registerTool('opencode_models_cache_update', {
    description: "Update the API host's shared OpenCode models.dev cache through the qualified native CLI, then reread connected provider models. Requires harnesses:read and harnesses:update.", inputSchema: contracts.OpenCodeModelsRefreshInputSchema, outputSchema: contracts.HarnessOptionsResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
  }, async () => invokeOperatorTool(context, 'opencode_models_cache_update', async () => {
    requireAuthorization(context.principal, 'harnesses:read')
    requireAuthorization(context.principal, 'harnesses:update')
    context.services.harnesses.invalidateChecks()
    return extension.native.refreshOptions('opencode', 'upstream')
  }))
  if (operatorToolAvailable(context, 'harness_mcp_detection_get')) server.registerTool('harness_mcp_detection_get', {
    description: "Inspect MCP configuration in the validated saved workspace directory; requires location-read permission.", inputSchema: contracts.HarnessMcpDetectionInputSchema, outputSchema: contracts.HarnessMcpDetectionResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'harness_mcp_detection_get', () => extension.workspace.diagnostics(context.principal,input)))
  if (operatorToolAvailable(context, 'agent_create')) server.registerTool('agent_create', {
    description: "Create a standalone workspace Agent from an explicit native configuration or a role template. Existing credentials do not gain new grants automatically. graphqlTools sets its default GraphQL MCP tools (absent = every tool its role allows); a workflow node can add/remove tools via its graphqlTools field.", inputSchema: contracts.AgentCreateInputSchema, outputSchema: contracts.AgentMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'agent_create', () => extension.agents.create(context.principal,input)))
  if (operatorToolAvailable(context, 'agent_update')) server.registerTool('agent_update', {
    description: "Revision-check Agent metadata/configuration. graphqlTools replaces its default GraphQL MCP tools, within its role. Requires authority across every referencing workflow and rejects busy Agents. Publish a new workflow version before running changed settings.", inputSchema: contracts.AgentUpdateInputSchema, outputSchema: contracts.AgentMutationResultSchema,
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
  if (operatorToolAvailable(context, 'skill_list')) server.registerTool('skill_list', {
    description: "List workspace skill versions and hashes without downloading every instruction body.", inputSchema: contracts.SkillListInputSchema, outputSchema: contracts.SkillPageSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'skill_list', () => extension.skills.list(context.principal,input)))
  if (operatorToolAvailable(context, 'skill_get')) server.registerTool('skill_get', {
    description: "Read one immutable skill version and its instructions.", inputSchema: contracts.SkillReferenceInputSchema, outputSchema: contracts.SkillGetResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'skill_get', () => extension.skills.get(context.principal,input)))
  if (operatorToolAvailable(context, 'skill_publish')) server.registerTool('skill_publish', {
    description: "Publish a new immutable workspace skill version from supplied text. This does not install packages or rewrite existing versions.", inputSchema: contracts.SkillPublishInputSchema, outputSchema: contracts.SkillPublishResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'skill_publish', () => extension.skills.publish(context.principal,input)))
}
