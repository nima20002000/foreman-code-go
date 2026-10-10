import {
  BugReportCreateInputSchema,
  BugReportListInputSchema,
  BugReportSchema,
  BugReportUpdateInputSchema,
  type BugReport,
  type BugReportCreateInput,
  type BugReportCreateResult,
  type BugReportListInput,
  type BugReportUpdateInput,
  type BugReportUpdateResult,
  type ManagementPrincipal,
} from '@foreman-code/contracts/management'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { commandInputHash, type PostgresCommandCoordinator } from '../commands/postgres.js'
import { requireAuthorization, type AuthorizedResource } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { liveBugReportPrincipal, readGrantFilter, reportingContext, type ReportContext } from './authorization.js'
import { listBugReports, readBugReport, recordBugReport, saveBugReport } from './repository.js'
import { redactBugReportText } from './redaction.js'

type CommandSource = 'http' | 'mcp'

function safeReportInput(input: BugReportCreateInput): BugReportCreateInput {
  return {
    ...input,
    commandId: commandInputHash(input.commandId),
    title: redactBugReportText(input.title),
    tried: {
      feature: redactBugReportText(input.tried.feature),
      inputsSummary: redactBugReportText(input.tried.inputsSummary),
    },
    happened: {
      message: redactBugReportText(input.happened.message),
      ...(input.happened.errorCode === undefined ? {} : { errorCode: redactBugReportText(input.happened.errorCode) }),
    },
    expected: redactBugReportText(input.expected),
  }
}

function repeatFingerprint(reporterIdentity: string, input: BugReportCreateInput): string {
  const content: Partial<BugReportCreateInput> = { ...input }
  delete content.commandId
  const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase()
  return commandInputHash({
    reporterIdentity,
    ...content,
    title: normalize(input.title),
    tried: { feature: normalize(input.tried.feature), inputsSummary: normalize(input.tried.inputsSummary) },
    happened: {
      message: normalize(input.happened.message),
      errorCode: normalize(input.happened.errorCode ?? ''),
    },
    expected: normalize(input.expected),
  })
}

function reportScope(report: BugReport): AuthorizedResource {
  return {
    workspaceId: report.workspaceId,
    ...(report.workflowId === undefined ? {} : { workflowId: report.workflowId }),
    ...(report.runId === undefined ? {} : { runId: report.runId }),
  }
}

export class BugReportService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator) {}

  async report(
    principal: ManagementPrincipal,
    source: CommandSource,
    raw: BugReportCreateInput,
  ): Promise<BugReportCreateResult> {
    const accepted = BugReportCreateInputSchema.parse(raw)
    let current = await this.liveCaller(principal, source, 'bug_reports.report')
    let context: ReportContext
    try {
      context = await reportingContext(this.pool, current, source, accepted)
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await this.commands.recordDenied(principal.id, source, 'bug_reports.report', 'bug-reports')
      }
      throw error
    }
    const input = safeReportInput({
      ...accepted,
      workspaceId: context.workspaceId,
      ...(context.workflowId ? { workflowId: context.workflowId } : {}),
      ...(context.runId ? { runId: context.runId } : {}),
    })
    const result = await this.commands.execute({
      principal: current,
      source,
      operation: 'bug_reports.report',
      commandId: input.commandId,
      targetKey: `bug-reports:${context.workspaceId}`,
      payload: { input, originalInputHash: commandInputHash(accepted) },
      authorize: async sql => {
        current = await liveBugReportPrincipal(sql, principal)
        context = await reportingContext(sql, current, source, input)
      },
      perform: async sql => {
        const now = new Date().toISOString()
        const content: Partial<BugReportCreateInput> = { ...input }
        delete content.commandId
        const { reporterIdentity, ...metadata } = context
        const report = BugReportSchema.parse({
          ...content,
          ...metadata,
          id: `bug-report-${randomUUID()}`,
          status: 'open',
          revision: 1,
          createdAt: now,
          updatedAt: now,
          lastReportedAt: now,
          occurrenceCount: 1,
        })
        return recordBugReport(sql, report, repeatFingerprint(reporterIdentity, input))
      },
    })
    return { ...result.value, replayed: result.replayed }
  }

  async list(principal: ManagementPrincipal, raw: BugReportListInput) {
    const input = BugReportListInputSchema.parse(raw)
    const current = await liveBugReportPrincipal(this.pool, principal)
    const parameters: unknown[] = []
    const filter = readGrantFilter(current, parameters)
    return listBugReports(this.pool, input, filter, parameters)
  }

  async get(principal: ManagementPrincipal, reportId: string) {
    const current = await liveBugReportPrincipal(this.pool, principal)
    if (current.audience !== 'operator') throw new DomainError('ACCESS_DENIED', 'Agents can only submit bug reports.', 403)
    const report = await readBugReport(this.pool, reportId)
    requireAuthorization(current, 'bug_reports:read', reportScope(report))
    return report
  }

  async update(
    principal: ManagementPrincipal,
    source: CommandSource,
    raw: BugReportUpdateInput,
  ): Promise<BugReportUpdateResult> {
    const accepted = BugReportUpdateInputSchema.parse(raw)
    const current = await this.liveCaller(principal, source, 'bug_reports.update')
    if (current.audience !== 'operator') {
      await this.commands.recordDenied(principal.id, source, 'bug_reports.update', 'bug-reports')
      throw new DomainError('ACCESS_DENIED', 'Agents can only submit bug reports.', 403)
    }
    const report = await readBugReport(this.pool, accepted.reportId)
    try {
      requireAuthorization(current, 'bug_reports:update', reportScope(report))
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await this.commands.recordDenied(principal.id, source, 'bug_reports.update', report.id)
      }
      throw error
    }
    const input = { ...accepted, commandId: commandInputHash(accepted.commandId) }
    const result = await this.commands.execute({
      principal: current,
      source,
      operation: 'bug_reports.update',
      commandId: input.commandId,
      targetKey: report.id,
      payload: input,
      authorize: async sql => {
        const live = await liveBugReportPrincipal(sql, principal)
        const saved = await readBugReport(sql, report.id, 'update')
        requireAuthorization(live, 'bug_reports:update', reportScope(saved))
      },
      perform: async sql => {
        const previous = await readBugReport(sql, report.id, 'update')
        if (previous.revision !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'The bug report changed. Read it again before updating its status.', 409)
        }
        const updated = {
          ...previous,
          status: input.status,
          revision: previous.revision + 1,
          updatedAt: new Date().toISOString(),
        }
        await saveBugReport(sql, updated)
        return updated
      },
    })
    return { report: result.value, replayed: result.replayed }
  }

  private async liveCaller(principal: ManagementPrincipal, source: CommandSource, action: string) {
    try {
      return await liveBugReportPrincipal(this.pool, principal)
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await this.commands.recordDenied(principal.id, source, action, 'bug-reports')
      }
      throw error
    }
  }
}
