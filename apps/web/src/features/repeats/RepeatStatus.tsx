import { useInfiniteQuery } from '@tanstack/react-query'
import { Alert, Badge, Button } from '../../shared/ui/nocturne'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { RepeatClientError, repeatClient, type RepeatClient, type RepeatRunScope } from './client'
import './repeats.css'

const reasonLabel = (reason: 'repeat' | 'early_exit' | 'limit_exit') => reason === 'repeat' ? 'Repeat decided'
  : reason === 'early_exit' ? 'Early exit' : 'Limit exit'

const repeatRunKey = (scope: RepeatRunScope) =>
  ['workbench', 'repeat-run', sessionGeneration(), scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId] as const

const renderJson = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value)

export function RepeatStatus({ scope, live = false, client = repeatClient }: { scope: RepeatRunScope; live?: boolean; client?: RepeatClient }) {
  const query = useInfiniteQuery({
    queryKey: repeatRunKey(scope),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) => {
      const page = await client.run({ workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId,
        ...(pageParam ? { cursor: pageParam } : {}), limit: 100, includeResultData: true }, { signal })
      if (page.items.some((item) => item.occurrence.identity.scope.workflowVersionId !== scope.workflowVersionId
        || item.occurrence.identity.scope.executionSemanticsVersion !== 3)) {
        throw new RepeatClientError({ code: 'INVALID_RESPONSE', message: 'Repeat history did not match the selected immutable Run/version.' })
      }
      return page
    },
    getNextPageParam: (page) => page.pageInfo.nextCursor ?? undefined,
    staleTime: live ? 1_000 : Infinity,
    refetchInterval: live ? 1_500 : false,
    refetchOnWindowFocus: live,
    retry: false,
  })
  if (query.isPending && !query.data) return <section className="repeat-status" role="status">Loading repeat occurrences…</section>
  if (query.isError && !query.data) return <section className="repeat-status" role="alert">
    <Alert tone="warning" title="Repeat state is unavailable.">No occurrence, retry, early-exit, or limit state was guessed from timing.</Alert>
    <Button size="sm" onClick={() => void query.refetch()}>Retry</Button>
  </section>
  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  return <section className="repeat-status" aria-label="Repeat occurrences">
    <header><div><h3>Business occurrences</h3><p>Run <code>{scope.runId.slice(-8)}</code> · version <code>{scope.workflowVersionId.slice(-8)}</code></p></div>
      <Badge tone={live ? 'warning' : 'neutral'} dot>{live ? 'Current Run' : 'Historical Run'}</Badge></header>
    <p className="repeat-muted">Occurrence numbers count business repetition. A technical attempt is separate and never consumes the repeat cap.</p>
    {query.isError ? <Alert tone="warning" title="A refresh failed.">Already loaded durable facts stay pinned to this Run/version.</Alert> : null}
    {!items.length ? <p className="repeat-empty">No durable repeat occurrence has been recorded for this Run.</p> : <ol className="repeat-occurrences">
      {items.map((item) => {
        const identity = item.occurrence.identity
        const decision = item.decision
        const detail = decision && 'resultData' in decision ? decision.resultData : undefined
        return <li key={identity.occurrenceId} className="repeat-occurrence">
          <div className="repeat-occurrence-line"><strong>{identity.blockId} · business occurrence {identity.occurrenceIndex}</strong>
            <Badge tone={decision?.reason === 'limit_exit' ? 'warning' : 'neutral'}>{decision ? reasonLabel(decision.reason) : 'Occurrence recorded'}</Badge></div>
          <dl><div><dt>Occurrence ID</dt><dd><code>{identity.occurrenceId}</code></dd></div>
            <div><dt>Input binding</dt><dd><code>{item.occurrence.input.bindingId}</code></dd></div>
            {decision ? <><div><dt>Exit technical attempt</dt><dd>{decision.exitExecution.attempt} <span className="repeat-muted">(same business occurrence)</span></dd></div>
              <div><dt>Outcome</dt><dd><code>{decision.outcome}</code> · {reasonLabel(decision.reason)}</dd></div>
              {decision.reason === 'repeat' ? <div><dt>Next occurrence</dt><dd>{decision.target.kind === 'next_occurrence'
                ? `Requested occurrence ${decision.target.occurrenceIndex}. It is not shown as running until its own durable occurrence/execution facts exist.` : 'Not recorded'}</dd></div> : null}
              {detail ? <><div><dt>Latest deliverable</dt><dd className="repeat-result"><code>{renderJson(detail.latestDeliverable)}</code></dd></div>
                <div><dt>Remaining findings</dt><dd>{detail.remainingFindings.length ? <ul className="repeat-findings">{detail.remainingFindings.map((finding, index) => <li key={index}><code>{renderJson(finding)}</code></li>)}</ul> : 'None recorded'}</dd></div></> : null}
            </> : <div><dt>Decision</dt><dd>Not recorded yet. Run activity remains authoritative for execution lifecycle.</dd></div>}
          </dl>
        </li>
      })}
    </ol>}
    {query.hasNextPage ? <Button size="sm" variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more occurrence facts</Button> : null}
  </section>
}
