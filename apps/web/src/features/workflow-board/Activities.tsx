import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { WorkspaceBoardSearchSchema, type RepeatGraphScopeV3, type RunActivityPublic } from '@graphql/contracts/wave25'
import { Alert, Button, Select } from '../../shared/ui/nocturne'
import { ApiError } from '../../shared/api/client'
import { useProtectedAccessError } from '../auth/useProtectedAccessError'
import { readRunActivities, readRunActivityFeed, mergeRunActivities,
  runActivitiesKey, type RunActivityFeed } from './runActivitiesQuery'
import './activities.css'

/** Each selected Run has its own Query cache key and mount. The service owns
 * ordering, visibility and pagination; this component owns only scroll/filter UI. */
export function Activities({ scope }: { scope: RepeatGraphScopeV3 }) {
  const cache = useQueryClient(), key = runActivitiesKey(scope)
  const list = useRef<HTMLOListElement>(null)
  const lastSequence = useRef<string | undefined>(undefined)
  const [newCount, setNewCount] = useState(0)
  const location = useLocation(), navigate = useNavigate()
  const search = WorkspaceBoardSearchSchema.parse(location.search)
  const kind = search.activityKind ?? '', agentId = search.activityAgentId ?? ''
  const setFilter = (field: 'activityKind' | 'activityAgentId', value: string) => {
    const next = WorkspaceBoardSearchSchema.parse({ ...search, [field]: value || undefined })
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId: scope.workspaceId }, search: next, replace: true })
  }
  const feed = useQuery({ queryKey: key,
    queryFn: ({ signal }) => readRunActivityFeed(scope, cache.getQueryData<RunActivityFeed>(key), { signal }),
    retry: false, staleTime: 0, gcTime: 60_000, refetchOnMount: 'always',
    refetchOnReconnect: true, refetchOnWindowFocus: true,
    refetchInterval: (query) => query.state.error ? false : 3000 })
  const denied = useProtectedAccessError(feed)
  const older = useMutation({ retry: false,
    mutationFn: (cursor: string) => readRunActivities(scope, cursor),
    onSuccess: (page) => {
      const height = list.current?.scrollHeight ?? 0, top = list.current?.scrollTop ?? 0
      cache.setQueryData<RunActivityFeed>(key, (current) => current ? { ...current,
        items: mergeRunActivities(current.items, page.items), olderCursor: page.olderCursor,
        retainedFrom: page.retainedFrom } : current)
      requestAnimationFrame(() => { if (list.current) list.current.scrollTop = top + list.current.scrollHeight - height })
    } })
  const latest = feed.data?.items.at(-1)?.sequence
  useEffect(() => {
    if (!latest) return
    if (lastSequence.current && BigInt(latest) > BigInt(lastSequence.current)) {
      const unseen = feed.data?.items.filter((item) => BigInt(item.sequence) > BigInt(lastSequence.current!)).length ?? 0
      if (list.current && list.current.scrollTop + list.current.clientHeight < list.current.scrollHeight - 24) {
        setNewCount((current) => current + unseen)
      }
    }
    lastSequence.current = latest
  }, [latest, feed.data?.items])
  const refresh = () => { older.reset(); setNewCount(0); lastSequence.current = undefined
    void cache.resetQueries({ queryKey: key, exact: true }) }
  const loadOlder = async () => {
    const cursor = feed.data?.olderCursor
    if (!cursor || feed.isFetching || older.isPending) return
    await cache.cancelQueries({ queryKey: key, exact: true })
    older.mutate(cursor)
  }
  const error = feed.isError ? feed.error : older.error
  const items = !error && !denied && feed.isFetchedAfterMount ? feed.data?.items : undefined
  const agents = [...new Map(items?.flatMap((item) => [item.actor, item.subject]
    .filter((agent) => agent !== undefined).map((agent) => [agent.agentId, agent] as const)) ?? []).values()]
    .sort((a, b) => a.agentName.localeCompare(b.agentName))
  const visible = items?.filter((item) => (!kind || item.kind === kind)
    && (!agentId || item.actor?.agentId === agentId || item.subject?.agentId === agentId))
  return <section className="board-activities" aria-label="Activities">
    <header><h3>Activities</h3><Button size="sm" variant="ghost" disabled={feed.isFetching}
      onClick={refresh}>Refresh Activities</Button></header>
    <p>Recorded actions for this Run, in server order. Pending approvals stay in the approval inbox.</p>
    {denied ? <Alert tone="warning" title="Activities access was withdrawn." /> : error ?
      <Alert tone="warning" title={ApiError.is(error) && error.status === 410 ? 'Activity history has a retention gap.' : 'Activities are unavailable.'}>
        Loaded Activities are hidden until this Run is read again. <Button size="sm" onClick={refresh}>Reload this Run’s Activities</Button>
      </Alert> : null}
    {!error && !denied && !items ? <p role="status">{feed.isPaused ? 'Activities refresh is offline or paused.' : 'Loading Activities…'}</p> : null}
    {items ? <>
      <div className="board-activities-filters">
        <Select label="Activity kind" value={kind} onChange={(event) => setFilter('activityKind', event.currentTarget.value)}
          options={[{ value: '', label: 'All actions' }, ...[...new Set(items.map((item) => item.kind))].sort()
            .map((value) => ({ value, label: value.replaceAll('_', ' ') })),
          ...(kind && !items.some((item) => item.kind === kind) ? [{ value: kind, label: `${kind.replaceAll('_', ' ')} (outside loaded history)` }] : [])]} />
        <Select label="Agent" value={agentId} onChange={(event) => setFilter('activityAgentId', event.currentTarget.value)}
          options={[{ value: '', label: 'All agents' }, ...agents.map((agent) => ({ value: agent.agentId, label: agent.agentName })),
            ...(agentId && !agents.some((agent) => agent.agentId === agentId) ? [{ value: agentId, label: 'Selected Agent (outside loaded history)' }] : [])]} />
      </div>
      {newCount ? <Button size="sm" onClick={() => { list.current?.scrollTo({ top: list.current.scrollHeight }); setNewCount(0) }}>
        {newCount} new {newCount === 1 ? 'activity' : 'activities'}</Button> : null}
      {!visible?.length ? <p>{items.length ? 'No Activities match these filters.' : 'No public activities have been recorded for this Run.'}</p> :
        <ol className="board-activities-list" ref={list}>{visible.map((item) => <ActivityRow key={item.id} item={item} />)}</ol>}
      {feed.data?.olderCursor ? <Button size="sm" disabled={feed.isFetching || older.isPending} onClick={() => void loadOlder()}>
        {older.isPending ? 'Loading older Activities…' : 'Load older Activities'}</Button> : null}
      <p className="board-activities-bound">Latest 1,000 public events at most; earlier events may have expired.</p>
    </> : null}
  </section>
}

function ActivityRow({ item }: { item: RunActivityPublic }) {
  return <li><time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString()}</time>
    <div><strong>{item.actor?.agentName ?? item.subject?.agentName ?? 'Workflow'}</strong>
      <span className={`board-activity-status is-${item.severity}`}>{item.status.replaceAll('_', ' ')}</span>
      <p>{item.summary}</p>{item.detail ? <p className="board-activity-detail">{item.detail}</p> : null}
      {item.usage ? <small>{item.usage.used} used · {item.usage.limit === null ? 'no connection cap' : `${item.usage.limit} limit`}</small> : null}
    </div></li>
}
