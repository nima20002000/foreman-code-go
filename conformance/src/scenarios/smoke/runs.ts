import { randomUUID } from 'node:crypto'
import { RunStopInputSchema } from '@foreman-code/contracts/management'
import { CurrentRunPageSchema } from '@foreman-code/contracts/wave25'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage } from './support.js'

const runsPath = '/api/management/workspaces/:workspaceId/runs'

export const runScenarios: Scenario[] = [
  {
    id: 'runs.empty-history', title: 'A new workspace has no accepted runs', lane: 'E',
    covers: [httpCoverage('GET', runsPath, 'success')],
    async run(ctx) {
      const { created } = await createWorkspace(ctx, 'Conformance run history')
      const response = await ctx.http.request('GET', `/api/management/workspaces/${created.workspace.id}/runs`)
      CurrentRunPageSchema.parse(response.body)
      assertResponse(response, { status: 200, body: { items: [], pageInfo: { nextCursor: null } } })
    },
  },
  {
    id: 'runs.missing-read', title: 'Run details reject an absent run in the requested workspace', lane: 'E',
    covers: [httpCoverage('GET', `${runsPath}/:runId`, 'error')],
    async run(ctx) {
      const { created } = await createWorkspace(ctx, 'Conformance missing run')
      const response = await ctx.http.request('GET', `/api/management/workspaces/${created.workspace.id}/runs/${randomUUID()}`)
      assertApiError(response, 404, 'RUN_NOT_FOUND', 'The Run was not found in this workspace.')
    },
  },
  {
    id: 'runs.missing-stop', title: 'Stop rejects an absent run without publishing a run or receipt', lane: 'E',
    covers: [httpCoverage('POST', `${runsPath}/:runId/stop`, 'error')],
    async run(ctx) {
      const { created } = await createWorkspace(ctx, 'Conformance absent Stop')
      const input = RunStopInputSchema.parse({ workspaceId: created.workspace.id, runId: randomUUID(), commandId: randomUUID() })
      const path = `/api/management/workspaces/${created.workspace.id}/runs`
      assertApiError(await ctx.http.request('POST', `${path}/${input.runId}/stop`, { body: input }),
        404, 'RUN_NOT_FOUND', 'The Run was not found in this workspace.')
      assertResponse(await ctx.http.request('GET', path), { status: 200, body: { items: [], pageInfo: { nextCursor: null } } })
    },
  },
]
