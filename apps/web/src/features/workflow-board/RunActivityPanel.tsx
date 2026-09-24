import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { WorkflowRunSummary } from '@graphql/contracts'
import { sameGraphScope } from '@graphql/contracts/wave25'
import { Button } from '../../shared/ui/nocturne'
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
  const active = summaries.filter((run) => run.workspaceId === workspaceId && run.workflowId === workflowId
    && (['queued', 'running', 'waiting', 'interrupted'].includes(run.executionState) || run.cleanupPending))
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
  return <aside className="workflow-board-run-panel" aria-label="Run activity" data-testid="board-run-activity">
    <header><h2>Run activity</h2><p>{active.length} active or recovering Run{active.length === 1 ? '' : 's'} in this workflow</p></header>
    <details className="board-run-picker"><summary>Current and past Runs</summary>
      {active.length ? <section aria-label="Active and recovering Runs">{active.map((run) => <div key={run.id}>
        <Button variant="secondary" disabled={reading === run.id} onClick={() => void inspect(run.id)}>Inspect {run.id}</Button>
        <span>{run.executionState}{run.cleanupPending ? ' · Cleanup pending' : ''}</span>
      </div>)}</section> : null}
      {denied ? <p role="alert">Run list access is unavailable.</p> : runs.isError ? <p role="alert">The Run list could not be loaded.</p> : null}
      <Button variant="secondary" disabled={runs.isFetching} onClick={() => void runs.refetch()}>Refresh Runs</Button>
      <div className="board-run-options">{listed.map((run) => {
        let scope: ReturnType<typeof scopeForBoardRun>
        try { scope = scopeForBoardRun(run) } catch {
          return <p key={run.id}>Run {run.id} has no supported immutable version pin. Its identity was not replaced with the current version.</p>
        }
        return <Button size="sm" variant="ghost" key={run.id} aria-pressed={!!selected && sameGraphScope(scope, selected)}
          onClick={() => { ++request.current; setReading(undefined); selectRun(scope) }}>
          Open Run {run.id} · {run.executionState} · {run.outcome}
        </Button>
      })}</div>
      {runs.hasNextPage && !denied ? <Button variant="secondary" disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>Load more Runs</Button> : null}
    </details>
    {error ? <p role="alert">{error}</p> : null}
    {selected ? <>
      <p className="board-run-pin">Run <code>{selected.runId}</code> · version <code>{selected.workflowVersionId}</code></p>
      <p className="board-run-pin">Execution semantics {selected.executionSemanticsVersion}. Editing this board never changes this Run.</p>
      <RunGraphView scope={selected} embedded />
      <Button variant="secondary" onClick={() => { ++request.current; setReading(undefined); selectRun() }}>Clear Run selection</Button>
    </> : <p>Select a current or past Run here. Authoring stays on this board.</p>}
  </aside>
}
