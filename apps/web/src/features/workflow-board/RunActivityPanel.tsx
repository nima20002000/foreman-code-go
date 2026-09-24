import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { WorkflowRunSummary } from '@graphql/contracts'
import { sameGraphScope } from '@graphql/contracts/wave25'
import { Alert, Button, EmptyState, Icon, LoadingState, StatusBadge } from '../../shared/ui/nocturne'
import { isActiveRun, runLabel, runTone, when } from './runFacts'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { useProtectedAccessError } from '../auth/useProtectedAccessError'
import { nextDraftApi } from '../graph/nextDraft/transport'
import { RunGraphView } from '../run-graph/RunGraphView'
import { readBoardRun, scopeForBoardRun } from './client'
import { useWorkflowBoard } from './context'

import { boardRunListKey } from './keys'

export function RunActivityPanel({ summaries }: { summaries: readonly WorkflowRunSummary[] }) {
  const board = useWorkflowBoard()!
  const { workspaceId, workflowId, run: selected, selectRun } = board
  const client = useQueryClient()
  const [error, setError] = useState<string>()
  const [reading, setReading] = useState<string>()
  const request = useRef(0)
  useEffect(() => () => { ++request.current }, [])
  const mounted = useRef({ workspaceId, workflowId })
  mounted.current = { workspaceId, workflowId }
  const runs = useInfiniteQuery({ queryKey: boardRunListKey(workspaceId, workflowId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => nextDraftApi.runs(workspaceId, workflowId, pageParam, { signal }),
    getNextPageParam: (page) => page.pageInfo.nextCursor,
    refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false,
  })
  const denied = useProtectedAccessError(runs)
  const listed = denied ? [] : runs.data?.pages.flatMap((page) => page.items) ?? []
  const active = summaries.filter((run) => run.workspaceId === workspaceId && run.workflowId === workflowId && isActiveRun(run))
  const inspect = async (runId: string) => {
    const ticket = ++request.current, generation = sessionGeneration()
    setReading(runId); setError(undefined)
    try {
      const result = await client.fetchQuery({ queryKey: ['workbench', 'board-run-discovery', generation, workspaceId, workflowId, runId],
        queryFn: ({ signal }) => readBoardRun(workspaceId, workflowId, runId, { signal }), staleTime: 0 })
      assertSession(generation)
      if (ticket !== request.current || mounted.current.workspaceId !== workspaceId || mounted.current.workflowId !== workflowId) return
      selectRun(scopeForBoardRun(result.run))
    } catch (reason) {
      if (ticket === request.current && generation === sessionGeneration()) setError(reason instanceof Error ? reason.message : 'The Run could not be opened.')
    } finally { if (ticket === request.current) setReading(undefined) }
  }
  const listedIds = new Set(listed.map((item) => item.id))
  return <div className="workflow-board-run-panel" aria-label="Run activity" data-testid="board-run-activity">
    {error ? <Alert tone="danger" live title="That run couldn’t be opened.">{error}</Alert> : null}
    {denied ? <Alert tone="warning" title="You don’t have access to this workflow’s runs." /> : runs.isError ? <Alert tone="danger" title="Runs couldn’t be loaded."
      action={<Button size="sm" onClick={() => void runs.refetch()}>Try again</Button>} /> : null}
    {runs.isPending && !denied ? <LoadingState label="Loading runs…" rows={3} /> : null}
    {!runs.isPending && !listed.length && !active.length && !denied && !runs.isError ? <EmptyState icon="history" title="No runs yet" description="Start a run from the board. It shows up here." /> : null}
    <ul className="board-run-list">
      {active.filter((run) => !listedIds.has(run.id)).map((run) => <li key={run.id}>
        <button type="button" className="board-run-row" disabled={reading === run.id} onClick={() => void inspect(run.id)} aria-label={`Inspect ${run.id}`}>
          <StatusBadge label={runLabel(run.executionState, run.outcome)} tone={runTone(run.executionState, run.outcome)} busy={run.executionState === 'running'} />
          <code>{run.id.slice(-8)}</code><span>{run.cleanupPending ? 'Cleaning up' : when(run.startedAt)}</span>
        </button></li>)}
      {listed.map((run) => {
        let scope: ReturnType<typeof scopeForBoardRun>
        try { scope = scopeForBoardRun(run) } catch {
          return <li key={run.id}><p className="next-draft-hint">Run {run.id.slice(-8)} can’t be shown on this board.</p></li>
        }
        const current = !!selected && sameGraphScope(scope, selected)
        return <li key={run.id}><button type="button" className="board-run-row" aria-pressed={current}
          aria-label={`Open Run ${run.id} · ${run.executionState} · ${run.outcome}`}
          onClick={() => { ++request.current; setReading(undefined); selectRun(current ? undefined : scope) }}>
          <StatusBadge label={runLabel(run.executionState, run.outcome)} tone={runTone(run.executionState, run.outcome)} busy={run.executionState === 'running'} />
          <code>{run.id.slice(-8)}</code><span>{when(run.startedAt)}</span>
        </button></li>
      })}
    </ul>
    <div className="n-actions">
      {runs.hasNextPage && !denied ? <Button size="sm" disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>Load more Runs</Button> : null}
      <Button size="sm" variant="ghost" leading={<Icon name="refresh" size={14} />} disabled={runs.isFetching} onClick={() => void runs.refetch()}>Refresh Runs</Button>
    </div>
    {selected ? <section className="board-run-detail" aria-label="Selected run">
      <header><h3>Run {selected.runId.slice(-8)}</h3>
        <Button size="sm" variant="ghost" onClick={() => { ++request.current; setReading(undefined); selectRun() }}>Clear Run selection</Button></header>
      <RunGraphView scope={selected} embedded />
    </section> : null}
  </div>
}

