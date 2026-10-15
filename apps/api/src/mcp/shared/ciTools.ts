import type { McpServer } from '@modelcontextprotocol/server'
import { CiRunInputSchema, OperatorCiRunInputSchema, CiRunOutputSchema,
  CiGetInputSchema, OperatorCiGetInputSchema, CiGetOutputSchema,
  CiCancelInputSchema, OperatorCiCancelInputSchema, CiCancelOutputSchema,
  CI_LOG_MAX_BYTES, CiLogsInputSchema, OperatorCiLogsInputSchema, CiLogsOutputSchema, CiComputersOutputSchema,
  OperatorCiListInputSchema, CiListOutputSchema } from '@foreman-code/contracts'
import { z } from 'zod'
import type { ManagementPrincipal, ManagementAction } from '@foreman-code/contracts/management'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../../modules/jobs/ciAuthority.js'
import type { HostCiService } from '../../modules/ci-host/service.js'
import type { PostgresCommandCoordinator } from '../../modules/commands/postgres.js'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../modules/access/policy.js'
import { DomainError } from '../../modules/errors.js'
import { toolFailure, toolResult } from './results.js'
import { logOperatorToolFailure } from '../operator/invoke.js'
import { deviceBusyFailure } from '../../modules/devices/deviceBusyError.js'

/** What each CI tool does. Agents act on this text, so keep it short and true to the code. */
export const CI_TOOL_DESCRIPTIONS = {
  ci_run: 'Run one suite (install, typecheck, lint, unit, build or integration) of the workspace GitHub repository on '
    + 'build computers and cloud runners. Commit: the given one; otherwise an Agent\u2019s edited files (published to GitHub '
    + 'first, snapshot up to 32 MiB) or its Run-start commit; otherwise the default branch head. scope defaults to affected: '
    + 'the files you pass, or the files changed since baseCommit (a full SHA ancestor) or since the merge-base with the '
    + 'default branch; infrastructure changes and suites without a selector run everything, with the reason in message. '
    + 'scope=full runs everything. Integration splits into parts of about four minutes of measured test time; omit '
    + 'partitions to let CI size them (2\u201364 caps the count). Slow integration files start after the fast tier passes. '
    + 'Affected runs with explicit files skip files an earlier passed ticket ran with identical inputs (cachedFiles). '
    + 'gate=true (Operators only; integration, scope full, no files or partitions) runs typecheck, lint, unit and '
    + 'integration across every computer; one gate runs at a time. priority is normal or high. A newer descendant commit '
    + 'from the same requester on the same branch or Agent execution cancels its older active tickets of the same suite '
    + 'unless noSupersede=true; ci_get then reports supersededBy. commandId is optional; repeating it with the same input '
    + 'returns the original tickets. Returns ticketId and, for multi-part runs, partitions: wait for the group with one '
    + 'ci_get waitUntil=group-terminal call on any ticket, not by polling.',
  ci_get: 'Read one CI ticket. reassignment retains its cause, previous host, time and cumulative count. '
    + 'mirrorPublication.repair retains clone repair cause, source, duration and count. '
    + 'observation reports whether live state is available, its last successful read, '
    + 'sanitized lastError, consecutiveFailures and nextAttemptAt. Retained state is not a confirmed live observation. '
    + 'transport reports REST/CLI source, fallback reason and count when available. '
    + 'State (queued, starting, running, passed, failed, canceled, lost), step, computer, part '
    + 'and shard, exit code, message, a 32 KiB log tail, its group\u2019s partitions and group state, queue position and '
    + 'reason while queued, expectedDurationMs, cachedFiles, and supersededBy (follow the replacement ticket and its '
    + 'partitions). Gate tickets add per-computer and per-suite expected and actual durations. testStatus (passed, failed, '
    + 'skipped) adds structured test results, each failure with its message and path:line:column. A background dispatcher '
    + 'refreshes healthy state about every second; unavailable observations use bounded backoff. To wait, make one call '
    + 'with waitUntil=group-terminal, waitSeconds=1800 and logTail=false on any ticket of the group instead of polling: '
    + 'it returns wait.status settled once every ticket of the group is terminal and its results are collected '
    + '(partitions then lists each final ticket), or still-running with tickets and settledTickets when the budget ends; '
    + 'call again to keep waiting. The managed bridge holds the call open across bounded chunks; a direct HTTP call '
    + 'answers within 60 seconds. Read logs once at the end with ci_logs_read. Without waitUntil, waitSeconds waits at '
    + 'most 60 seconds for this ticket’s state or step to change or a terminal state; request cancellation '
    + 'ends any wait. A part fails after 180 seconds without output or after '
    + 'max(3 \u00d7 expectedDurationMs, 120 seconds); a cloud part that fails before its first test is retried once on another '
    + 'slot (setupRetry). A failed ticket adds failureHistory: how many of the latest gate runs that ran each failed '
    + 'test also failed it, so a known flake is recognized. Agents with ci_get read every ticket of their workspace.',
  ci_computers_list: 'List the computers CI can use: readiness and its reasons (GitHub login, git, corepack, user '
    + 'systemd), saved buildAllowancePercent, allowedCpuCount, CPU and memory within that allowance, '
    + 'used and total CI slots, available memory, running tickets, and up to 500 queued tickets with priority, '
    + 'queue position and reason (queueTruncated reports more). Read participation and priority with build_computer_get.',
  ci_cancel: 'Cancel a queued or running CI ticket by ticketId. Optional commandId is recorded once in the audit, so a '
    + 'retry is safe. CI_CANCEL_PENDING means remote cleanup is unconfirmed and still retrying. run_stop cancels every '
    + 'open ticket of that Run\u2019s Agents.',
  ci_logs_read: `Read a CI ticket\u2019s full log from its computer: omit afterOffset for the last maxBytes (at most ${CI_LOG_MAX_BYTES}), `
    + 'or page forward with nextOffset. group=true pages every part of the ticket\u2019s group within the same budget. '
    + 'Queued tickets return CI_NOT_STARTED.',
  ci_list: 'List CI tickets the Agents of one Run requested, newest first (at most 500). '
    + 'Optional executionId filters before the limit. Each ticket includes suite, part, '
    + 'partition, scope, state, step, computer and placement (host, github or circleci), timing, the requesting '
    + 'Agent\u2019s executionId, agentId and workflow node, and passed/failed/skipped test counts once reported. '
    + 'Read a ticket\u2019s tests with ci_get testStatus and its log with ci_logs_read. Requires runs:read on the Run.',
} as const

export const CI_TOOLS = ['ci_run', 'ci_get', 'ci_computers_list', 'ci_cancel', 'ci_logs_read', 'ci_list'] as const
type CiTool = typeof CI_TOOLS[number]
interface CiContext {
  principal: ManagementPrincipal
  signal?: AbortSignal
  services: { ci?: HostCiService; commands: PostgresCommandCoordinator }
}
const actions: Record<CiTool, ManagementAction[]> = {
  ci_run: CI_RUN_ACTIONS,
  ci_get: CI_GET_ACTIONS,
  ci_computers_list: CI_GET_ACTIONS,
  ci_cancel: CI_RUN_ACTIONS,
  ci_logs_read: CI_GET_ACTIONS,
  ci_list: [...CI_GET_ACTIONS, 'runs:read'],
}
export function ciCapabilities(context: CiContext, resource: AuthorizedResource) {
  if (!context.services.ci) return []
  return CI_TOOLS.filter(name => actions[name].every(action =>
    Object.keys(resource).length ? isAuthorized(context.principal, action, resource) : hasAction(context.principal, action)))
    .map(name => ({ name, actions: actions[name], detail: CI_TOOL_DESCRIPTIONS[name] }))
}

export function registerCiTools(server: McpServer, context: CiContext) {
  const ci = context.services.ci
  if (!ci) return
  const operator = context.principal.audience === 'operator'
  const available = (name: CiTool) => !operator || ciCapabilities(context, {}).some(tool => tool.name === name)
  const invoke = async (name: CiTool, work: () => Promise<unknown>) => {
    try { return toolResult(await work()) }
    catch (caughtError) {
      const error = deviceBusyFailure(caughtError)
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
    description: CI_TOOL_DESCRIPTIONS.ci_run,
    inputSchema: operator ? OperatorCiRunInputSchema : CiRunInputSchema,
    outputSchema: CiRunOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, input => invoke('ci_run', () => ci.run(context.principal, input)))
  if (available('ci_get')) server.registerTool('ci_get', {
    description: CI_TOOL_DESCRIPTIONS.ci_get,
    inputSchema: operator ? OperatorCiGetInputSchema : CiGetInputSchema,
    outputSchema: CiGetOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input, extra) => invoke('ci_get', () => ci.get(context.principal, input,
    context.signal ? AbortSignal.any([context.signal, extra.mcpReq.signal]) : extra.mcpReq.signal)))
  if (available('ci_computers_list')) server.registerTool('ci_computers_list', {
    description: CI_TOOL_DESCRIPTIONS.ci_computers_list,
    inputSchema: operator ? OperatorCiGetInputSchema.pick({ workspaceId: true }) : z.object({}).strict(),
    outputSchema: CiComputersOutputSchema, annotations: read,
  }, input => invoke('ci_computers_list', () => ci.computers(context.principal, input)))
  if (available('ci_cancel')) server.registerTool('ci_cancel', {
    description: CI_TOOL_DESCRIPTIONS.ci_cancel,
    inputSchema: operator ? OperatorCiCancelInputSchema : CiCancelInputSchema,
    outputSchema: CiCancelOutputSchema,
    annotations: { ...read, readOnlyHint: false, destructiveHint: true },
  }, input => invoke('ci_cancel', () => ci.cancel(context.principal, input)))
  if (available('ci_logs_read')) server.registerTool('ci_logs_read', {
    description: CI_TOOL_DESCRIPTIONS.ci_logs_read,
    inputSchema: operator ? OperatorCiLogsInputSchema : CiLogsInputSchema,
    outputSchema: CiLogsOutputSchema, annotations: read,
  }, input => invoke('ci_logs_read', () => ci.logs(context.principal, input)))
  // A Run's whole CI list is for the Operator; Agents read workspace tickets with ci_get.
  if (operator && available('ci_list')) server.registerTool('ci_list', {
    description: CI_TOOL_DESCRIPTIONS.ci_list,
    inputSchema: OperatorCiListInputSchema, outputSchema: CiListOutputSchema, annotations: read,
  }, input => invoke('ci_list', () => ci.list(context.principal, input)))
}
