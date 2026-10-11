import type { McpServer } from '@modelcontextprotocol/server'
import { CiRunInputSchema, OperatorCiRunInputSchema, CiRunOutputSchema,
  CiGetInputSchema, OperatorCiGetInputSchema, CiGetOutputSchema,
  CiCancelInputSchema, OperatorCiCancelInputSchema, CiCancelOutputSchema,
  CiLogsInputSchema, OperatorCiLogsInputSchema, CiLogsOutputSchema, CiComputersOutputSchema } from '@foreman-code/contracts'
import { z } from 'zod'
import type { ManagementPrincipal, ManagementAction } from '@foreman-code/contracts/management'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../../modules/jobs/ciAuthority.js'
import type { HostCiService } from '../../modules/ci-host/service.js'
import type { PostgresCommandCoordinator } from '../../modules/commands/postgres.js'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../modules/access/policy.js'
import { DomainError } from '../../modules/errors.js'
import { toolFailure, toolResult } from './results.js'
import { logOperatorToolFailure } from '../operator/invoke.js'

export const CI_CAPABILITY_DETAIL = 'ci_run runs one suite (install, typecheck, lint, unit, build, integration) of the workspace '
  + 'GitHub repository at a commit: the requested one, the Agent’s current files (published to GitHub first) or the default '
  + 'branch head. A build computer fetches it with its own GitHub CLI login, installs packages and runs the repository’s '
  + 'own script in a fresh worktree, like a self-hosted runner. scope defaults to affected; scope=full always runs everything. '
  + 'Main and paired computers participate only with builds enabled; buildPriority orders their selection. '
  + 'When files are omitted, the runner compares the resolved commit with its merge-base against the workspace default branch '
  + 'and uses the repository selector for the suite and part. Missing selectors, shared infrastructure changes and the '
  + 'default branch head run the full suite, with the reason in the run message or log. Caller files remain supported; '
  + 'ci-remote continues to compute and send its selection. '
  + 'ci_get reads back the persisted scope and files. Empty affected selections pass without launching a runner. '
  + 'Requires the same CI run grants for either scope. partitions (2–32, integration only) splits integration '
  + 'into duration-balanced runs on separate computers when scripts/ci-suite.sh and scripts/ci-files.mjs support them. '
  + 'Repositories providing the scripts/ci-suite.sh part contract automatically queue unit-api and unit-web shards '
  + '(defaults 5 and 3, sized from measured durations when available), unit-web-heavy and unit-other. '
  + 'Lint, typecheck and build each queue their -api and -other parts. Each part has its own ticket and shares a groupId; '
  + 'Other repositories run each suite as one job: corepack pnpm, npm or corepack yarn by lockfile (npm without a lockfile), '
  + 'install for install and run <suite> for the others, failing clearly when that script is missing. '
  + 'Cloud CI requires the mirror’s provider workflow (.github/workflows/ci.yml or .circleci/config.yml); '
  + 'without it build computers take the work. '
  + 'Caller selections omit empty parts and shard only selected tests; runner selections keep queued parts and pass empty shards. '
  + 'Poll every ticket in partitions. Retrying commandId returns the '
  + 'original tickets. ci_get returns state (queued, starting, running, passed, failed, canceled, lost), current step, '
  + 'computer, part, shard, exit code, group state and a 32 KiB log tail; ci_logs_read pages the full log '
  + 'for authorized callers. Agent CI readback and cancellation are limited to tickets from that execution. '
  + 'Agent requests publish their persisted lifecycle into their Run’s activities and Board activity snapshot. '
  + '(group=true includes bounded pages and individual cursors for every part); ci_cancel stops one ticket. '
  + 'Agents are restricted to their active Run workspace. Computers without a GitHub login report it in ci_computers_list.'

export const CI_TOOLS = ['ci_run', 'ci_get', 'ci_computers_list', 'ci_cancel', 'ci_logs_read'] as const
type CiTool = typeof CI_TOOLS[number]
interface CiContext {
  principal: ManagementPrincipal
  services: { ci?: HostCiService; commands: PostgresCommandCoordinator }
}
const actions: Record<CiTool, ManagementAction[]> = {
  ci_run: CI_RUN_ACTIONS,
  ci_get: CI_GET_ACTIONS,
  ci_computers_list: CI_GET_ACTIONS,
  ci_cancel: ['jobs:cancel'],
  ci_logs_read: CI_GET_ACTIONS,
}
export function ciCapabilities(context: CiContext, resource: AuthorizedResource) {
  if (!context.services.ci) return []
  return CI_TOOLS.filter(name => actions[name].every(action =>
    Object.keys(resource).length ? isAuthorized(context.principal, action, resource) : hasAction(context.principal, action)))
    .map(name => ({ name, actions: actions[name], detail: CI_CAPABILITY_DETAIL }))
}

export function registerCiTools(server: McpServer, context: CiContext) {
  const ci = context.services.ci
  if (!ci) return
  const operator = context.principal.audience === 'operator'
  const available = (name: CiTool) => !operator || ciCapabilities(context, {}).some(tool => tool.name === name)
  const invoke = async (name: CiTool, work: () => Promise<unknown>) => {
    try { return toolResult(await work()) }
    catch (error) {
      // Callers only see INTERNAL_ERROR; keep the cause in the server log.
      logOperatorToolFailure(name, error)
      if (error instanceof DomainError && [401, 403, 404].includes(error.status)) {
        await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
      } else {
        await context.services.commands.recordAudit(context.principal.id, 'mcp', name, `mcp:${name}`, 'failed', {
          code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR',
        })
      }
      return toolFailure(error)
    }
  }
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  if (available('ci_run')) server.registerTool('ci_run', {
    description: CI_CAPABILITY_DETAIL,
    inputSchema: operator ? OperatorCiRunInputSchema : CiRunInputSchema,
    outputSchema: CiRunOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, input => invoke('ci_run', () => ci.run(context.principal, input)))
  if (available('ci_get')) server.registerTool('ci_get', {
    description: CI_CAPABILITY_DETAIL,
    inputSchema: operator ? OperatorCiGetInputSchema : CiGetInputSchema,
    outputSchema: CiGetOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invoke('ci_get', () => ci.get(context.principal, input)))
  if (available('ci_computers_list')) server.registerTool('ci_computers_list', {
    description: 'List the build computers CI can use, with readiness (GitHub login, git, corepack), size and running runs. '
      + 'Read participation and priority with build_computer_get. '
      + CI_CAPABILITY_DETAIL,
    inputSchema: operator ? OperatorCiGetInputSchema.pick({ workspaceId: true }) : z.object({}).strict(),
    outputSchema: CiComputersOutputSchema, annotations: read,
  }, input => invoke('ci_computers_list', () => ci.computers(context.principal, input)))
  if (available('ci_cancel')) server.registerTool('ci_cancel', {
    description: 'Cancel a queued or running CI run by ticketId. Requires jobs:cancel. ' + CI_CAPABILITY_DETAIL,
    inputSchema: operator ? OperatorCiCancelInputSchema : CiCancelInputSchema,
    outputSchema: CiCancelOutputSchema,
    annotations: { ...read, readOnlyHint: false, destructiveHint: true },
  }, input => invoke('ci_cancel', () => ci.cancel(context.principal, input)))
  if (available('ci_logs_read')) server.registerTool('ci_logs_read', {
    description: 'Read a CI run log from its computer: omit afterOffset for the last maxBytes, or page forward with '
      + 'nextOffset. Queued runs return CI_NOT_STARTED. ' + CI_CAPABILITY_DETAIL,
    inputSchema: operator ? OperatorCiLogsInputSchema : CiLogsInputSchema,
    outputSchema: CiLogsOutputSchema, annotations: read,
  }, input => invoke('ci_logs_read', () => ci.logs(context.principal, input)))
}
