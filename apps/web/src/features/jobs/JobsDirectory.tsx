import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { JobDefinition, JobExecution } from '@graphql/contracts/jobs'
import { Alert, Button, Card, CardBody, EmptyState, PageHeader } from '../../shared/ui/nocturne'
import { useJobDefinitions, useJobHistory } from './query'
import { jobsClient } from './client'
import { jobError, jobReadRetry, processLabel } from './model'
import { JobLaunch } from './JobLaunch'
import { JobEditor } from './JobEditor'
import './jobs.css'

export function JobsDirectory({ workspaceId, onSelectExecution }: { workspaceId: string; onSelectExecution: (id: string) => void }) {
  const definitions = useJobDefinitions(workspaceId)
  const history = useJobHistory(workspaceId)
  const [editor, setEditor] = useState<{ definition?: JobDefinition } | null>(null)
  const [launch, setLaunch] = useState<JobDefinition | null>(null)
  return <div className="jobs-page"><PageHeader title="Jobs" description="Versioned build and test commands on an authorized computer." actions={<Button variant="primary" onClick={() => setEditor({})}>New job</Button>} />
    <section aria-label="Saved jobs"><h2>Saved jobs</h2>{Boolean(definitions.error) && <Alert title="Saved jobs unavailable" tone="danger">{jobError(definitions.error)}</Alert>}
      {definitions.isPending && <p role="status">Loading jobs…</p>}
      {definitions.data?.length === 0 && <EmptyState title="No jobs saved" description="Choose a qualified computer, pinned source and isolation policy to save your first command." />}
      <div className="jobs-list">{definitions.data?.map(definition => <Card key={definition.id}><CardBody><h3 className="job-wrap">{definition.name}</h3><p className="job-wrap">Revision {definition.revision} · {definition.spec.target.labelAtAcceptance ?? definition.spec.target.hostRef.kind}</p><code className="job-command" tabIndex={0}>{JSON.stringify(definition.spec.argv)}</code><div className="job-toolbar"><Button onClick={() => setLaunch(definition)}>Review and start</Button><Button onClick={() => setEditor({ definition })}>Edit definition</Button></div></CardBody></Card>)}</div>
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

export function JobRerun({ workspaceId, execution, onClose, onAccepted }: { workspaceId: string; execution: JobExecution; onClose: () => void; onAccepted: (execution: JobExecution) => void }) {
  const definition = useQuery({ queryKey: ['jobs', workspaceId, 'definition', execution.acceptedSpec.definitionId], queryFn: ({ signal }) => jobsClient.definition(workspaceId, execution.acceptedSpec.definitionId, { signal }), retry: jobReadRetry })
  if (definition.error) return <Alert title="Job status" tone="danger">{jobError(definition.error)} <Button onClick={onClose}>Close rerun review</Button></Alert>
  if (!definition.data) return <p role="status">Loading saved definition for rerun…</p>
  return <JobLaunch definition={definition.data} workspaceId={workspaceId} rerun={execution} onClose={onClose} onAccepted={onAccepted} />
}
