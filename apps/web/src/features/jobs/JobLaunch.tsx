import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isAutoJobSpec, type JobDefinition, type JobExecution } from '@foreman-code/contracts/jobs'
import type { JobPlacementIntent } from '@foreman-code/contracts/job-admission'
import { Alert, Button, Dialog, Select } from '../../shared/ui/nocturne'
import { ApiError } from '../../shared/api/client'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { jobsClient } from './client'
import { jobAccessLost, jobError, jobReadRetry, jobWriteUncertain } from './model'
import { jobKeys, useJobQueueTicket } from './query'
import { JobQueueFacts, JobSpecFacts } from './JobSpecFacts'

export function JobLaunch({ definition, workspaceId, rerun, onClose, onAccepted }: {
  definition: JobDefinition; workspaceId: string; rerun?: JobExecution;
  onClose: () => void; onAccepted: (execution: JobExecution) => void
}) {
  const cache = useQueryClient()
  const [placementChoice, setPlacementChoice] = useState('saved')
  const choices = useQuery({ queryKey: ['jobs', workspaceId, 'choices'],
    queryFn: ({ signal }) => jobsClient.choices(workspaceId, { signal }), retry: jobReadRetry })
  const validation = useQuery({ queryKey: ['jobs', workspaceId, 'validation', definition.id, definition.revision],
    queryFn: () => jobsClient.validate(workspaceId, definition.spec), retry: jobReadRetry, staleTime: 0 })
  const readiness = validation.isSuccess && !validation.isFetching ? validation.data : undefined
  const readyLabel = isAutoJobSpec(definition.spec) ? 'Configuration valid' : 'Ready to start'
  const readyMessage = 'Configuration validation passed. The request is saved before preparation and waits for an eligible computer with capacity.'
  const [unresolved, setUnresolved] = useState(false)
  const start = useMutation({ mutationKey: ['jobs', workspaceId, 'start', definition.id], gcTime: Infinity, retry: false,
    mutationFn: (input: Parameters<typeof jobsClient.start>[1]) => jobsClient.start(workspaceId, input),
    onSuccess: admission => {
      if (admission.kind === 'pending-admission') {
        cache.setQueryData(jobKeys.queueTicket(workspaceId, admission.ticket.id), admission.ticket)
      }
      void cache.invalidateQueries({ queryKey: jobKeys.queue(workspaceId) })
      void cache.invalidateQueries({ queryKey: jobKeys.history(workspaceId) })
      setUnresolved(false)
    },
    onError: error => {
      if (jobWriteUncertain(error)) setUnresolved(true)
      else if (!jobAccessLost(error)) setUnresolved(false)
    },
  })
  const admission = start.data
  const retained = admission?.kind === 'retained-execution' ? admission.execution : undefined
  let ticketId = ''
  if (admission?.kind === 'pending-admission') ticketId = admission.ticket.id
  if (admission?.kind === 'accepted') ticketId = admission.ticketId
  const queue = useJobQueueTicket(workspaceId, ticketId)
  const ticket = queue.data
  const ticketMatches = ticket && ticket.commandId === start.variables?.commandId
    && ticket.definition.id === definition.id && ticket.definition.revision === definition.revision
    && ticket.definition.versionId === definition.versionId
    && (admission?.kind !== 'accepted' || ticket.executionId === admission.executionId)
  let executionId = retained?.id ?? ''
  if (ticket && ticketMatches && ticket.state === 'accepted') executionId = ticket.executionId
  const result = useQuery({ queryKey: jobKeys.execution(workspaceId, executionId), enabled: Boolean(executionId),
    queryFn: ({ signal }) => jobsClient.execution(workspaceId, executionId, { signal }),
    select: execution => {
      if (execution.acceptedSpec.definitionId !== definition.id
        || execution.acceptedSpec.definitionRevision !== definition.revision
        || execution.acceptedSpec.definitionVersionId !== definition.versionId
        || execution.attemptId !== (ticket ?? retained)?.attemptId
        || execution.operationId !== (ticket ?? retained)?.operationId) {
        throw new ApiError({ code: 'JOB_SELECTION_MISMATCH', message: 'The execution belongs to another start request.' }, 409)
      }
      return execution
    }, retry: jobReadRetry })
  useEffect(() => {
    if (result.isSuccess && executionId) onAccepted(result.data)
  }, [result.isSuccess, result.data, executionId, onAccepted])
  const uncertain = unresolved || jobWriteUncertain(start.error)
  const placementUnavailable = !['saved', 'auto'].includes(placementChoice)
    && (choices.isError || choices.isFetching || !choices.data?.targets.some(choice => choice.id === placementChoice))
  let startLabel = rerun ? 'Rerun as new execution' : 'Start job'
  if (start.variables) startLabel = 'Retry same start request'
  const input = (): Parameters<typeof jobsClient.start>[1] => {
    if (start.variables) return start.variables
    let placementOverride: JobPlacementIntent | undefined
    if (placementChoice === 'auto') placementOverride = { kind: 'auto' }
    else if (placementChoice !== 'saved') {
      const target = choices.data?.targets.find(choice => choice.id === placementChoice)?.target
      if (!target) throw new Error('Refresh computer choices before starting this Job.')
      placementOverride = { kind: 'explicit', target }
    }
    return { commandId: crypto.randomUUID(), definitionId: definition.id, expectedRevision: definition.revision,
      ...(placementOverride ? { placementOverride } : {}) }
  }
  const submit = () => start.mutateAsync(input())
  const close = useUnsavedChanges({ label: 'job launch', scope: 'surface', dirty: false, busy: start.isPending,
    uncertain, saveDisabled: !start.variables && (!readiness || placementUnavailable), save: submit, discard: onClose,
    ...(start.error ? { error: jobError(start.error) } : {}) })
  return <Dialog open className="job-dialog" title={rerun ? 'Review rerun' : 'Review job launch'} size="lg"
    busy={start.isPending} dismissible={!uncertain} onOpenChange={open => { if (!open) void close(onClose) }}
    description={`Launch saved revision ${definition.revision} of ${definition.name}.`}
    footer={<>
      <Button disabled={start.isPending || uncertain} onClick={() => void close(onClose)}>{admission ? 'Close' : 'Back'}</Button>
      {!admission && <Button variant="primary" loading={start.isPending} disabled={!start.variables && (!readiness || placementUnavailable)}
        onClick={() => start.mutate(input())}>
        {startLabel}
      </Button>}
    </>}>
    {!admission && <>
      <Select label="Start placement" value={placementChoice} disabled={Boolean(start.variables) || start.isPending}
        onChange={event => setPlacementChoice(event.target.value)} options={[
          { value: 'saved', label: 'Use saved placement' },
          { value: 'auto', label: 'Auto: eligible computer with capacity' },
          ...(choices.data?.targets.map(choice => ({ value: choice.id, label: choice.label })) ?? []),
        ]} />
      {choices.isError && <Alert title="Computer choices unavailable" tone="warning">{jobError(choices.error)}
        <Button onClick={() => { void choices.refetch() }}>Refresh computer choices</Button>
      </Alert>}
      {(validation.isPending || validation.isFetching) && <p role="status">Checking computer, source and isolation readiness…</p>}
      {validation.isError && <Alert title="Readiness check failed" tone="danger">{jobError(validation.error)}
        <Button disabled={validation.isFetching} onClick={() => { void validation.refetch() }}>Retry readiness check</Button>
      </Alert>}
      {readiness && <Alert title={readiness.valid ? readyLabel : 'Readiness issues; request can queue'}
        tone={readiness.valid ? 'success' : 'warning'}>
        {readiness.valid ? readyMessage : readiness.reasons.join(' · ')}
        {!readiness.valid && <p>The queue rechecks these requirements before launch. Requests may be blocked or rejected.</p>}
      </Alert>}
    </>}
    {start.error && <Alert title={uncertain ? 'Start not confirmed' : 'Start failed'} tone="warning">
      {uncertain ? 'Start acknowledgment is unknown. Retrying sends the same commandId and saved revision; it does not request another execution.' : jobError(start.error)}
      {start.variables && <> Request <code>{start.variables.commandId}</code></>}
    </Alert>}
    {ticketId && !ticket && !queue.isError && <p role="status">Request saved. Loading queue status…</p>}
    {queue.isError && <Alert title="Queue status unavailable" tone="warning">{jobError(queue.error)}
      <Button onClick={() => { void queue.refetch() }}>Refresh queue status</Button>
    </Alert>}
    {ticket && !ticketMatches && <Alert title="Queue request mismatch" tone="danger">
      The response belongs to another saved job or start request.
    </Alert>}
    {ticket && ticketMatches && <JobQueueFacts ticket={ticket} />}
    {executionId && !result.data && !result.isError && <p role="status">Accepted. Loading the original execution…</p>}
    {result.isError && <Alert title="Accepted result unavailable" tone="warning">{jobError(result.error)}
      <Button onClick={() => { void result.refetch() }}>Retry result read</Button>
    </Alert>}
    {rerun && <Alert title="New execution" tone="neutral">
      The old result stays pinned to revision {rerun.acceptedSpec.definitionRevision}.
      {definition.versionId === rerun.acceptedSpec.definitionVersionId
        ? 'The saved specification is unchanged.' : 'The saved source or specification has changed; review it below.'}
    </Alert>}
    <p>Start placement applies to this request. The saved definition stays unchanged. Workflow-node queuing and start estimates are unavailable.</p>
    <JobSpecFacts spec={definition.spec} />
  </Dialog>
}
