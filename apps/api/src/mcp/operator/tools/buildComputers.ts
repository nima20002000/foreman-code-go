import { z } from 'zod'
import { ComputerActivityListSchema } from '@foreman-code/contracts/computer-activity'
import { ComputerMaintenanceOperatorListSchema, ComputerMaintenanceOperatorListInputSchema, ComputerMaintenanceStartInputSchema,
  ComputerMaintenanceStartResultSchema } from '@foreman-code/contracts/computer-maintenance'
import { ComputerAccountsListInputSchema, ComputerAccountsListSchema, ComputerSyncReadInputSchema,
  ComputerSyncUpdateInputSchema, ComputerSyncStatusSchema, ComputerGitHubInputSchema,
  ComputerGitHubLogoutInputSchema, ComputerGitHubStatusInputSchema,
  GitHubLoginStateSchema } from '@foreman-code/contracts/computer-accounts'
import type { McpServer } from '@modelcontextprotocol/server'
import { BuildComputerReadSchema, BuildComputerUpdateSchema, BuildComputerStatusSchema,
  BuildComputerBatchUpdateSchema, BuildComputerBatchResultSchema } from '@foreman-code/contracts/build-computers'
import type { OperatorRequestContext } from '../types.js'
import { maintenanceReadResult } from '../../../modules/computers/maintenanceSummary.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'

export function registerBuildComputerTools(server: McpServer, context: OperatorRequestContext): void {
  if (context.services.computerActivity && operatorToolAvailable(context, 'computer_activity_list')) {
    server.registerTool('computer_activity_list', {
      description: 'Read current computer presence, running CI Jobs and placed workflow agent executions, and the cloud '
        + 'CI services Main is logged in to with how many of their machines run CI now. '
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
      description: 'Read which harness (Codex, Claude), GitHub CLI accounts each paired computer '
        + 'has installed and is signed in to. Requires global settings:read. Identity strings only (email, username, provider names); '
        + 'no tokens. Results are cached for 30 seconds unless refresh is true; an offline computer reports null accounts. '
        + 'Supply target to read one current installation independently; target cannot be combined with cursor. '
        + 'Each fleet page includes up to 100 paired computers; Main appears only on the first page. Continue with nextCursor as cursor until null.',
      inputSchema: ComputerAccountsListInputSchema, outputSchema: ComputerAccountsListSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    }, input => invokeOperatorTool(context, 'computer_accounts_list',
      () => input.target
        ? context.services.computerAccounts!.readTarget(context.principal, 'mcp', input)
        : context.services.computerAccounts!.list(context.principal, 'mcp', input.refresh === true, input.cursor)))
  }
  const maintenance = context.services.computerMaintenance
  if (maintenance && operatorToolAvailable(context, 'computers_maintenance_status')) server.registerTool('computers_maintenance_status', {
    description: 'Read maintenance status for Main and every paired computer: installed and latest Codex/Claude versions, pending OS '
      + 'package updates (including phased or held packages), whether a restart is needed, passwordless sudo and free disk. '
      + 'Returns the newest 5 tasks per computer by default, newest first. Optional taskLimit is an integer from 1 to 50. '
      + 'Running and queued tasks are always included even beyond the limit; tasksOmitted counts excluded retained tasks per computer. '
      + 'Default detail is compact, with summaries capped at 300 characters and no outputTail. '
      + 'Use detail: "full" for outputTail with the same history limit; optionally supply taskId with full detail '
      + 'to select one retained task independently of the limit. '
      + 'Paired Workers also report current and target application versions, update state and the last update error, '
      + 'including rollback. '
      + 'Requires global settings:read. Supply target to read one current installation independently. '
      + 'Settled status is cached for 20 seconds unless refresh is true; pending probes are shared. An offline computer reports null status.',
    inputSchema: ComputerMaintenanceOperatorListInputSchema, outputSchema: ComputerMaintenanceOperatorListSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, input => invokeOperatorTool(context, 'computers_maintenance_status', async () => {
    const result = input.target
      ? await maintenance.readTarget(context.principal, 'mcp', {
        target: input.target, refresh: input.refresh,
      })
      : await maintenance.list(context.principal, 'mcp', input.refresh === true)
    return maintenanceReadResult(result, input)
  }))
  if (maintenance && operatorToolAvailable(context, 'computers_maintenance_start')) server.registerTool('computers_maintenance_start', {
    description: 'Start one maintenance task on the given computers. With targets omitted, update-worker and sync tasks select '
      + 'paired computers; other tasks select Main and every paired computer: '
      + 'update-harnesses (install or update Codex/Claude to the latest version), update-system (sudo apt-get update and a '
      + 'non-interactive upgrade with new dependencies, respecting phased rollout and explicit holds; re-reads pending updates), '
      + 'update-worker (drain active work, verify and install the matching Main version, then restart through the Worker supervisor; '
      + 'failed releases roll back and report the error; Main uses production:install), restart (sudo reboot; targets are required), '
      + 'sync-mcp (add Main\'s user-level Codex and Claude MCP '
      + 'servers that other computers lack; secret values are not copied, those servers need a login on each computer), or '
      + 'sync-plugins (install Main\'s Codex and Claude plugins that other computers lack, adding Main\'s Git marketplaces first and matching enabled state for fleet-managed Claude plugins). '
      + 'Sync preserves pre-existing computer-owned entries and removes only fleet-managed entries absent from an available Main catalog. '
      + 'Unsafe or unsupported MCP definitions and unreadable catalogs are skipped and reported; existing Worker entries for skipped definitions are preserved. '
      + 'Intentional credential skips do not fail a task. Automatic sync failures retry after 5 minutes with exponential '
      + 'backoff capped at one hour; a manual start with a new commandId retries immediately. '
      + 'Disabled servers, native tool allow/deny lists and stdio environment-name references cannot be copied by this sync path. '
      + 'Tasks run in the background; read their outcome with computers_maintenance_status. Equivalent requests share only the latest queued task; different requests of the same kind queue. '
      + 'Task status survives application restarts; unfinished tasks report interruption. Check every returned computer error; '
      + 'Main shutdown refuses new maintenance tasks and drains accepted Main work before releasing runtime ownership. '
      + 'unavailable targets are not updated. Harness updates verify the selected runtime meets the published version observed at start; '
      + 'a newer stable release installed during the update also succeeds. '
      + 'Main and Workers select the installed Codex update and retain qualification checks. Requires global '
      + 'settings:update. Reuse commandId with the original input to recover the saved targets, source catalogs and receiver tasks, including after Main stops before recording its result. '
      + 'Use a new commandId with update-worker to trigger an update check or retry a failed update. '
      + 'Older Workers without worker-update-v1 require an initial updater-enabled Worker installation on that computer. '
      + 'Receivers require maintenance protocol 2. Restart stays running until the reboot command returns; success reports command acceptance, not confirmed reconnection. '
      + 'A missing harness leaves nonempty MCP sync pending for a later retry.',
    inputSchema: ComputerMaintenanceStartInputSchema, outputSchema: ComputerMaintenanceStartResultSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: true },
  }, input => invokeOperatorTool(context, 'computers_maintenance_start', () => maintenance.start(context.principal, 'mcp', input)))
  const github = context.services.computerGitHub
  const writeAnnotations = { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true }
  if (github && operatorToolAvailable(context, 'computer_github_login_start')) server.registerTool('computer_github_login_start', {
    description: 'Start GitHub CLI sign-in (github.com) on Main or a paired computer. Returns a one-time device code and '
      + 'https://github.com/login/device; the owner enters the code in a browser. Requires global settings:update. The token stays '
      + 'on that computer. A pending sign-out finishes before this sign-in starts; a later sign-out cancels a pending start. '
      + 'Follow with computer_github_login_status; git-setup-failed means sign-in succeeded but Git setup needs retry.',
    inputSchema: ComputerGitHubInputSchema, outputSchema: GitHubLoginStateSchema, annotations: writeAnnotations,
  }, input => invokeOperatorTool(context, 'computer_github_login_start',
    () => github.handle(context.principal, 'mcp', input.target, { operation: 'login-start' })))
  if (github && operatorToolAvailable(context, 'computer_github_login_status')) server.registerTool('computer_github_login_status', {
    description: 'Read an active GitHub sign-in on that computer: waiting (with its code), signed-in (with the username), '
      + 'git-setup-failed, failed or expired. Requires global settings:update.',
    inputSchema: ComputerGitHubStatusInputSchema, outputSchema: GitHubLoginStateSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, input => invokeOperatorTool(context, 'computer_github_login_status',
    () => github.handle(context.principal, 'mcp', input.target, { operation: 'login-status', loginId: input.loginId })))
  if (github && operatorToolAvailable(context, 'computer_github_setup_git')) server.registerTool('computer_github_setup_git', {
    description: 'Retry Git credential setup after GitHub sign-in without restarting login. Requires global settings:update. '
      + 'Use the loginId from computer_github_login_status when its state is git-setup-failed.',
    inputSchema: ComputerGitHubStatusInputSchema, outputSchema: GitHubLoginStateSchema, annotations: writeAnnotations,
  }, input => invokeOperatorTool(context, 'computer_github_setup_git',
    () => github.handle(context.principal, 'mcp', input.target, { operation: 'setup-git', loginId: input.loginId })))
  if (github && operatorToolAvailable(context, 'computer_github_logout')) server.registerTool('computer_github_logout', {
    description: 'Remove the expected active GitHub account on that computer and verify the resulting status. '
      + 'Read computer_accounts_list first and supply expectedAccount (null only if signed out). '
      + 'Reuse the original expectedAccount on uncertain retries; a changed active account causes a conflict without removal. '
      + 'If another saved account becomes active, returns signed-in; unknown status or failed removal returns an error. '
      + 'Requires global settings:update.',
    inputSchema: ComputerGitHubLogoutInputSchema, outputSchema: GitHubLoginStateSchema,
    annotations: { ...writeAnnotations, destructiveHint: true },
  }, input => invokeOperatorTool(context, 'computer_github_logout',
    () => github.handle(context.principal, 'mcp', input.target, { operation: 'logout', expectedAccount: input.expectedAccount })))
  const sync = context.services.computerSync
  if (sync && operatorToolAvailable(context, 'computer_sync_status')) server.registerTool('computer_sync_status', {
    description: 'Read Syncthing shared file status on Main or a paired computer: installed, running, connected peers, '
      + 'workspace participation, enabled preferences and revisions, local folder paths, idle/syncing/error and conflicts. '
      + 'Requires global settings:read. Paths do not grant harness write access.',
    inputSchema: ComputerSyncReadInputSchema, outputSchema: ComputerSyncStatusSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, input => invokeOperatorTool(context, 'computer_sync_status', () => sync.read(context.principal, 'mcp', input)))
  if (sync && operatorToolAvailable(context, 'computer_sync_update')) server.registerTool('computer_sync_update', {
    description: 'Enable or disable one workspace shared folder on one computer. Requires global settings:update. '
      + 'Use expectedRevision from computer_sync_status and reuse commandId for uncertain saves. '
      + 'Syncthing installs automatically, pairs through the app and uses Tailscale with Main as hub and simple versioning. '
      + 'Only computers selected for workspace Agents receive the folder; enabled preferences apply when they participate. '
      + 'Unavailable enabled peers defer folder replacement; saved preferences retry when they reconnect. '
      + 'Disabling preserves local files. Main off stops sharing through the hub. Read persisted preferences with computer_sync_status.',
    inputSchema: ComputerSyncUpdateInputSchema, outputSchema: ComputerSyncStatusSchema,
    annotations: { ...writeAnnotations, idempotentHint: true },
  }, input => invokeOperatorTool(context, 'computer_sync_update', () => sync.update(context.principal, 'mcp', input)))
  const service = context.services.buildComputers
  if (!service) return
  const annotations = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
  if (operatorToolAvailable(context, 'build_computer_get')) server.registerTool('build_computer_get', {
    description: 'Read persisted build participation, priority, build allowance, revision and derived readiness for this Main/computer installation. New paired computers default to enabled builds, priority 50 and allowance 100. Re-pairing refreshes the target identity and advances the revision while preserving saved choices, including disabled builds. Readiness uses Job admission capacity, saved build allowance and fresh remote available memory; reasons distinguish reserved capacity, unavailable memory, insufficient memory and an allowance too small for the runtime. Requires global settings:read. Pairing approves product-managed root setup; runtime qualification and the Main startup execution gate remain separate.',
    inputSchema: BuildComputerReadSchema, outputSchema: BuildComputerStatusSchema, annotations,
  }, input => invokeOperatorTool(context, 'build_computer_get', () => service.read(context.principal, input, 'mcp')))
  if (operatorToolAvailable(context, 'build_computer_update')) server.registerTool('build_computer_update', {
    description: 'Revision-check build participation, priority (0–100; after a preferred computer, builds try computers from the highest priority down) and build allowance (10–100 percent of the computer CPU and memory that builds may use; an omitted allowance keeps its saved value). Requires global settings:update. Edits affect future launches; running Jobs retain cancellation/recovery and artifacts. Reuse commandId for an uncertain save. Does not install, pair, approve a runtime or enable the Main startup execution gate.',
    inputSchema: BuildComputerUpdateSchema, outputSchema: BuildComputerStatusSchema,
    annotations: { ...annotations, readOnlyHint: false },
  }, input => invokeOperatorTool(context, 'build_computer_update', () => service.update(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'build_computers_update')) server.registerTool('build_computers_update', {
    description: 'Atomically update build participation, priority and allowance for one or more computers on Main. '
      + 'Checks every expectedRevision before changing any computer. Requires global settings:update. '
      + 'Reuse the same commandId and updates to resolve an uncertain save; replay returns the original result. '
      + 'Read build_computer_get afterwards for current settings. Changes affect future placement; running Jobs keep their computer.',
    inputSchema: BuildComputerBatchUpdateSchema, outputSchema: BuildComputerBatchResultSchema,
    annotations: { ...annotations, readOnlyHint: false },
  }, input => invokeOperatorTool(context, 'build_computers_update', () => service.updateBatch(context.principal, 'mcp', input)))
}
