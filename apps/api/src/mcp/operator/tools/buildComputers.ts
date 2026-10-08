import { z } from 'zod'
import { ComputerActivityListSchema } from '@foreman-code/contracts/computer-activity'
import { ComputerAccountsListSchema, ComputerDriveCompleteInputSchema, ComputerDriveInputSchema, ComputerDriveStatusInputSchema, ComputerGitHubInputSchema, ComputerGitHubStatusInputSchema,
  DriveLoginStateSchema, GitHubLoginStateSchema } from '@foreman-code/contracts/computer-accounts'
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
  const github = context.services.computerGitHub
  const writeAnnotations = { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true }
  if (github && operatorToolAvailable(context, 'computer_github_login_start')) server.registerTool('computer_github_login_start', {
    description: 'Start GitHub CLI sign-in (github.com) on Main or a paired computer. Returns a one-time device code and '
      + 'https://github.com/login/device; the owner enters the code in a browser. Requires global settings:update. The token stays '
      + 'on that computer and git is set to use it. Follow with computer_github_login_status until signed-in.',
    inputSchema: ComputerGitHubInputSchema, outputSchema: GitHubLoginStateSchema, annotations: writeAnnotations,
  }, input => invokeOperatorTool(context, 'computer_github_login_start',
    () => github.handle(context.principal, 'mcp', input.target, { operation: 'login-start' })))
  if (github && operatorToolAvailable(context, 'computer_github_login_status')) server.registerTool('computer_github_login_status', {
    description: 'Read an active GitHub sign-in on that computer: waiting (with its code), signed-in (with the username), failed, cancelled or expired. '
      + 'Requires global settings:update.',
    inputSchema: ComputerGitHubStatusInputSchema, outputSchema: GitHubLoginStateSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, input => invokeOperatorTool(context, 'computer_github_login_status',
    () => github.handle(context.principal, 'mcp', input.target, { operation: 'login-status', loginId: input.loginId })))
  if (github && operatorToolAvailable(context, 'computer_github_logout')) server.registerTool('computer_github_logout', {
    description: 'Sign the GitHub CLI out of github.com on that computer. Requires global settings:update.',
    inputSchema: ComputerGitHubInputSchema, outputSchema: GitHubLoginStateSchema,
    annotations: { ...writeAnnotations, destructiveHint: true },
  }, input => invokeOperatorTool(context, 'computer_github_logout',
    () => github.handle(context.principal, 'mcp', input.target, { operation: 'logout' })))
  const drive = context.services.computerDrive
  if (drive && operatorToolAvailable(context, 'computer_drive_connect_start')) server.registerTool('computer_drive_connect_start', {
    description: 'Prepare Google Drive on Main or a paired computer, installing checksum-verified rclone if needed. '
      + 'Returns authorizationCommand to run on a computer with rclone and a browser (which may be away from Main). '
      + 'Ask the owner to complete Google sign-in and provide the printed result to computer_drive_connect_complete. '
      + 'Each computer has its own sign-in session. Uses drive.file scope and mounts only the Foreman Code folder. '
      + 'Requires global settings:update. Main does not persist the authorization token.',
    inputSchema: ComputerDriveInputSchema, outputSchema: DriveLoginStateSchema, annotations: writeAnnotations,
  }, input => invokeOperatorTool(context, 'computer_drive_connect_start',
    () => drive.connectStart(context.principal, 'mcp', input.target)))
  if (drive && operatorToolAvailable(context, 'computer_drive_connect_complete')) server.registerTool('computer_drive_connect_complete', {
    description: 'Complete a Drive sign-in with the JSON or base64url result printed by authorizationCommand. '
      + 'Rechecks caller access and the full computer registration before forwarding credentials. '
      + 'Returns the mounted account, or a mount error. Requires global settings:update.',
    inputSchema: ComputerDriveCompleteInputSchema, outputSchema: DriveLoginStateSchema, annotations: writeAnnotations,
  }, input => invokeOperatorTool(context, 'computer_drive_connect_complete',
    () => drive.connectComplete(context.principal, 'mcp', input.target, input.loginId, input.token)))
  if (drive && operatorToolAvailable(context, 'computer_drive_connect_status')) server.registerTool('computer_drive_connect_status', {
    description: 'Read an active Google Drive connection: waiting (with its remote authorization command), connecting, connected (with the Google account '
      + 'and mount path), failed, cancelled or expired. Requires global settings:update.',
    inputSchema: ComputerDriveStatusInputSchema, outputSchema: DriveLoginStateSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, input => invokeOperatorTool(context, 'computer_drive_connect_status',
    () => drive.connectStatus(context.principal, 'mcp', input.target, input.loginId)))
  if (drive && operatorToolAvailable(context, 'computer_drive_connect_cancel')) server.registerTool('computer_drive_connect_cancel', {
    description: 'Cancel a pending Drive sign-in on its selected computer without disconnecting an existing account. '
      + 'Invalidates its operation before credential installation and mounting. Requires global settings:update.',
    inputSchema: ComputerDriveStatusInputSchema, outputSchema: DriveLoginStateSchema, annotations: writeAnnotations,
  }, input => invokeOperatorTool(context, 'computer_drive_connect_cancel',
    () => drive.cancel(context.principal, 'mcp', input.target, input.loginId)))
  if (drive && operatorToolAvailable(context, 'computer_drive_disconnect')) server.registerTool('computer_drive_disconnect', {
    description: 'Unmount Google Drive on that computer and remove the app\'s rclone remote. Files stay in Google Drive. Requires global settings:update.',
    inputSchema: ComputerDriveInputSchema, outputSchema: DriveLoginStateSchema,
    annotations: { ...writeAnnotations, destructiveHint: true },
  }, input => invokeOperatorTool(context, 'computer_drive_disconnect',
    () => drive.disconnect(context.principal, 'mcp', input.target)))
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
