import {
  BugReportSchema,
  type BugReport,
  type BugReportPage,
  type BugReportListInput,
} from '@foreman-code/contracts/management'
import { IdSchema, TimestampSchema } from '@foreman-code/contracts'
import { z } from 'zod'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'

const CursorSchema = z.object({ createdAt: TimestampSchema, id: IdSchema }).strict()

export async function readBugReport(sql: GraphSqlClient, id: string, lock?: 'update'): Promise<BugReport> {
  const row = (await sql.query<{ record: unknown }>(
    `select record from bug_reports where id=$1${lock === 'update' ? ' for update' : ''}`, [id],
  )).rows[0]
  if (!row) throw new DomainError('BUG_REPORT_NOT_FOUND', 'The bug report was not found.', 404)
  return BugReportSchema.parse(row.record)
}

export async function saveBugReport(sql: GraphSqlClient, report: BugReport): Promise<void> {
  await sql.query(
    'update bug_reports set record=$2::jsonb,status=$3,revision=$4 where id=$1',
    [report.id, JSON.stringify(report), report.status, report.revision],
  )
}

export async function recordBugReport(
  sql: GraphSqlClient,
  report: BugReport,
  fingerprint: string,
): Promise<{ report: BugReport; deduplicated: boolean }> {
  await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`bug-report:${fingerprint}`])
  const existing = (await sql.query<{ record: unknown }>(
    'select record from bug_reports where fingerprint=$1 for update', [fingerprint],
  )).rows[0]
  if (existing) {
    const previous = BugReportSchema.parse(existing.record)
    const updated = {
      ...previous,
      occurrenceCount: previous.occurrenceCount + 1,
      lastReportedAt: report.lastReportedAt,
      updatedAt: report.updatedAt,
      revision: previous.revision + 1,
    }
    await saveBugReport(sql, updated)
    return { report: updated, deduplicated: true }
  }
  await sql.query(
    `insert into bug_reports(id,workspace_id,workflow_id,run_id,fingerprint,status,severity,revision,record,created_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
    [report.id, report.workspaceId, report.workflowId ?? null, report.runId ?? null, fingerprint,
      report.status, report.severity, report.revision, JSON.stringify(report), report.createdAt],
  )
  return { report, deduplicated: false }
}

export async function listBugReports(
  sql: GraphSqlClient,
  input: BugReportListInput,
  grantFilter: string,
  parameters: unknown[],
): Promise<BugReportPage> {
  const conditions = [`(${grantFilter})`]
  for (const [field, column] of Object.entries({ workspaceId: 'workspace_id', status: 'status', severity: 'severity' })) {
    const value = input[field as 'workspaceId' | 'status' | 'severity']
    if (value) {
      parameters.push(value)
      conditions.push(`${column}=$${parameters.length}`)
    }
  }
  if (input.cursor) {
    let cursor: z.infer<typeof CursorSchema>
    try {
      cursor = CursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')))
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new DomainError('INVALID_CURSOR', 'The bug report cursor is invalid.', 400)
      }
      throw error
    }
    parameters.push(cursor.createdAt, cursor.id)
    conditions.push(`(created_at,id)<($${parameters.length - 1}::timestamptz,$${parameters.length})`)
  }
  const limit = input.limit ?? 30
  parameters.push(limit + 1)
  const rows = (await sql.query<{ record: unknown }>(
    `select record from bug_reports where ${conditions.join(' and ')}
     order by created_at desc,id desc limit $${parameters.length}`, parameters,
  )).rows
  const items = rows.slice(0, limit).map(row => BugReportSchema.parse(row.record))
  const last = items.at(-1)
  const nextCursor = rows.length > limit && last
    ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64url')
    : null
  return { items, pageInfo: { nextCursor } }
}
