import {
  BugReportCloseInputSchema,
  BugReportCloseResultSchema,
  BugReportGetInputSchema,
  BugReportListInputSchema,
  BugReportPageSchema,
  BugReportSchema,
  BugReportUpdateInputSchema,
  BugReportUpdateResultSchema,
} from '@foreman-code/contracts/management'
import type { McpServer } from '@modelcontextprotocol/server'

import { registerBugReportTool } from '../../shared/bugReports.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorRequestContext } from '../types.js'

const readAnnotations = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
} as const

export function registerBugReportTools(server: McpServer, context: OperatorRequestContext): void {
  const service = context.services.bugReports
  if (!service) return
  if (operatorToolAvailable(context, 'bug_report')) {
    registerBugReportTool(server, {
      principal: context.principal,
      service,
      invoke: work => invokeOperatorTool(context, 'bug_report', work),
    })
  }
  if (operatorToolAvailable(context, 'bug_reports_list')) {
    server.registerTool('bug_reports_list', {
      description: 'List authorized Foreman Code bug reports newest first. By default only active (open or triaged) '
        + 'reports are returned; closed reports are archived. Pass view "history" for closed reports (fixed, wont-fix, '
        + 'duplicate) with their resolution status, note and closedAt. A status filter narrows the view, or selects that '
        + 'status alone when view is omitted. Filter by workspaceId or severity; follow pageInfo.nextCursor. '
        + 'Requires bug_reports:read for each returned report.',
      inputSchema: BugReportListInputSchema,
      outputSchema: BugReportPageSchema,
      annotations: readAnnotations,
    }, input => invokeOperatorTool(context, 'bug_reports_list', () => service.list(context.principal, input)))
  }
  if (operatorToolAvailable(context, 'bug_report_get')) {
    server.registerTool('bug_report_get', {
      description: 'Read a persisted Foreman Code bug report, including reporter, execution scope, harness, '
        + 'occurrence count and current revision. Requires bug_reports:read in the report scope.',
      inputSchema: BugReportGetInputSchema,
      outputSchema: BugReportSchema,
      annotations: readAnnotations,
    }, input => invokeOperatorTool(context, 'bug_report_get', () => service.get(context.principal, input.reportId)))
  }
  if (operatorToolAvailable(context, 'bug_report_update')) {
    server.registerTool('bug_report_update', {
      description: 'Mark a Foreman Code bug report open or triaged using its expectedRevision; this also reopens a '
        + 'closed report. Close reports with bug_reports_close. '
        + 'Previously saved fixed/wont-fix update commands can still be retried with their original input; new '
        + 'closed-status updates are rejected. '
        + 'Retry the same commandId and payload after an uncertain response. A different command with a stale '
        + 'revision conflicts. Requires bug_reports:update in the report scope; read-only callers cannot update.',
      inputSchema: BugReportUpdateInputSchema,
      outputSchema: BugReportUpdateResultSchema,
      annotations: { ...readAnnotations, readOnlyHint: false },
    }, input => invokeOperatorTool(context, 'bug_report_update', () => service.update(context.principal, 'mcp', input)))
  }
  if (operatorToolAvailable(context, 'bug_reports_close')) {
    server.registerTool('bug_reports_close', {
      description: 'Close one or more Foreman Code bug reports in one all-or-nothing call and archive them from the '
        + 'default bug_reports_list view. status is fixed, wont-fix or duplicate; duplicate requires duplicateOfId, a '
        + 'report in the same workspace. Optional note records a short reason such as the release or commit. Give each '
        + 'report its expectedRevision; any stale revision rejects the whole call. A later repeat of a fixed report '
        + 'reopens it as a regression. Retry the same commandId and payload after an uncertain response. Requires '
        + 'bug_reports:read and bug_reports:update on every report (and bug_reports:read on the duplicate target); '
        + 'read-only callers cannot close.',
      inputSchema: BugReportCloseInputSchema,
      outputSchema: BugReportCloseResultSchema,
      annotations: { ...readAnnotations, readOnlyHint: false },
    }, input => invokeOperatorTool(context, 'bug_reports_close', () => service.close(context.principal, 'mcp', input)))
  }
}
