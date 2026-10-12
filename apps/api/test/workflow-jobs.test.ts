import { expect, it } from 'vitest'
import { WorkflowJobListInputSchema } from '@foreman-code/contracts/job-verification'
import { localHumanPrincipal } from '../src/modules/access/localHuman.js'
import { jobCapabilities } from '../src/mcp/operator/tools/jobs.js'
import type { JobMcpContext } from '../src/mcp/operator/tools/jobs.js'

it('exposes workflow history with jobs:read capability and denies an ungranted caller', () => {
  const context = { principal: localHumanPrincipal, services: { jobs: {}, commands: {} } } as JobMcpContext
  const capability = jobCapabilities(context, { workspaceId: 'workspace-a', workflowId: 'workflow-a' })
    .find(item => item.name === 'job_workflow_list')
  expect(capability).toMatchObject({ actions: ['jobs:read'] })
  expect(capability?.detail).toContain('cursor paging')
  expect(jobCapabilities({ ...context, principal: { ...localHumanPrincipal, grants: [] } }, {}))
    .not.toContainEqual(expect.objectContaining({ name: 'job_workflow_list' }))
})
it('validates the workflow job history page input', () => {
  expect(WorkflowJobListInputSchema.parse({})).toEqual({ limit: 50 })
  expect(WorkflowJobListInputSchema.safeParse({ cursor: { createdAt: 'invalid', id: 'job-a' } }).success).toBe(false)
})
