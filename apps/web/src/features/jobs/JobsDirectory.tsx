import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isAutoJobSpec, type JobDefinition, type JobExecution } from '@graphql/contracts/jobs'
import type { JobQueueTicket } from '@graphql/contracts/job-admission'
import { Alert, Button, Card, CardBody, EmptyState, PageHeader } from '../../shared/ui/nocturne'
import { jobKeys, useJobDefinitions, useJobHistory, useJobQueue } from './query'
import { jobsClient } from './client'
import { jobAccessLost, jobError, jobReadRetry, jobWriteUncertain, processLabel } from './model'
import { JobLaunch } from './JobLaunch'
import { JobEditor } from './JobEditor'
import { JobQueueFacts } from './JobSpecFacts'
import './jobs.css'

export function JobsDirectory({ workspaceId, onSelectExecution }: { workspaceId: string; onSelectExecution: (id: string) => void }) {
  const definitions = useJobDefinitions(workspaceId)
  const history = useJobHistory(workspaceId)
  const queue = useJobQueue(workspaceId)
  const [editor, setEditor] = useState<{ definition?: JobDefinition } | null>(null)
  const [launch, setLaunch] = useState<JobDefinition | null>(null)
  return <div className="jobs-page"><PageHeader title="Jobs" description="Saved standalone build Jobs can wait for an authorized computer with capacity." actions={<Button variant="primary" onClick={() => setEditor({})}>New job</Button>} />
    <section aria-label="Saved jobs"><h2>Saved jobs</h2>{Boolean(definitions.error) && <Alert title="Saved jobs unavailable" tone="danger">{jobError(definitions.error)}</Alert>}
      {definitions.isPending && <p role="status">Loading jobs…</p>}
      {definitions.data?.length === 0 && <EmptyState title="No jobs saved" description="Choose a pinned source and runtime requirements. Auto selects a participating build computer at Start." />}
      <div className="jobs-list">{definitions.data?.map(definition => <Card key={definition.id}><CardBody><h3 className="job-wrap">{definition.name}</h3><p className="job-wrap">Revision {definition.revision} · {isAutoJobSpec(definition.spec) ? 'Auto' : definition.spec.target.labelAtAcceptance ?? definition.spec.target.hostRef.kind}</p><code className="job-command" tabIndex={0}>{JSON.stringify(definition.spec.argv)}</code><div className="job-toolbar"><Button onClick={() => setLaunch(definition)}>Review and start</Button><Button onClick={() => setEditor({ definition })}>Edit definition</Button></div></CardBody></Card>)}</div>
    </section>
    <section aria-label="Job queue"><h2>Job queue</h2>
      <p>All active requests and recent completed requests in this workspace.</p>
      <p>Workflow-node queuing and start estimates are unavailable.</p>
      {queue.isError && <Alert title="Queue unavailable" tone="danger">{jobError(queue.error)}</Alert>}
      {queue.isPending && <p role="status">Loading queue…</p>}
      {queue.data?.length === 0 && <p>No queued requests.</p>}
      <div className="jobs-list">{queue.data?.map(ticket => <JobQueueRow key={ticket.id}
        ticket={ticket} onSelectExecution={onSelectExecution} />)}</div>
      {queue.hasNextPage && !jobAccessLost(queue.error) && <Button disabled={queue.isFetchingNextPage}
        onClick={() => { void queue.fetchNextPage() }}>
        {queue.isFetchingNextPage ? 'Loading older requests…' : 'Load older requests'}
      </Button>}
    </section>
    <section aria-label="Execution history"><h2>Execution history</h2>{Boolean(history.error) && <Alert title="History unavailable" tone="danger">{jobError(history.error)}</Alert>}{history.isPending && <p role="status">Loading execution history…</p>}
      {history.data?.length === 0 && <p>No executions yet. Use “Review and start” on a saved job.</p>}
      <div className="jobs-list">{history.data?.map(execution => {
        const name = definitions.data?.find(item => item.id === execution.acceptedSpec.definitionId)?.name ?? execution.acceptedSpec.definitionId
        return <Card key={execution.id}><CardBody><Button className="job-wrap" aria-label={`Open result of ${name}, revision ${execution.acceptedSpec.definitionRevision}, ${processLabel(execution)}`} onClick={() => onSelectExecution(execution.id)}>{name} · revision {execution.acceptedSpec.definitionRevision}</Button>
          <p>{processLabel(execution)}{execution.transport !== 'connected' ? ` · computer ${execution.transport}` : ''}{execution.publication === 'failed' ? ' · artifacts failed' : ''} · accepted {execution.createdAt}</p>
          <p className="job-id"><code>{execution.id}</code></p></CardBody></Card>
      })}</div>
    </section>
    {editor && <JobEditor workspaceId={workspaceId} definition={editor.definition} onClose={() => setEditor(null)} />}
    {launch && <JobLaunch workspaceId={workspaceId} definition={launch} onClose={() => setLaunch(null)} onAccepted={execution => { setLaunch(null); onSelectExecution(execution.id) }} />}
  </div>
}

function JobQueueRow({ ticket, onSelectExecution }: {
  ticket: JobQueueTicket; onSelectExecution: (id: string) => void
}) {
  const cache = useQueryClient()
  // An unknown acknowledgment remains unresolved across a later denied retry.
  const [unresolved, setUnresolved] = useState(false)
  const cancel = useMutation({ mutationFn: (input: Parameters<typeof jobsClient.cancelQueued>[1]) =>
    jobsClient.cancelQueued(ticket.workspaceId, input), retry: false,
    onSuccess: updated => {
      setUnresolved(false)
      cache.setQueryData(jobKeys.queueTicket(ticket.workspaceId, ticket.id), updated)
      void cache.invalidateQueries({ queryKey: jobKeys.queue(ticket.workspaceId) })
      void cache.invalidateQueries({ queryKey: jobKeys.history(ticket.workspaceId) })
    },
    onError: error => {
      if (jobWriteUncertain(error)) setUnresolved(true)
      else if (!jobAccessLost(error)) setUnresolved(false)
      void cache.invalidateQueries({ queryKey: jobKeys.queue(ticket.workspaceId) })
    },
  })
  const cancellable = ['waiting', 'blocked', 'claimed'].includes(ticket.state) && !ticket.cancelRequestedAt
  const requestCancellation = () => {
    const input = unresolved && cancel.variables ? cancel.variables : {
      commandId: crypto.randomUUID(), ticketId: ticket.id, expectedRevision: ticket.revision,
    }
    cancel.mutate(input)
  }
  return <Card><CardBody>
    <h3 className="job-wrap">{ticket.definition.name} · revision {ticket.definition.revision}</h3>
    <JobQueueFacts ticket={ticket} />
    {cancel.error && <Alert title={unresolved ? 'Cancellation not confirmed' : 'Cancellation failed'} tone="warning">
      {jobError(cancel.error)}
      {unresolved && <p>Retry sends the same cancellation request and ticket revision.</p>}
    </Alert>}
    <div className="job-toolbar">
      {(cancellable || unresolved) && <Button variant="danger" loading={cancel.isPending}
        aria-label={`${unresolved ? 'Retry cancellation of' : 'Cancel queued'} ${ticket.definition.name}`}
        onClick={requestCancellation}>{unresolved ? 'Retry same cancellation request' : 'Cancel queued request'}</Button>}
      {ticket.state === 'accepted' && <Button onClick={() => onSelectExecution(ticket.executionId)}
        aria-label={`Open accepted execution of ${ticket.definition.name}`}>Open original execution</Button>}
    </div>
  </CardBody></Card>
}

export function JobRerun({ workspaceId, execution, onClose, onAccepted }: { workspaceId: string; execution: JobExecution; onClose: () => void; onAccepted: (execution: JobExecution) => void }) {
  const definition = useQuery({ queryKey: ['jobs', workspaceId, 'definition', execution.acceptedSpec.definitionId], queryFn: ({ signal }) => jobsClient.definition(workspaceId, execution.acceptedSpec.definitionId, { signal }), retry: jobReadRetry })
  if (definition.error) return <Alert title="Job status" tone="danger">{jobError(definition.error)} <Button onClick={onClose}>Close rerun review</Button></Alert>
  if (!definition.data) return <p role="status">Loading saved definition for rerun…</p>
  return <JobLaunch definition={definition.data} workspaceId={workspaceId} rerun={execution} onClose={onClose} onAccepted={onAccepted} />
}
