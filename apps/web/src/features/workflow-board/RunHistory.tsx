import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import type { RunGraphScope } from '@graphql/contracts/wave25'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { useProtectedAccessError } from '../auth/useProtectedAccessError'
import { readBoardHistory } from './client'
import { Button } from '../../shared/ui/nocturne'

/** The parent mounts this only after a successful exact-scope Run read. */
export function RunHistory({ scope }: { scope: RunGraphScope }) {
  const [open, setOpen] = useState(false)
  const history = useInfiniteQuery({
    queryKey: ['workbench', 'board-history', sessionGeneration(), scope], enabled: open,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => readBoardHistory(scope, pageParam, { signal }),
    getNextPageParam: (page) => page.pageInfo.nextCursor,
    refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false,
  })
  const denied = useProtectedAccessError(history)
  return <details className="board-history" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Run activity history</summary>
    {denied ? <p role="alert">History access is unavailable.</p> : <>
      {history.isPending ? <p role="status">Loading history…</p> : null}
      {history.isError ? <p role="alert">History could not be loaded. <Button size="sm" variant="ghost" onClick={() => void history.refetch()}>Retry history</Button></p> : null}
      <ol>{history.data?.pages.flatMap((page) => page.items).map((item) => <li key={item.id}>
        <strong>{item.kind}</strong> <time>{item.occurredAt}</time>
        <details><summary>Activity details</summary><pre>{JSON.stringify(item.payload, null, 2)}</pre></details>
      </li>)}</ol>
      {history.data && !history.data.pages.some((page) => page.items.length) ? <p>No recorded activity in this history.</p> : null}
      {history.hasNextPage ? <Button size="sm" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Load more activity</Button> : null}
    </>}
  </details>
}
