import { randomUUID } from 'node:crypto'
import { JobQueuePageSchema } from '@foreman-code/contracts/job-admission'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage } from './support.js'

const jobsPath = '/api/management/workspaces/:workspaceId/jobs'

export const jobScenarios: Scenario[] = [
  {
    id: 'jobs.empty-definitions', title: 'A new workspace has no Job definitions', lane: 'J',
    covers: [httpCoverage('GET', `${jobsPath}/definitions`, 'success')],
    async run(ctx) {
      const { created } = await createWorkspace(ctx, 'Conformance Job definitions')
      const response = await ctx.http.request('GET', `/api/management/workspaces/${created.workspace.id}/jobs/definitions`)
      assertResponse(response, { status: 200, body: { definitions: [] } })
    },
  },
  {
    id: 'jobs.empty-queue', title: 'A new workspace has no active or historical queued Jobs', lane: 'J',
    covers: [httpCoverage('GET', `${jobsPath}/queue`, 'success')],
    async run(ctx) {
      const { created } = await createWorkspace(ctx, 'Conformance Job queue')
      const response = await ctx.http.request('GET', `/api/management/workspaces/${created.workspace.id}/jobs/queue`)
      JobQueuePageSchema.parse(response.body)
      assertResponse(response, { status: 200, body: { tickets: [], nextHistoryCursor: null } })
    },
  },
  {
    id: 'jobs.missing-definition', title: 'A Job definition read cannot cross an absent definition boundary', lane: 'J',
    covers: [httpCoverage('GET', `${jobsPath}/definitions/:definitionId`, 'error')],
    async run(ctx) {
      const { created } = await createWorkspace(ctx, 'Conformance missing Job')
      const response = await ctx.http.request('GET', `/api/management/workspaces/${created.workspace.id}/jobs/definitions/${randomUUID()}`)
      assertApiError(response, 404, 'JOB_DEFINITION_NOT_FOUND', 'The job definition was not found in this workspace.')
    },
  },
]
