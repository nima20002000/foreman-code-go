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
  + 'own script in a fresh worktree, like a self-hosted runner. partitions (2–12, integration only) splits integration '
  + 'into duration-balanced runs on separate computers; poll every partition ticket. Retrying commandId returns the '
  + 'original tickets. ci_get returns state (queued, starting, running, passed, failed, canceled, lost), current step, '
  + 'computer, exit code and a 32 KiB log tail; ci_logs_read pages the full log; ci_cancel stops a run. '
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
