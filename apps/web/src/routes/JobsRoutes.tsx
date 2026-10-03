import { useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import type { JobExecution } from '@graphql/contracts/jobs'
import { WorkspaceShell } from '../shared/ui/WorkspaceShell'
import { JobsDirectory, JobRerun } from '../features/jobs/JobsDirectory'
import { JobResult } from '../features/jobs/JobResult'
import '../features/jobs/jobs.css'

export function JobsRouteEntry() {
  const params = useParams({ strict: false })
  const workspaceId = 'workspaceId' in params ? String(params.workspaceId) : ''
  const navigate = useNavigate()
  const select = (id: string) => { void navigate({ to: `/workspaces/${encodeURIComponent(workspaceId)}/jobs/${encodeURIComponent(id)}` }) }
  return <WorkspaceShell workspaceId={workspaceId} activeSection="jobs" slots={{ main: <JobsDirectory key={workspaceId} workspaceId={workspaceId} onSelectExecution={select} /> }} />
}
export function JobExecutionRouteEntry() {
  const params = useParams({ strict: false })
  const workspaceId = 'workspaceId' in params ? String(params.workspaceId) : ''
  const executionId = 'jobExecutionId' in params ? String(params.jobExecutionId) : ''
  const [rerun, setRerun] = useState<JobExecution | null>(null)
  const navigate = useNavigate()
  return <WorkspaceShell workspaceId={workspaceId} activeSection="jobs" slots={{ main: <>
    <JobResult key={`${workspaceId}:${executionId}`} workspaceId={workspaceId} executionId={executionId} onRerun={setRerun} />
    {rerun?.id === executionId && rerun.workspaceId === workspaceId && <JobRerun workspaceId={workspaceId} execution={rerun} onClose={() => setRerun(null)} onAccepted={execution => { setRerun(null); void navigate({ to: `/workspaces/${encodeURIComponent(workspaceId)}/jobs/${encodeURIComponent(execution.id)}` }) }} />}
  </> }} />
}
