import type { McpServer } from '@modelcontextprotocol/server'
import { requireAuthorization } from '../../../modules/access/policy.js'
import * as contracts from '@graphql/contracts/management'
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
    description: "Reread the qualified native model catalog. Use refresh=upstream only for OpenCode to first update its models.dev cache; refresh=catalog only rereads the local provider data. Requires harnesses:read.", inputSchema: contracts.HarnessOptionsRefreshInputSchema, outputSchema: contracts.HarnessOptionsResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
  }, async (input) => invokeOperatorTool(context, 'harness_options_refresh', async () => {
    requireAuthorization(context.principal, 'harnesses:read')
    context.services.harnesses.invalidateChecks()
    return extension.native.refreshOptions(input.harness, input.refresh)
  }))
  if (operatorToolAvailable(context, 'harness_mcp_detection_get')) server.registerTool('harness_mcp_detection_get', {
    description: "Inspect MCP configuration in the validated saved workspace directory; requires location-read permission.", inputSchema: contracts.HarnessMcpDetectionInputSchema, outputSchema: contracts.HarnessMcpDetectionResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'harness_mcp_detection_get', () => extension.workspace.diagnostics(context.principal,input)))
  if (operatorToolAvailable(context, 'agent_create')) server.registerTool('agent_create', {
    description: "Create a standalone workspace Agent from an explicit native configuration or a role template. Existing credentials do not gain new grants automatically.", inputSchema: contracts.AgentCreateInputSchema, outputSchema: contracts.AgentMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'agent_create', () => extension.agents.create(context.principal,input)))
  if (operatorToolAvailable(context, 'agent_update')) server.registerTool('agent_update', {
    description: "Revision-check Agent metadata/configuration. Requires authority across every referencing workflow and rejects busy Agents. Publish a new workflow version before running changed settings.", inputSchema: contracts.AgentUpdateInputSchema, outputSchema: contracts.AgentMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'agent_update', () => extension.agents.update(context.principal,input)))
  if (operatorToolAvailable(context, 'agent_clone')) server.registerTool('agent_clone', {
    description: "Clone an authorized workspace Agent, including one outside the current board. Does not copy live execution state.", inputSchema: contracts.AgentCloneInputSchema, outputSchema: contracts.AgentMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'agent_clone', () => extension.agents.clone(context.principal,input)))
  if (operatorToolAvailable(context, 'workflow_versions_list')) server.registerTool('workflow_versions_list', {
    description: "List immutable workflow versions in increasing numeric version order.", inputSchema: contracts.WorkflowVersionListInputSchema, outputSchema: contracts.WorkflowVersionPageSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'workflow_versions_list', () => extension.history.workflows(context.principal,input)))
  if (operatorToolAvailable(context, 'workflow_version_get')) server.registerTool('workflow_version_get', {
    description: "Inspect one immutable workflow version. Restore it through graph_draft_apply workflow.restore_version, then validate and publish a new current version.", inputSchema: contracts.WorkflowVersionGetInputSchema, outputSchema: contracts.WorkflowVersionResultSchema,
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
  if (operatorToolAvailable(context, 'workflow_trigger_get')) server.registerTool('workflow_trigger_get', {
    description: "Read the saved trigger revision, version/location pins, enabled state, next scheduled time, and last error.", inputSchema: contracts.WorkflowTriggerGetInputSchema, outputSchema: contracts.WorkflowTriggerGetResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'workflow_trigger_get', () => extension.triggers.get(context.principal,input)))
  if (operatorToolAvailable(context, 'workflow_trigger_update')) server.registerTool('workflow_trigger_update', {
    description: "Configure a saved manual/message/event/interval-schedule trigger. Enabling requires Runs/start and location-read authority. Every launch revalidates the principal and all delegated owners.", inputSchema: contracts.WorkflowTriggerUpdateInputSchema, outputSchema: contracts.WorkflowTriggerUpdateResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'workflow_trigger_update', () => extension.triggers.update(context.principal,input)))
  if (operatorToolAvailable(context, 'workflow_trigger_disable')) server.registerTool('workflow_trigger_disable', {
    description: "Disable a trigger and block unstarted jobs even if the parent is archived or its saved version changed.", inputSchema: contracts.WorkflowTriggerDisableInputSchema, outputSchema: contracts.WorkflowTriggerUpdateResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'workflow_trigger_disable', () => extension.triggers.disable(context.principal,input)))
  if (operatorToolAvailable(context, 'workflow_trigger_fire')) server.registerTool('workflow_trigger_fire', {
    description: "Enqueue an explicitly supplied matching event or message through a durable idempotent outbox. This is not an external webhook subscription.", inputSchema: contracts.WorkflowTriggerFireInputSchema, outputSchema: contracts.WorkflowTriggerFireResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'workflow_trigger_fire', () => extension.triggers.fire(context.principal,input)))
  if (operatorToolAvailable(context, 'workflow_trigger_jobs_list')) server.registerTool('workflow_trigger_jobs_list', {
    description: "Inspect queued, leased, started, and blocked trigger jobs. Queued is not confirmation that a Run started.", inputSchema: contracts.TriggerJobListInputSchema, outputSchema: contracts.TriggerJobPageSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'workflow_trigger_jobs_list', () => extension.triggers.jobs(context.principal,input)))
  if (operatorToolAvailable(context, 'run_resume')) server.registerTool('run_resume', {
    description: "Reconcile a healthy, already-approved checkpoint through the existing engine. Does not approve requests or replay interrupted native side effects.", inputSchema: contracts.RunResumeInputSchema, outputSchema: contracts.RunResumeResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'run_resume', () => extension.runs.resume(context.principal,input)))
  if (operatorToolAvailable(context, 'run_retry')) server.registerTool('run_retry', {
    description: "Explicitly start a new full Run from the input of a failed/canceled terminal Run, using a caller-selected current workflow version. Not a selected-node retry.", inputSchema: contracts.RunRetryInputSchema, outputSchema: contracts.RunStartResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async (input) => invokeOperatorTool(context, 'run_retry', () => extension.runs.retry(context.principal,input)))
}
