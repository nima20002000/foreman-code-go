import { Button } from './nocturne'

export function LoadMore({ label, query }: {
  label: string
  query: { hasNextPage: boolean; isFetching: boolean; isFetchNextPageError: boolean; fetchNextPage: () => unknown }
}) {
  if (!query.hasNextPage) return null
  return <div className="resource-load-more">
    {query.isFetchNextPageError ? <p role="alert">Could not load more {label}. Try again.</p> : null}
    <Button variant="ghost" size="sm" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>
      {query.isFetching ? 'Loading…' : query.isFetchNextPageError ? `Retry loading ${label}` : `Show more ${label}`}
    </Button>
  </div>
}
