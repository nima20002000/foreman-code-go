import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  BugReportCloseInputSchema,
  BugReportCloseResultSchema,
  BugReportUpdateInputSchema,
  BugReportUpdateResultSchema,
} from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage } from '../smoke/support.js'
import { bugReportPath, createBugReport, repeatBugReport } from './bug-report-support.js'
import { assertProtectedRead, readCoverage } from './support.js'

export const bugReportScenario: Scenario = {
  id: 'http.bug-reports.lifecycle',
  title: 'Bug reports preserve deduplication, status receipts, closed history, and reopened regressions',
  lane: 'A1',
  authentication: 'local-human',
  covers: [
    ...readCoverage(bugReportPath),
    ...readCoverage(`${bugReportPath}/:reportId`),
    httpCoverage('POST', bugReportPath, 'success'),
    httpCoverage('POST', bugReportPath, 'error'),
    httpCoverage('POST', `${bugReportPath}/:reportId/status`, 'success'),
    httpCoverage('POST', `${bugReportPath}/:reportId/status`, 'error'),
    httpCoverage('POST', `${bugReportPath}/close`, 'success'),
    httpCoverage('POST', `${bugReportPath}/close`, 'error'),
  ],
  async run(ctx) {
    const workspace = await createWorkspace(ctx, 'Bug report lifecycle workspace')
    const workspaceId = workspace.created.workspace.id
    const listing = `${bugReportPath}?workspaceId=${encodeURIComponent(workspaceId)}`
    await assertProtectedRead(ctx, listing, { items: [], pageInfo: { nextCursor: null } })
    const { input, created } = await createBugReport(ctx, workspaceId)
    const path = `${bugReportPath}/${created.id}`
    await assertProtectedRead(ctx, path, created)
    assertApiError(await ctx.http.request('POST', bugReportPath, {
      body: { ...input, title: 'Conflicting report command' },
    }), 409, 'COMMAND_ID_CONFLICT', 'This command ID was already used with different input.')
    const repeated = await repeatBugReport(ctx, input, created, 'repeat')
    await assertProtectedRead(ctx, path, repeated)

    const status = BugReportUpdateInputSchema.parse({
      reportId: created.id, commandId: randomUUID(), expectedRevision: 2, status: 'triaged',
    })
    const response = await ctx.http.request('POST', `${path}/status`, { body: status })
    const triaged = BugReportUpdateResultSchema.parse(response.body).report
    assertResponse(response, {
      status: 200, body: { report: { ...repeated, status: 'triaged', revision: 3, updatedAt: '<timestamp>' }, replayed: false },
    }, [{ pointer: '/body/report/updatedAt', kind: 'timestamp' }])
    assertResponse(await ctx.http.request('POST', `${path}/status`, { body: status }), {
      status: 200, body: { report: triaged, replayed: true },
    })
    assertApiError(await ctx.http.request('POST', `${path}/status`, {
      body: { ...status, commandId: randomUUID(), status: 'open' },
    }), 409, 'REVISION_CONFLICT', 'The bug report changed. Read it again before updating its status.')
    assertApiError(await ctx.http.request('POST', `${path}/status`, {
      body: { ...status, commandId: randomUUID(), expectedRevision: 3, status: 'fixed' },
    }), 400, 'INVALID_INPUT', 'Close reports with bug_reports_close; closed-status updates only replay saved commands.')
    await assertProtectedRead(ctx, `${listing}&status=triaged`, { items: [triaged], pageInfo: { nextCursor: null } })

    const close = BugReportCloseInputSchema.parse({
      commandId: randomUUID(), reports: [{ reportId: created.id, expectedRevision: 3 }],
      status: 'fixed', note: 'Resolved in the isolated conformance workspace.',
    })
    assertApiError(await ctx.http.request('POST', `${bugReportPath}/close`, {
      body: { ...close, commandId: randomUUID(), reports: [{ reportId: created.id, expectedRevision: 2 }] },
    }), 409, 'REVISION_CONFLICT', `Bug report ${created.id} changed. Read it again before closing it.`)
    const closedResponse = await ctx.http.request('POST', `${bugReportPath}/close`, { body: close })
    const closed = BugReportCloseResultSchema.parse(closedResponse.body).reports[0]!
    assertResponse(closedResponse, {
      status: 200,
      body: { reports: [{ ...triaged, status: 'fixed', revision: 4, updatedAt: '<timestamp>',
        resolution: { status: 'fixed', note: close.note, closedAt: '<timestamp>' } }], replayed: false },
    }, [
      { pointer: '/body/reports/0/updatedAt', kind: 'timestamp' },
      { pointer: '/body/reports/0/resolution/closedAt', kind: 'timestamp' },
    ])
    assert.equal(closed.updatedAt, closed.resolution?.closedAt)
    assertResponse(await ctx.http.request('POST', `${bugReportPath}/close`, { body: close }), {
      status: 200, body: { reports: [closed], replayed: true },
    })
    await assertProtectedRead(ctx, listing, { items: [], pageInfo: { nextCursor: null } })
    await assertProtectedRead(ctx, `${listing}&view=history`, { items: [closed], pageInfo: { nextCursor: null } })
    const reopened = await repeatBugReport(ctx, input, closed, 'reopened')
    await assertProtectedRead(ctx, listing, { items: [reopened], pageInfo: { nextCursor: null } })
    await assertProtectedRead(ctx, `${listing}&view=history`, { items: [], pageInfo: { nextCursor: null } })
    await ctx.target.restart()
    await assertProtectedRead(ctx, path, reopened)
  },
}
