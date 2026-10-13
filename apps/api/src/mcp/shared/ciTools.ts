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

export const CI_CAPABILITY_DETAIL = 'ci_run runs one suite (install, typecheck, lint, unit, build, integration) of the workspace '
  + 'GitHub repository at a commit: the requested one, the Agent’s Run-start commit when unchanged, its edited files (published to GitHub first), or the default '
  + 'branch head. A build computer fetches it with its own GitHub CLI login, installs packages and runs the repository’s '
  + 'own script in an isolated worktree. Build computers retain repository, pnpm store and dependency caches; '
  + 'pnpm installs offline after warming a lockfile, and contracts builds are reused for unchanged inputs. '
  + 'The log reports setup milliseconds before the suite. '
  + 'gate=true with suite=integration, scope=full and no file or partition selection requests a complete '
  + 'typecheck+lint+unit+integration gate. Only Operators, including orchestrators using Operator credentials, can request gates; '
  + 'all existing CI start, cancellation and workspace grants still apply. Gates cannot be superseded. '
  + 'Integration files are assigned longest-first from recorded durations: each build computer runs one exclusive gate job '
  + 'with CPU/memory-sized internal shards (12 on a sufficiently provisioned 16-core computer). '
  + 'Cloud slots run checks first and integration overflow that reduces the predicted build-computer critical path. '
  + 'Exclusive and user-systemd files are balanced over eligible executors. One gate runs at a time across workspaces: '
  + 'other full requests wait behind queued/running gates with a reason; affected requests use spare capacity below gate priority. '
  + 'ci_get on any gate ticket reports per-computer and per-suite expected/actual durations, critical path and wallTimeMs. '
  + 'smokeComputer is Operator-only: unit or integration, affected scope, an explicit commit and one test file. '
  + 'It pins the job to that enabled computer through normal setup, grants and audit; no executor fallback or supersession. Integration smoke exercises gate planning and measured integration shard limits. '
  + 'ci_get reads back smokeComputer and the actual computer. '
  + 'scope defaults to affected; scope=full always runs everything. '
  + 'priority defaults to normal. Requesting high requires Operator role or an explicit workspace jobs:prioritize grant '
  + 'on the Agent’s live authorization principal, in addition to all CI run grants. '
  + 'Commits changing only CI infrastructure automatically receive high priority based on their Git changes, '
  + 'independent of caller files. Cloud and build-computer queues order high before normal, oldest first within each. '
  + 'ci_get returns persisted priority and priorityReason, plus queue position and waiting reason for queued tickets. '
  + 'Main and paired computers participate only with builds enabled; buildPriority orders their selection. '
  + 'When files are omitted in affected scope, optional baseCommit (full SHA) compares changes since that commit, '
  + 'so sandboxed Agents can request changes since a release through MCP without running git. baseCommit must be '
  + 'an available ancestor of the resolved commit; otherwise the full suite runs with a clear reason. '
  + 'Without baseCommit, the runner compares the resolved commit with its merge-base against the workspace default branch '
  + 'and uses the repository selector for the suite and part. Missing selectors, shared infrastructure changes and the '
  + 'default branch head (without baseCommit) run the full suite, with the reason in the run message or log. '
  + 'CI fetches the tested commit and the affected comparison base; jobs with explicit files use shallow checkouts. '
  + 'Cloud mirror branches are pruned after their last active ticket finishes, preserving persisted results and logs. '
  + 'Caller files remain supported; '
  + 'ci-remote continues to compute and send its selection. '
  + 'ci_get reads back the persisted baseCommit, scope and files. Empty affected selections pass without launching a runner. '
  + 'Requires the same CI run grants for either scope. Integration automatically targets four minutes of measured test time '
  + 'per part, bounded by free CI slots; partitions (2–64, integration only) caps that count. Heavy measured files stay alone '
  + 'when capacity permits. ci_get includes expectedDurationMs (test time plus 90 seconds setup); runner-derived affected '
  + 'selections use full-suite estimates. Requires scripts/ci-suite.sh and scripts/ci-files.mjs. '
  + 'User-systemd files use cloud executors declaring support or build computers; ordinary files use the other weighted slices on cloud slots. '
  + 'Mixed explicit integration selections split into separate host and ordinary slices even without partitions. '
  + 'Repositories providing the scripts/ci-suite.sh part contract automatically queue unit-api and unit-web shards '
  + '(defaults 5 and 3, sized from measured durations when available), unit-web-heavy and unit-other. '
  + 'Lint, typecheck and build each queue their -api and -other parts. Each part has its own ticket and shares a groupId; '
  + 'Other repositories run each suite as one job: corepack pnpm, npm or corepack yarn by lockfile (npm without a lockfile), '
  + 'install for install and run <suite> for the others, failing clearly when that script is missing. '
  + 'Cloud CI requires the mirror’s provider workflow (.github/workflows/ci.yml or .circleci/config.yml); '
  + 'without it build computers take the work. '
  + 'A cloud dispatch must create a workflow within 75 seconds; Main retries twice, then queues the same ticket '
  + 'on another provider or build computer. The ticket message records recovery and unstartedProviders lists excluded providers. '
  + 'Caller selections omit empty parts and shard only selected tests; runner selections keep queued parts and pass empty shards. '
  + 'Poll every ticket in partitions. Retrying commandId returns the '
  + 'original tickets. ci_get returns state (queued, starting, running, passed, failed, canceled, lost), current step, '
  + 'ci_run requires jobs:cancel as well as the CI start grants. A newer descendant commit cancels active tickets '
  + 'of the same suite, repository, workspace and requester on the same confirmed branch or Agent execution. '
  + 'Main, unrelated branches and noSupersede=true tickets are kept. ci_get returns supersededBy and '
  + 'the message superseded by <ticket>; follow that replacement ticket and all its partitions. '
  + 'computer, part, shard, exit code, group state and a 32 KiB log tail; ci_logs_read pages the full log '
  + `for authorized callers. maxBytes defaults to ${CI_LOG_MAX_BYTES} bytes and larger requests are clamped to `
  + `that maximum; responses report the applied maxBytes and nextOffset. group=true divides the capped budget `
  + 'between parts and reports each part’s maxBytes and nextOffset. '
  + 'ci_get reads the persisted background refresh without waiting for dispatch or build computers. '
  + 'Queued tickets include the dispatch waiting reason in message; it clears when they start. '
  + 'ci_computers_list shows readiness reasons, userSystemd support and its unavailable reason, used/total CI slots, assigned tickets and up to 500 authorized queued '
  + 'tickets with priority, global queue position and reason; queueTruncated reports additional tickets. '
  + 'Every part fails after 60 seconds without test results/output or max(3x expectedDurationMs, 120 seconds). '
  + 'The watchdog kills the process tree; message and logs name the running test from Vitest start events. '
  + 'Status and the log tail update on the dispatcher cadence (normally five seconds). Pre-upgrade tickets '
  + 'can have an empty cached tail; ci_logs_read still reads their logs. '
  + 'ci_get with testStatus (passed, failed, skipped) adds the ticket’s structured test results: '
  + 'a summary counting every test and, per test file, the tests with those statuses (bounded; failed tests first), '
  + 'each failure with its message and exact path:line:column location; '
  + 'finished unit and integration runs report them. The Operator lists every CI ticket of a Run, with the Agent node '
  + 'that requested it, placement (host, github, circleci) and test counts, with ci_list. '
  + 'Agent CI readback and cancellation are limited to tickets from that execution. '
  + 'Agent requests publish their persisted lifecycle into their Run’s activities and Board activity snapshot. '
  + '(group=true includes bounded pages and individual cursors for every part); ci_cancel stops one ticket. '
  + 'run_stop cancels every non-terminal ticket created by that Run’s Agents and its remote provider run, with audit. '
  + 'Agents are restricted to their active Run workspace. Computers without a GitHub login report it in ci_computers_list.'

export const CI_TOOLS = ['ci_run', 'ci_get', 'ci_computers_list', 'ci_cancel', 'ci_logs_read', 'ci_list'] as const
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
  ci_list: [...CI_GET_ACTIONS, 'runs:read'],
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
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, input => invoke('ci_run', () => ci.run(context.principal, input)))
  if (available('ci_get')) server.registerTool('ci_get', {
    description: CI_CAPABILITY_DETAIL,
    inputSchema: operator ? OperatorCiGetInputSchema : CiGetInputSchema,
    outputSchema: CiGetOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invoke('ci_get', () => ci.get(context.principal, input)))
  if (available('ci_computers_list')) server.registerTool('ci_computers_list', {
    description: 'List the build computers CI can use, with readiness (GitHub login, git, corepack), size '
      + 'used/total concurrent CI slots, available memory, and persisted starting/running ticket IDs. '
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
  // A Run's whole CI list is for the Operator; Agents read their own tickets with ci_get.
  if (operator && available('ci_list')) server.registerTool('ci_list', {
    description: 'List every CI ticket the Agents of one Run requested, newest first (at most 500): suite, part, '
      + 'partition, scope, state, step, computer and placement (host, github or circleci), timing, the requesting '
      + 'Agent’s executionId, agentId and workflow node, and passed/failed/skipped test counts once reported. '
      + 'Read a ticket’s tests with ci_get testStatus and its log with ci_logs_read. Requires runs:read on the Run. '
      + CI_CAPABILITY_DETAIL,
    inputSchema: OperatorCiListInputSchema, outputSchema: CiListOutputSchema, annotations: read,
  }, input => invoke('ci_list', () => ci.list(context.principal, input)))
}
