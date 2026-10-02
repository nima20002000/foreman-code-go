import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { JobDefinition, JobExecution, JobStart } from '@graphql/contracts/jobs'
import { Alert, Button, Dialog } from '../../shared/ui/nocturne'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { jobsClient } from './client'
import { jobAccessLost, jobError, jobReadRetry, jobWriteUncertain } from './model'
import { jobKeys } from './query'
import { JobSpecFacts } from './JobSpecFacts'

export function JobLaunch({ definition, workspaceId, rerun, onClose, onAccepted }: { definition: JobDefinition; workspaceId: string; rerun?: JobExecution; onClose: () => void; onAccepted: (execution: JobExecution) => void }) {
  const cache = useQueryClient()
  const validation = useQuery({ queryKey: ['jobs', workspaceId, 'validation', definition.id, definition.revision], queryFn: () => jobsClient.validate(workspaceId, definition.spec), retry: jobReadRetry, staleTime: 0 })
  const readiness = validation.isSuccess && !validation.isFetching ? validation.data : undefined
  const [unresolved, setUnresolved] = useState(false)
  const start = useMutation({ mutationKey: ['jobs', workspaceId, 'start', definition.id], gcTime: Infinity, retry: false,
    mutationFn: (input: JobStart) => jobsClient.start(workspaceId, input),
    onSuccess: execution => { cache.setQueryData(jobKeys.execution(workspaceId, execution.id), execution); void cache.invalidateQueries({ queryKey: jobKeys.history(workspaceId) }); onAccepted(execution); setUnresolved(false) },
    onError: error => { if (jobWriteUncertain(error)) setUnresolved(true); else if (!jobAccessLost(error)) setUnresolved(false) },
  })
  const uncertain = unresolved || jobWriteUncertain(start.error)
  const submit = () => start.mutateAsync(start.variables ?? { commandId: crypto.randomUUID(), definitionId: definition.id, expectedRevision: definition.revision })
  const close = useUnsavedChanges({ label: 'job launch', scope: 'surface', dirty: false, busy: start.isPending, uncertain, saveDisabled: !start.variables && !readiness?.valid,
    save: submit, discard: onClose, ...(start.error ? { error: jobError(start.error) } : {}) })
  return <Dialog open className="job-dialog" title={rerun ? 'Review rerun' : 'Review job launch'} size="lg" busy={start.isPending} dismissible={!uncertain} onOpenChange={open => { if (!open) void close(onClose) }}
    description={`Launch saved revision ${definition.revision} of ${definition.name}.`}
    footer={<><Button disabled={start.isPending || uncertain} onClick={() => void close(onClose)}>Back</Button><Button variant="primary" loading={start.isPending} disabled={!start.variables && !readiness?.valid} onClick={() => { void submit().catch(() => undefined) }}>{start.variables ? 'Retry same start request' : rerun ? 'Rerun as new execution' : 'Start job'}</Button></>}>
    {(validation.isPending || validation.isFetching) && <p role="status">Checking computer, source and isolation readiness…</p>}
    {validation.isError && <Alert title="Readiness check failed" tone="danger">{jobError(validation.error)}<Button disabled={validation.isFetching} onClick={() => { void validation.refetch() }}>Retry readiness check</Button></Alert>}
    {readiness && <Alert title={readiness.valid ? 'Ready to start' : 'Not ready to start'} tone={readiness.valid ? 'success' : 'warning'}>{readiness.valid ? 'Resource, source and policy validation passed. Nothing is installed or signed in.' : readiness.reasons.join(' · ')}</Alert>}
    {start.error && <Alert title={uncertain ? 'Start not confirmed' : 'Start failed'} tone="warning">{uncertain ? 'Start acknowledgment is unknown. Retrying sends the same commandId and saved revision; it does not request another execution.' : jobError(start.error)}{start.variables && <> Request <code>{start.variables.commandId}</code></>}</Alert>}
    {rerun && <Alert title="New execution" tone="neutral">The old result stays pinned to revision {rerun.acceptedSpec.definitionRevision}. {definition.versionId === rerun.acceptedSpec.definitionVersionId ? 'The saved specification is unchanged.' : 'The saved source or specification has changed; review it below.'}</Alert>}
    <JobSpecFacts spec={definition.spec} />
  </Dialog>
}
