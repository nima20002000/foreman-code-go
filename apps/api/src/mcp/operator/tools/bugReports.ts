import {
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
      description: 'List authorized Foreman Code bug reports newest first. Filter by workspaceId, status or severity; '
        + 'follow pageInfo.nextCursor. Requires bug_reports:read for each returned report.',
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
      description: 'Mark a Foreman Code bug report open, triaged, fixed or wont-fix using its expectedRevision. '
        + 'Retry the same commandId and payload after an uncertain response. A different command with a stale '
        + 'revision conflicts. Requires bug_reports:update in the report scope; read-only callers cannot update.',
      inputSchema: BugReportUpdateInputSchema,
      outputSchema: BugReportUpdateResultSchema,
      annotations: { ...readAnnotations, readOnlyHint: false },
    }, input => invokeOperatorTool(context, 'bug_report_update', () => service.update(context.principal, 'mcp', input)))
  }
}
