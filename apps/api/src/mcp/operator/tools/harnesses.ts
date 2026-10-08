import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { HarnessCompatibilityListSchema, HarnessCompatibilitySchema, HarnessCompatibilityRetryParamsSchema } from '@foreman-code/contracts'
import { HarnessQualificationListSchema, HarnessQualificationRunParamsSchema, HarnessQualificationSchema } from '@foreman-code/contracts/harness-qualification'

import {
  ExecutionReadinessInputSchema, ExecutionReadinessSchema,
  HarnessCatalogEntrySchema, HarnessCatalogResultSchema, HarnessDefaultsUpdateInputSchema,
  HarnessDefaultsUpdateResultSchema, HarnessGetInputSchema,
} from '@foreman-code/contracts/management'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'
import { ClaudeSetupOptionsSchema } from '@foreman-code/contracts/claude'

export function registerHarnessTools(server: McpServer, context: OperatorRequestContext): void {
  if (operatorToolAvailable(context, 'claude_setup_options_get')) server.registerTool('claude_setup_options_get', {
    description: 'Read the owning API Foreman Code MCP HTTP endpoint for a pinned Claude configuration. Add it as mcpServers["foreman-code"] (existing graphql entries remain supported) using harness_defaults_update or harness_instance_save. Saving configuration does not qualify execution, grant tools, install packages or change native login files. External MCP servers are rejected because their tool manifests are not supported. Scoped credentials are delivered only at authorized execution admission.',
    inputSchema: z.object({}).strict(), outputSchema: ClaudeSetupOptionsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'claude_setup_options_get', async () => context.services.harnesses.claudeSetupOptions(context.principal)))
  if (operatorToolAvailable(context, 'harness_compatibility_list')) server.registerTool('harness_compatibility_list', {
    description: 'Read dynamic Codex protocol checks, observed versions, cached results and unmet contracts. Claude SDK compatibility is exposed by harness_get and execution_readiness_get. Authentication and host policy are checked separately.',
    inputSchema: z.object({}).strict(), outputSchema: HarnessCompatibilityListSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'harness_compatibility_list', async () =>
    context.services.harnessCompatibility!.read(context.principal)))
  if (operatorToolAvailable(context, 'harness_compatibility_retry')) server.registerTool('harness_compatibility_retry', {
    description: 'Recheck the installed Codex protocol contracts without a model turn or settings change. Requires harness update access.',
    inputSchema: HarnessCompatibilityRetryParamsSchema, outputSchema: HarnessCompatibilitySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'harness_compatibility_retry', () =>
    context.services.harnessCompatibility!.requestRetry(context.principal, 'mcp', input.harness)))
  if (operatorToolAvailable(context, 'harness_qualifications_list')) server.registerTool('harness_qualifications_list', {
    description: 'Read persisted exact-binary harness qualification results.', inputSchema: z.object({}).strict(),
    outputSchema: HarnessQualificationListSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'harness_qualifications_list', () => context.services.harnessQualifications!.list(context.principal)))
  if (operatorToolAvailable(context, 'harness_qualification_run')) server.registerTool('harness_qualification_run', {
    description: 'Start the app qualification suite for the installed harness binary.', inputSchema: HarnessQualificationRunParamsSchema,
    outputSchema: z.object({ qualification: HarnessQualificationSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'harness_qualification_run', () => context.services.harnessQualifications!.run(context.principal, 'mcp', input.harness)))
  if (operatorToolAvailable(context, 'execution_readiness_get')) server.registerTool('execution_readiness_get', {
    description: 'Read native eligibility for workflow harness presets (default scope) or the exact saved Operator configuration (operator-configuration scope). Supply configurationVersionId to inspect a pinned Operator configuration; otherwise inspect its current saved defaults. These scopes have separate host profiles and sandbox policies. No configuration is written or model turn started. Execution still checks workspace, grants, and MCP policy.',
    inputSchema: ExecutionReadinessInputSchema, outputSchema: ExecutionReadinessSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'execution_readiness_get', () => context.services.executionReadiness!.get(context.principal, input.harness, input.scope, input.configurationVersionId)))
  if (operatorToolAvailable(context, 'harness_list')) server.registerTool('harness_list', {
    description: 'List observed local harness versions, dynamic model catalogs, contract compatibility, '
      + 'saved defaults and application interactionSupport limits. Discovery errors identify unmet contracts. '
      + 'Only configured presets are listed; unavailable presets keep their harness identity and include a reason. '
      + 'An absent preset does not change existing saved Agents. Use agent_get to read their saved configuration. '
      + 'Codex supports generic questions, MCP approvals, and schema-validated data-entry forms. '
      + 'When native discovery cannot select a default model, capability is null with HARNESS_MODEL_DEFAULT_UNAVAILABLE; '
      + 'choose an explicit native model before using that preset. Claude access choices that need configuration return CLAUDE_FULL_ACCESS_REQUIRED; choose Full access explicitly.',
    inputSchema: z.object({}).strict(),
    outputSchema: HarnessCatalogResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'harness_list', async () => ({ items: await context.services.harnesses.list(context.principal) })))
  if (operatorToolAvailable(context, 'harness_get')) server.registerTool('harness_get', {
    description: 'Read the selected harness observed version, dynamic capabilities, saved defaults '
      + 'and application interactionSupport limits. Compatible versions are accepted by contract behavior; '
      + 'authentication and host policy still apply. '
      + 'A missing Claude preset returns HARNESS_PROFILE_REQUIRED with setup instructions; '
      + 'existing Agents retain their saved harness. '
      + 'Read supported and unsupported descriptions before requesting native input; '
      + 'Codex supports generic questions and schema-validated data-entry forms. '
      + 'An unavailable native default returns capability null and HARNESS_MODEL_DEFAULT_UNAVAILABLE; template values do not qualify execution. Claude presets with unsupported access return capability null and CLAUDE_FULL_ACCESS_REQUIRED until the user explicitly chooses Full access.',
    inputSchema: HarnessGetInputSchema,
    outputSchema: HarnessCatalogEntrySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'harness_get', () => context.services.harnesses.get(context.principal, input.harness)))
  if (operatorToolAvailable(context, 'harness_defaults_update')) server.registerTool('harness_defaults_update', {
    description: 'Revision-check and replace defaults copied into future board agents. New, edited or explicitly selected Claude presets accept only explicit Full access and the app MCP connection. Unchanged incomplete Claude presets may be retained while another provider is configured, without changing their access or availability. Use configure to explicitly select a preset even if its template values match. Other unavailable presets stay unavailable. Claude presets persist explicit configuration without native qualification; saving grants no execution or tool authority. Codex selections require their model-free native checks.', inputSchema: HarnessDefaultsUpdateInputSchema,
    outputSchema: HarnessDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'harness_defaults_update', () => context.services.harnesses.updateDefaults(context.principal, 'mcp', input)))
}
