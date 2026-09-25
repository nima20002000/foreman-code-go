import { useQuery } from '@tanstack/react-query'
import { Alert, Badge, Button } from '../../shared/ui/nocturne'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { repeatClient, type RepeatClient, type RepeatRunScope } from './client'
import './repeats.css'

const reasonLabel = (reason: 'repeat' | 'early_exit' | 'limit_exit') => reason === 'repeat' ? 'Repeat decided'
  : reason === 'early_exit' ? 'Early exit' : 'Limit exit'

const repeatRunKey = (scope: RepeatRunScope) =>
  ['workbench', 'repeat-run', sessionGeneration(), scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId] as const

export function RepeatStatus({ scope, client = repeatClient }: { scope: RepeatRunScope; client?: RepeatClient }) {
  const query = useQuery({
    queryKey: repeatRunKey(scope),
    queryFn: ({ signal }) => client.run(scope, { signal }),
    staleTime: 1_000,
    refetchInterval: (state) => state.state.data?.complete ? false : 1_500,
    refetchOnWindowFocus: true,
    retry: false,
  })
  if (query.isPending && !query.data) return <section className="repeat-status" role="status">Loading repeat occurrences…</section>
  if (query.isError && !query.data) return <section className="repeat-status" role="alert">
    <Alert tone="warning" title="Repeat state is unavailable.">No occurrence state was guessed from the board or elapsed time.</Alert>
    <Button size="sm" onClick={() => void query.refetch()}>Retry</Button>
  </section>
  const data = query.data
  if (!data) return null
  return <section className="repeat-status" aria-label="Repeat occurrences">
    <header><div><h3>Occurrences</h3><p>Run <code>{scope.runId.slice(-8)}</code> · version <code>{scope.workflowVersionId.slice(-8)}</code></p></div>
      <Badge tone={data.complete ? 'neutral' : 'warning'} dot>{data.complete ? 'Recorded' : 'Live'}</Badge></header>
    {data.stale || data.resetRequired ? <Alert tone="warning" title="Occurrence feed needs a fresh read."
      action={<Button size="sm" onClick={() => void query.refetch()}>Refresh</Button>}>Displayed facts stay pinned to this Run and version; they are not replaced with current workflow settings.</Alert> : null}
    {!data.occurrences.length ? <p className="repeat-empty">No durable repeat occurrence has been recorded for this Run.</p> : <ol className="repeat-occurrences">
      {data.occurrences.map((item) => {
        const identity = item.occurrence.identity
        return <li key={identity.occurrenceId} className="repeat-occurrence">
          <div className="repeat-occurrence-line"><strong>{identity.blockId} · occurrence {identity.occurrenceIndex}</strong><Badge tone="neutral">{item.status}</Badge></div>
          <dl><div><dt>Occurrence ID</dt><dd><code>{identity.occurrenceId}</code></dd></div>
            <div><dt>Input binding</dt><dd><code>{item.occurrence.input.bindingId}</code></dd></div>
            {item.technicalAttempt ? <div><dt>Technical attempt</dt><dd>{item.technicalAttempt} <span className="repeat-muted">(same business occurrence)</span></dd></div> : null}
            {item.decision ? <><div><dt>Decision</dt><dd>{reasonLabel(item.decision.reason)} · <code>{item.decision.outcome}</code></dd></div>
              {item.decision.reason === 'repeat' ? <div><dt>Next occurrence</dt><dd>{item.decision.target.kind === 'next_occurrence'
                ? `Requested occurrence ${item.decision.target.occurrenceIndex}; running state requires its own durable occurrence/execution fact.` : 'Not recorded'}</dd></div> : null}</> : null}
          </dl>
        </li>
      })}
    </ol>}
  </section>
}
