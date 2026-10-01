import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { JobDefinition, JobExecution, JobStart } from '@graphql/contracts/jobs'
import { Alert, Button, Dialog } from '../../shared/ui/nocturne'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { jobsClient } from './client'
import { jobError, jobReadRetry, jobWriteUncertain } from './model'
import { jobKeys } from './query'
import { JobSpecFacts } from './JobSpecFacts'

export function JobLaunch({ definition, workspaceId, rerun, onClose, onAccepted }: { definition: JobDefinition; workspaceId: string; rerun?: JobExecution; onClose: () => void; onAccepted: (execution: JobExecution) => void }) {
  const cache = useQueryClient()
  const validation = useQuery({ queryKey: ['jobs', workspaceId, 'validation', definition.id, definition.revision], queryFn: () => jobsClient.validate(workspaceId, definition.spec), retry: jobReadRetry, staleTime: 0 })
  const start = useMutation({ mutationKey: ['jobs', workspaceId, 'start', definition.id], gcTime: Infinity, retry: false,
    mutationFn: (input: JobStart) => jobsClient.start(workspaceId, input),
    onSuccess: execution => { cache.setQueryData(jobKeys.execution(workspaceId, execution.id), execution); void cache.invalidateQueries({ queryKey: jobKeys.history(workspaceId) }); onAccepted(execution) },
  })
  const uncertain = jobWriteUncertain(start.error)
  const submit = () => start.mutateAsync(start.variables ?? { commandId: crypto.randomUUID(), definitionId: definition.id, expectedRevision: definition.revision })
  const close = useUnsavedChanges({ label: 'job launch', scope: 'surface', dirty: false, busy: start.isPending, uncertain, saveDisabled: !start.variables && !validation.data?.valid,
    save: submit, discard: onClose, ...(start.error ? { error: jobError(start.error) } : {}) })
  return <Dialog open title={rerun ? 'Review rerun' : 'Review job launch'} size="lg" busy={start.isPending} dismissible={!uncertain} onOpenChange={open => { if (!open) void close(onClose) }}
    description={`Launch saved revision ${definition.revision} of ${definition.name}.`}
    footer={<><Button disabled={start.isPending || uncertain} onClick={() => void close(onClose)}>Back</Button><Button variant="primary" loading={start.isPending} disabled={!start.variables && (!validation.data?.valid || validation.isFetching)} onClick={() => { void submit().catch(() => undefined) }}>{start.variables ? 'Retry same start request' : rerun ? 'Rerun as new execution' : 'Start job'}</Button></>}>
    {validation.isPending && <p role="status">Checking computer, source and isolation readiness…</p>}
    {Boolean(validation.error) && <Alert title="Readiness check failed" tone="danger">{jobError(validation.error)}</Alert>}
    {validation.data && <Alert title={validation.data.valid ? 'Ready to start' : 'Not ready to start'} tone={validation.data.valid ? 'success' : 'warning'}>{validation.data.valid ? 'Resource, source and policy validation passed. Nothing is installed or signed in.' : validation.data.reasons.join(' · ')}</Alert>}
    {start.error && <Alert title={uncertain ? 'Start not confirmed' : 'Start failed'} tone="warning">{uncertain ? 'Start acknowledgment is unknown. Retrying sends the same commandId and saved revision; it does not request another execution.' : jobError(start.error)}{start.variables && <> Request <code>{start.variables.commandId}</code></>}</Alert>}
    {rerun && <Alert title="New execution" tone="neutral">The old result stays pinned to revision {rerun.acceptedSpec.definitionRevision}. {definition.versionId === rerun.acceptedSpec.definitionVersionId ? 'The saved specification is unchanged.' : 'The saved source or specification has changed; review it below.'}</Alert>}
    <JobSpecFacts spec={definition.spec} />
  </Dialog>
}
