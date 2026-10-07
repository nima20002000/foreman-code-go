import { z } from 'zod'
import { ComputerActivityListSchema } from '@foreman-code/contracts/computer-activity'
import { ComputerAccountsListSchema } from '@foreman-code/contracts/computer-accounts'
import type { McpServer } from '@modelcontextprotocol/server'
import { BuildComputerReadSchema, BuildComputerUpdateSchema, BuildComputerStatusSchema } from '@foreman-code/contracts/build-computers'
import type { OperatorRequestContext } from '../types.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'

export function registerBuildComputerTools(server: McpServer, context: OperatorRequestContext): void {
  if (context.services.computerActivity && operatorToolAvailable(context, 'computer_activity_list')) {
    server.registerTool('computer_activity_list', {
      description: 'Read current computer presence, running CI Jobs and placed workflow agent executions. '
        + 'Requires global settings:read. Job and agent names are filtered by jobs:read and runs:read scopes. '
        + 'Read-only, at most 101 computers and 200 entries per activity kind; truncated and activityComplete '
        + 'describe coverage. No telemetry permissions are implied; use resource_telemetry tools for utilization.',
      inputSchema: z.object({}).strict(), outputSchema: ComputerActivityListSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    }, () => invokeOperatorTool(context, 'computer_activity_list',
      () => context.services.computerActivity!.list(context.principal, 'mcp')))
  }
  if (context.services.computerAccounts && operatorToolAvailable(context, 'computer_accounts_list')) {
    server.registerTool('computer_accounts_list', {
      description: 'Read which harness (Codex, Claude, OpenCode), GitHub CLI and Google Drive (rclone) accounts each paired computer '
        + 'has installed and is signed in to. Requires global settings:read. Identity strings only (email, username, provider names); '
        + 'no tokens. Results are cached for 30 seconds unless refresh is true; an offline computer reports null accounts.',
      inputSchema: z.object({ refresh: z.boolean().optional() }).strict(), outputSchema: ComputerAccountsListSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    }, input => invokeOperatorTool(context, 'computer_accounts_list',
      () => context.services.computerAccounts!.list(context.principal, 'mcp', input.refresh === true)))
  }
  const service = context.services.buildComputers
  if (!service) return
  const annotations = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
  if (operatorToolAvailable(context, 'build_computer_get')) server.registerTool('build_computer_get', {
    description: 'Read persisted build participation, priority, role, build allowance, revision and derived readiness for this Main/computer installation. Requires global settings:read. Pairing, workspace/root approval, qualified runtime and the Main startup execution gate remain separate.',
    inputSchema: BuildComputerReadSchema, outputSchema: BuildComputerStatusSchema, annotations,
  }, input => invokeOperatorTool(context, 'build_computer_get', () => service.read(context.principal, input, 'mcp')))
  if (operatorToolAvailable(context, 'build_computer_update')) server.registerTool('build_computer_update', {
    description: 'Revision-check build participation, priority (0–100, higher preferred), role (primary computers are tried before any backup) and build allowance (10–100 percent of the computer CPU and memory that builds may use; omitted role/allowance keep their saved values). Requires global settings:update. Edits affect future launches; running Jobs retain cancellation/recovery and artifacts. Reuse commandId for an uncertain save. Does not install, pair, approve a runtime or enable the Main startup execution gate.',
    inputSchema: BuildComputerUpdateSchema, outputSchema: BuildComputerStatusSchema,
    annotations: { ...annotations, readOnlyHint: false },
  }, input => invokeOperatorTool(context, 'build_computer_update', () => service.update(context.principal, 'mcp', input)))
}
