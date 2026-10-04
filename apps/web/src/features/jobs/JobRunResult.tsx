import { useQuery } from '@tanstack/react-query'
import type { JobWorkflowAdmissionReference } from '@foreman-code/contracts/job-workflow'
import { Alert } from '../../shared/ui/nocturne'
import { jobsClient } from './client'
import { jobError, jobReadRetry } from './model'
import { JobResult } from './JobResult'

/** Resolve the persisted Run/job relationship; a node execution ID is never assumed to be a job ID. */
export function JobRunResult({ reference, definitionVersionId }: { reference: JobWorkflowAdmissionReference; definitionVersionId: string }) {
  const query = useQuery({ queryKey: ['jobs', 'workflow-execution', reference],
    queryFn: ({ signal }) => jobsClient.workflowExecution(reference, { signal }), retry: jobReadRetry,
    gcTime: 0, placeholderData: () => undefined,
  })
  if (query.isError) return <Alert title="Run job result unavailable" tone="warning">{jobError(query.error)}</Alert>
  if (!query.data) return <p role="status">Reading the job accepted for this exact Run execution…</p>
  return <JobResult key={query.data.jobExecutionId} workspaceId={reference.workspaceId} executionId={query.data.jobExecutionId}
    expectedWorkflow={query.data} expectedDefinitionVersionId={definitionVersionId} />
}
