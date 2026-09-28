import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { defaultStringifySearch, useLocation, useRouter } from '@tanstack/react-router'
import type { RepeatGraphScopeV3, RunActivityPublic } from '@graphql/contracts/wave25'
import { Alert, Button, Select } from '../../shared/ui/nocturne'
import { ApiError } from '../../shared/api/client'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { runReadErrorLabel, useSelectedRunSnapshot } from '../runs-selector/query'
import { createChatVisit, type SelectedChatBinding } from '../conversations/agentChat/selectedRunChatModel'
import { useProtectedAccessError } from '../auth/useProtectedAccessError'
import { readRunActivities, readRunActivityFeed, mergeRunActivities,
  runActivitiesKey, type RunActivityFeed, type RunActivityScope } from './runActivitiesQuery'
import './activities.css'

type ActivitiesProps = { scope: RepeatGraphScopeV3; selection?: never; chat?: never }
  | { scope?: never; selection: SelectedRunState; chat?: SelectedChatBinding }

/** Callers need not remember a React key. Run, execution and conversation changes
 * reset feed/scroll/older-page requests together, without remounting the Board. */
export function Activities(props: ActivitiesProps) {
  return props.selection ? <SelectedActivities selection={props.selection} chat={props.chat} />
    : <ActivityFeed key={JSON.stringify(props.scope)} scope={props.scope!} />
}

function SelectedActivities({ selection, chat }: { selection: SelectedRunState; chat?: SelectedChatBinding }) {
  const query = useSelectedRunSnapshot(selection)
  if (!selection.active) return null
  if (selection.invalid) return <p role="status">Invalid Run</p>
  if (!selection.isCurrent(selection.generation) || chat && !chat.isCurrent()) return null
  if (selection.identity.runId === null) return null
  if (query.isError) return <p role="status">{runReadErrorLabel(query.error)}</p>
  const snapshot = query.snapshot
  if (!snapshot) return <p role="status">Loading Activities…</p>
  if (snapshot.kind === 'unavailable') return <p role="status">Activities unavailable</p>
  const scope = { workspaceId: snapshot.workspaceId, workflowId: snapshot.workflowId,
    runId: snapshot.runId, workflowVersionId: snapshot.workflowVersionId }
  // Run facts have no conversationId. Partition their UI cache by the chat binding,
  // and filter only explicit execution references; never relabel chat events as Run results.
  const address = JSON.stringify([scope, selection.generation.id, chat?.visitId, chat?.key ?? chat?.selection ?? null])
  return <ActivityFeed key={address} scope={scope} selection={selection} chat={chat} address={address} />
}

function ActivityFeed({ scope, selection, chat, address }: { scope: RunActivityScope; selection?: SelectedRunState; chat?: SelectedChatBinding; address?: string }) {
  const cache = useQueryClient()
  const key = address ? [...runActivitiesKey(scope), address] : runActivitiesKey(scope)
  const isSelected = selection?.isCurrent, ticket = selection?.generation
  const visit = useMemo(() => createChatVisit(() => (!isSelected || !ticket || isSelected(ticket))
    && (!chat || chat.isCurrent())), [isSelected, ticket, chat])
  useEffect(() => visit.mount(), [visit])
  const list = useRef<HTMLOListElement>(null)
  const lastSequence = useRef<string | undefined>(undefined)
  const [newCount, setNewCount] = useState(0)
  const location = useLocation(), router = useRouter()
  const search = RunsSelectorSearchSchema.parse(location.search)
  const kind = search.activityKind ?? '', agentId = search.activityAgentId ?? ''
  const setFilter = (field: 'activityKind' | 'activityAgentId', value: string) => {
    if (!visit.isCurrent()) return
    const next = RunsSelectorSearchSchema.parse({ ...router.state.location.search, [field]: value || undefined })
    const query = (router.options.stringifySearch ?? defaultStringifySearch)(next)
    void router.navigate({ href: `${router.state.location.pathname}${query}${router.history.location.hash}`, replace: true, resetScroll: false })
  }
  const feed = useQuery({ queryKey: key,
    queryFn: async ({ signal }) => {
      const current = visit.capture()
      if (!current()) throw new DOMException('Selection changed', 'AbortError')
      const result = await readRunActivityFeed(scope, cache.getQueryData<RunActivityFeed>(key), { signal })
      if (!current() || signal.aborted) throw new DOMException('Selection changed', 'AbortError')
      return result
    },
    retry: false, staleTime: 0, gcTime: address ? 0 : 60_000, refetchOnMount: 'always',
    refetchOnReconnect: true, refetchOnWindowFocus: true,
    refetchInterval: (query) => query.state.error ? false : 3000 })
  const denied = useProtectedAccessError(feed)
  const older = useMutation({ retry: false,
    mutationFn: async (cursor: string) => {
      const current = visit.capture()
      if (!current()) throw new DOMException('Selection changed', 'AbortError')
      const page = await readRunActivities(scope, cursor)
      if (!current()) throw new DOMException('Selection changed', 'AbortError')
      return page
    },
    onSuccess: (page) => {
      if (!visit.isCurrent()) return
      const height = list.current?.scrollHeight ?? 0, top = list.current?.scrollTop ?? 0
      cache.setQueryData<RunActivityFeed>(key, (current) => current ? { ...current,
        items: mergeRunActivities(current.items, page.items), olderCursor: page.olderCursor,
        retainedFrom: page.retainedFrom } : current)
      requestAnimationFrame(() => { if (visit.isCurrent() && list.current) list.current.scrollTop = top + list.current.scrollHeight - height })
    } })
  const scopedItems = useMemo(() => chat ? feed.data?.items.filter((item) => item.refs.executionId === chat.selection.executionId
    && (!item.actor && !item.subject || item.actor?.nodeId === chat.selection.workflowNodeId || item.subject?.nodeId === chat.selection.workflowNodeId))
    : feed.data?.items, [feed.data?.items, chat])
  const latest = scopedItems?.at(-1)?.sequence
  useEffect(() => {
    if (!latest) return
    if (lastSequence.current && BigInt(latest) > BigInt(lastSequence.current)) {
      const unseen = scopedItems?.filter((item) => BigInt(item.sequence) > BigInt(lastSequence.current!)).length ?? 0
      if (list.current && list.current.scrollTop + list.current.clientHeight < list.current.scrollHeight - 24) {
        setNewCount((current) => current + unseen)
      }
    }
    lastSequence.current = latest
  }, [latest, scopedItems])
  const refresh = () => { if (!visit.isCurrent()) return; older.reset(); setNewCount(0); lastSequence.current = undefined
    void cache.resetQueries({ queryKey: key, exact: true }) }
  const loadOlder = async () => {
    const cursor = feed.data?.olderCursor
    if (!visit.isCurrent() || !cursor || feed.isFetching || older.isPending) return
    await cache.cancelQueries({ queryKey: key, exact: true })
    if (visit.isCurrent()) older.mutate(cursor)
  }
  const error = feed.isError ? feed.error : older.error
  const items = visit.isCurrent() && !error && !denied && feed.isFetchedAfterMount ? scopedItems : undefined
  const agents = [...new Map(items?.flatMap((item) => [item.actor, item.subject]
    .filter((agent) => agent !== undefined).map((agent) => [agent.agentId, agent] as const)) ?? []).values()]
    .sort((a, b) => a.agentName.localeCompare(b.agentName))
  const visible = items?.filter((item) => (chat || !kind || item.kind === kind)
    && (chat || !agentId || item.actor?.agentId === agentId || item.subject?.agentId === agentId))
  return <section className="board-activities" aria-label="Activities" data-run-id={scope.runId}
    data-execution-id={chat?.selection.executionId} data-conversation-id={chat?.key?.conversationId}>
    <header><h3>Activities</h3><Button size="sm" variant="ghost" disabled={feed.isFetching}
      onClick={refresh} aria-label="Refresh Activities">{selection ? 'Refresh' : 'Refresh Activities'}</Button></header>
    {!selection ? <p>Recorded actions for this Run, in server order. Pending approvals stay in the approval inbox.</p> : null}
    {denied ? <Alert tone="warning" title="Activities access was withdrawn." /> : error ?
      <Alert tone="warning" title={ApiError.is(error) && error.status === 410 ? 'Activity history has a retention gap.' : 'Activities are unavailable.'}>
        {!selection ? 'Loaded Activities are hidden until this Run is read again. ' : null}<Button size="sm" onClick={refresh}>{selection ? 'Retry' : 'Reload this Run’s Activities'}</Button>
      </Alert> : null}
    {!error && !denied && !items ? <p role="status">{feed.isPaused ? 'Activities refresh is offline or paused.' : 'Loading Activities…'}</p> : null}
    {items ? <>
      {!chat ? <div className="board-activities-filters">
        <Select label="Activity kind" value={kind} onChange={(event) => setFilter('activityKind', event.currentTarget.value)}
          options={[{ value: '', label: 'All actions' }, ...[...new Set(items.map((item) => item.kind))].sort()
            .map((value) => ({ value, label: value.replaceAll('_', ' ') })),
          ...(kind && !items.some((item) => item.kind === kind) ? [{ value: kind, label: `${kind.replaceAll('_', ' ')} (outside loaded history)` }] : [])]} />
        <Select label="Agent" value={agentId} onChange={(event) => setFilter('activityAgentId', event.currentTarget.value)}
          options={[{ value: '', label: 'All agents' }, ...agents.map((agent) => ({ value: agent.agentId, label: agent.agentName })),
            ...(agentId && !agents.some((agent) => agent.agentId === agentId) ? [{ value: agentId, label: 'Selected Agent (outside loaded history)' }] : [])]} />
      </div> : null}
      {newCount ? <Button size="sm" onClick={() => { list.current?.scrollTo({ top: list.current.scrollHeight }); setNewCount(0) }}>
        {newCount} new {newCount === 1 ? 'activity' : 'activities'}</Button> : null}
      {!visible?.length ? <p>{selection ? 'No activities' : items.length ? 'No Activities match these filters.' : 'No public activities have been recorded for this Run.'}</p> :
        <ol className="board-activities-list" ref={list}>{visible.map((item) => <ActivityRow key={item.id} item={item} />)}</ol>}
      {feed.data?.olderCursor ? <Button size="sm" disabled={feed.isFetching || older.isPending} onClick={() => void loadOlder()}>
        {older.isPending ? 'Loading…' : selection ? 'More' : 'Load older Activities'}</Button> : null}
      {!selection ? <p className="board-activities-bound">Latest 1,000 public events at most; earlier events may have expired.</p> : null}
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
