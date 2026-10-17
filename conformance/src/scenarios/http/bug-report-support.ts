import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  BugReportCreateInputSchema,
  BugReportCreateResultSchema,
  BugReportSchema,
  LocalHumanAccessSchema,
  type BugReport,
  type BugReportCreateInput,
} from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'

export const bugReportPath = '/api/management/bug-reports'

export async function createBugReport(ctx: ScenarioContext, workspaceId: string) {
  const callerResponse = await ctx.http.request('GET', '/api/local-human')
  assert.equal(callerResponse.status, 200)
  const caller = LocalHumanAccessSchema.parse(callerResponse.body).principal
  const input = BugReportCreateInputSchema.parse({
    workspaceId, commandId: randomUUID(), title: 'Conformance reproducible report',
    tried: { feature: 'Saved workflow view', inputsSummary: 'Opened the isolated workflow.' },
    happened: { errorCode: 'CONFORMANCE_SAMPLE', message: 'The sample view did not refresh.' },
    expected: 'The sample view should refresh.', severity: 'medium',
  })
  const response = await ctx.http.request('POST', bugReportPath, { body: input })
  const result = BugReportCreateResultSchema.parse(response.body)
  const created = BugReportSchema.parse(result.report)
  assertResponse(response, {
    status: 201,
    body: {
      report: {
        id: '<id>', workspaceId, title: input.title, tried: input.tried, happened: input.happened,
        expected: input.expected, severity: input.severity,
        status: 'open', revision: 1,
        reporter: { principalId: caller.id, name: caller.name, audience: 'user' }, harness: null,
        createdAt: '<timestamp>', updatedAt: '<timestamp>', lastReportedAt: '<timestamp>', occurrenceCount: 1,
      },
      deduplicated: false, outcome: 'created', message: `Filed as ${created.id}.`, replayed: false,
    },
  }, [
    { pointer: '/body/report/id', kind: 'id' },
    { pointer: '/body/report/createdAt', kind: 'timestamp' },
    { pointer: '/body/report/updatedAt', kind: 'timestamp' },
    { pointer: '/body/report/lastReportedAt', kind: 'timestamp' },
  ])
  assert.equal(created.createdAt, created.updatedAt)
  assert.equal(created.createdAt, created.lastReportedAt)
  assertResponse(await ctx.http.request('POST', bugReportPath, { body: input }), {
    status: 200, body: { ...result, replayed: true },
  })
  return { input, created }
}

export async function repeatBugReport(
  ctx: ScenarioContext,
  original: BugReportCreateInput,
  previous: BugReport,
  outcome: 'repeat' | 'reopened',
) {
  const input = BugReportCreateInputSchema.parse({
    ...original, commandId: randomUUID(), title: 'CONFORMANCE   REPRODUCIBLE REPORT',
  })
  const response = await ctx.http.request('POST', bugReportPath, { body: input })
  const result = BugReportCreateResultSchema.parse(response.body)
  const repeated = BugReportSchema.parse(result.report)
  let message = `Already filed as ${previous.id}, which is ${previous.status}. Counted as occurrence ${previous.occurrenceCount + 1}; no new report was created.`
  if (outcome === 'reopened') {
    message = `Already filed as ${previous.id} and closed as fixed; this repeat reopened it as a regression.`
  }
  assertResponse(response, {
    status: 200,
    body: {
      report: { ...previous, status: 'open', revision: previous.revision + 1,
        occurrenceCount: previous.occurrenceCount + 1, updatedAt: '<timestamp>', lastReportedAt: '<timestamp>' },
      deduplicated: true, outcome, message, replayed: false,
    },
  }, [
    { pointer: '/body/report/updatedAt', kind: 'timestamp' },
    { pointer: '/body/report/lastReportedAt', kind: 'timestamp' },
  ])
  assert.equal(repeated.updatedAt, repeated.lastReportedAt)
  assertResponse(await ctx.http.request('POST', bugReportPath, { body: input }), {
    status: 200, body: { ...result, replayed: true },
  })
  return repeated
}
