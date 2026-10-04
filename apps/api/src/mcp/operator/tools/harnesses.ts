import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
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
    description: 'Read the owning API Foreman Code MCP HTTP endpoint for a pinned Claude configuration. Add it as mcpServers["foreman-code"] (existing graphql entries remain supported) using harness_defaults_update or harness_instance_save. Saving configuration does not qualify execution, grant tools, install packages or change native login files. Scoped credentials are delivered only at authorized execution admission.',
    inputSchema: z.object({}).strict(), outputSchema: ClaudeSetupOptionsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'claude_setup_options_get', async () => context.services.harnesses.claudeSetupOptions(context.principal)))
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
    description: 'List qualified local harness capabilities and saved defaults.', inputSchema: z.object({}).strict(),
    outputSchema: HarnessCatalogResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'harness_list', async () => ({ items: await context.services.harnesses.list(context.principal) })))
  if (operatorToolAvailable(context, 'harness_get')) server.registerTool('harness_get', {
    description: 'Read one qualified harness capability and its saved defaults.', inputSchema: HarnessGetInputSchema,
    outputSchema: HarnessCatalogEntrySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'harness_get', () => context.services.harnesses.get(context.principal, input.harness)))
  if (operatorToolAvailable(context, 'harness_defaults_update')) server.registerTool('harness_defaults_update', {
    description: 'Revision-check and replace defaults copied into future board agents. Claude presets persist explicit configuration without native qualification; saving grants no execution or tool authority. Codex/OpenCode changes still require their model-free native checks.', inputSchema: HarnessDefaultsUpdateInputSchema,
    outputSchema: HarnessDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'harness_defaults_update', () => context.services.harnesses.updateDefaults(context.principal, 'mcp', input)))
}
