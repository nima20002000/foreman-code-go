import { RunActions } from './actions'
import { useEffect, useRef } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { WorkflowRunSummary } from '@graphql/contracts'
import { sameCanonicalGraphScope } from '@graphql/contracts/wave25'
import { Alert, Button, EmptyState, Icon, LoadingState, StatusBadge } from '../../shared/ui/nocturne'
import { isActiveRun, runLabel, runTone, when } from './runFacts'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { useProtectedAccessError } from '../auth/useProtectedAccessError'
import { CurrentRunDetails } from './RunDetails'
import { readBoardRun, readBoardRuns, scopeForBoardRun } from './client'
import { useWorkflowBoard } from './context'

import { boardRunListKey } from './keys'
import { refreshFirstInspectionPage } from './inspect/queries'

export function RunActivityPanel({ summaries }: { summaries: readonly WorkflowRunSummary[] }) {
  const board = useWorkflowBoard()!
  const { workspaceId, workflowId, run: selected, selectRun } = board
  const client = useQueryClient()
  const request = useRef(0)
  const mounted = useRef({ workspaceId, workflowId })
  mounted.current = { workspaceId, workflowId }
  const discovery = useMutation({ retry: false,
    mutationFn: async ({ runId, generation }: { runId: string; generation: number; ticket: number }) => {
      const result = await client.fetchQuery({ queryKey: ['workbench', 'board-run-discovery', generation, workspaceId, workflowId, runId],
        queryFn: ({ signal }) => readBoardRun(workspaceId, workflowId, runId, { signal }), staleTime: 0 })
      assertSession(generation)
      return scopeForBoardRun(result.run)
    },
    onSuccess: (scope, variables) => {
      if (variables.ticket !== request.current || variables.generation !== sessionGeneration()
        || mounted.current.workspaceId !== workspaceId || mounted.current.workflowId !== workflowId) return
      selectRun(scope)
    },
  })
  const resetDiscovery = discovery.reset
  // URL/back navigation invalidates discovery, without mirroring request state.
  useEffect(() => { ++request.current; resetDiscovery() },
    [selected?.runId, selected?.workflowVersionId, selected?.executionSemanticsVersion, resetDiscovery])
  useEffect(() => () => { ++request.current }, [])
  const latestDiscovery = discovery.variables?.ticket === request.current
  const reading = latestDiscovery && discovery.isPending ? discovery.variables?.runId : undefined
  const error = latestDiscovery && discovery.isError ? discovery.error.message : undefined
  const runs = useInfiniteQuery({ queryKey: boardRunListKey(workspaceId, workflowId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => readBoardRuns(workspaceId, workflowId, pageParam, { signal }),
    getNextPageParam: (page, _pages, _param, params) => page.pageInfo.nextCursor && !params.includes(page.pageInfo.nextCursor) ? page.pageInfo.nextCursor : undefined,
    maxPages: 5, staleTime: Infinity, refetchOnMount: 'always',
    refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false,
  })
  const denied = useProtectedAccessError(runs)
  const listed = denied || runs.isError ? [] : [...new Map(runs.data?.pages.flatMap((page) => page.items.map((run) => [run.id, run] as const)) ?? []).values()]
  const fresh = denied ? [] : summaries.filter((run) => run.workspaceId === workspaceId && run.workflowId === workflowId)
  const freshById = new Map(fresh.map((run) => [run.id, run]))
  const activeIds = JSON.stringify([workspaceId, workflowId, fresh.filter(isActiveRun).map((run) => run.id).sort()])
  const previousActiveIds = useRef(activeIds)
  useEffect(() => {
    if (previousActiveIds.current === activeIds) return
    previousActiveIds.current = activeIds
    if (!denied) void client.invalidateQueries({ queryKey: boardRunListKey(workspaceId, workflowId), exact: true })
  }, [activeIds, client, denied, workspaceId, workflowId])
  const inspect = (runId: string) => discovery.mutate({ runId, generation: sessionGeneration(), ticket: ++request.current })
  const listedIds = new Set(listed.map((item) => item.id))
  return <div className="workflow-board-run-panel" aria-label="Run activity" data-testid="board-run-activity">
    <h3>Current and past Runs</h3>
    <p>Select a Run to show its own immutable topology, even when repeat was added or removed in a later saved version.</p>
    {error ? <Alert tone="danger" live title="That run couldn’t be opened.">{error}</Alert> : null}
    {denied ? <Alert tone="warning" title="You don’t have access to this workflow’s runs." /> : runs.isError ? <Alert tone="danger" title="Runs couldn’t be loaded."
      action={<Button size="sm" onClick={() => void refreshFirstInspectionPage(client, boardRunListKey(workspaceId, workflowId))}>Try again</Button>} /> : null}
    {runs.isPending && !denied ? <LoadingState label="Loading runs…" rows={3} /> : null}
    {!runs.isPending && !listed.length && !fresh.length && !denied && !runs.isError ? <EmptyState icon="history" title="No runs yet" description="Start a run from the board. It shows up here." /> : null}
    <ul className="board-run-list">
      {fresh.filter((run) => !listedIds.has(run.id)).map((run) => <li key={run.id}>
        <button type="button" className="board-run-row" disabled={reading === run.id} onClick={() => void inspect(run.id)} aria-label={`Inspect ${run.id}`}>
          <StatusBadge label={runLabel(run.executionState, run.outcome)} tone={runTone(run.executionState, run.outcome)} busy={run.executionState === 'running'} />
          <code>{run.id.slice(-8)}</code><span>{run.cleanupPending ? 'Cleaning up' : when(run.startedAt)}</span>
        </button></li>)}
      {listed.map((run) => {
        const facts = freshById.get(run.id) ?? run
        let scope: ReturnType<typeof scopeForBoardRun>
        try { scope = scopeForBoardRun(run) } catch {
          return <li key={run.id}><p className="next-draft-hint">Run {run.id.slice(-8)} can’t be shown on this board.</p></li>
        }
        const current = !!selected && sameCanonicalGraphScope(scope, selected)
        return <li key={run.id}><button type="button" className="board-run-row" aria-pressed={current}
          aria-label={`Open Run ${run.id} · ${facts.executionState} · ${facts.outcome}`}
          onClick={() => { ++request.current; resetDiscovery(); selectRun(current ? undefined : scope) }}>
          <StatusBadge label={runLabel(facts.executionState, facts.outcome)} tone={runTone(facts.executionState, facts.outcome)} busy={facts.executionState === 'running'} />
          <code>{run.id.slice(-8)}</code><span>{when(facts.startedAt)}</span>
          <span>{facts.executionState === 'completed' ? 'Past Run' : 'Current Run'} · saved version <code>{run.workflowVersionId}</code></span>
        </button></li>
      })}
    </ul>
    <div className="n-actions">
      {runs.hasNextPage && !denied && !runs.isError ? <Button size="sm" disabled={runs.isFetching} onClick={() => void runs.fetchNextPage()}>Load more Runs</Button> : null}
      <Button size="sm" variant="ghost" leading={<Icon name="refresh" size={14} />} disabled={runs.isFetching} onClick={() => void refreshFirstInspectionPage(client, boardRunListKey(workspaceId, workflowId))}>Refresh Runs</Button>
    </div>
    {runs.data?.pages.length === 5 ? <p>The five most recently loaded pages are retained. Refresh starts at the first page.</p> : null}
    {!selected ? <section className="board-activities" aria-label="Activities"><h3>Activities</h3>
      <p>Select a Run to see its recorded Agent actions, outcomes and notices.</p></section> : null}
    {selected ? <section className="board-run-detail" aria-label="Selected run">
      <header><h3>Run {selected.runId.slice(-8)}</h3>
        <Button size="sm" variant="ghost" onClick={() => { ++request.current; resetDiscovery(); selectRun() }}>Clear Run selection</Button></header>
      <CurrentRunDetails key={JSON.stringify(selected)} scope={selected}
        runActions={<RunActions workspaceId={selected.workspaceId} workflowId={selected.workflowId} runId={selected.runId} />} />
    </section> : null}
  </div>
}
