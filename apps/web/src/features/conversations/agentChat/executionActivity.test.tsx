import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentChatFixtures, type AgentChatExecutionActivityPage, type AgentChatExecutionItem, type AgentChatState,
} from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { useConversationDraftStore } from '../conversationDraftStore'
import { mergeExecutionActivity, type ExecutionActivityFeed } from './executionActivity'
import { installChatSource, mountChat } from './testSupport'
import { deferred } from '../../../test/deferred'

const at = '2026-09-27T12:00:00.000Z'
const message = (executionId: string, id: string, sequence: string, content: string, role: 'user' | 'assistant' = 'assistant'): AgentChatExecutionItem =>
  ({ executionId, id, sequence, revision: sequence, entry: { kind: 'message', message: { id: `${executionId}:${id}`, role, content, nativeMessageComplete: true } } })
const tool = (executionId: string, id: string, sequence: string, title: string, status: 'running' | 'completed' | 'unknown', output: string, truncated = false): AgentChatExecutionItem =>
  ({ executionId, id, sequence, revision: sequence, entry: { kind: 'activity', activity: { id, kind: 'tool', title, status, output, ...(truncated ? { truncated } : {}) } } })
const executions = (checkState: 'running' | 'completed'): AgentChatExecutionActivityPage['executions'] => [
  { executionId: 'execution-main', label: 'Execution', attempt: 1, state: 'completed', createdAt: at, revision: '3' },
  { executionId: 'execution-check', label: 'Interval check 1', attempt: 1, tickIndex: 1, state: checkState, createdAt: at, revision: '9', hasEarlierItems: true },
]
const snapshot = (checkState: 'running' | 'completed', items: AgentChatExecutionItem[]): AgentChatExecutionActivityPage =>
  ({ mode: 'snapshot', executions: executions(checkState), hasEarlierExecutions: false, cursor: '{}', hasMoreChanges: false, items })

const activityQuery = { predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey.at(-1) === 'execution-activity' }
const activityData = (client: QueryClient) => client.getQueriesData<ExecutionActivityFeed>(activityQuery)[0]?.[1]
const runState = () => {
  const state: AgentChatState = structuredClone(agentChatFixtures.empty)
  state.context.runId = 'selected-run'
  return state
}
const livePage = (items: AgentChatExecutionItem[], revision: string,
  options: { hasEarlierItems?: boolean } = {}): AgentChatExecutionActivityPage => ({
  mode: 'snapshot',
  executions: [{ ...executions('running')[1]!, revision, hasEarlierItems: options.hasEarlierItems ?? false }],
  hasEarlierExecutions: false,
  cursor: `live-${revision}`,
  hasMoreChanges: false,
  items,
})
const numberedMessages = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => {
  const sequence = String(first + index)
  return message('execution-check', `note-${sequence}`, sequence, `Activity ${sequence}`)
})
async function pollActivity(mounted: ReturnType<typeof mountChat>, page: AgentChatExecutionActivityPage) {
  mounted.mock.setExecutionActivity(runState().context, page)
  await act(async () => { await mounted.client.refetchQueries(activityQuery) })
}
async function finishRead(client: QueryClient, release: () => void) {
  const merged = deferred<void>()
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (event.type === 'updated' && activityQuery.predicate(event.query) && event.action.type === 'success') {
      merged.resolve(undefined)
    }
  })
  await act(async () => { release(); await merged.promise })
  unsubscribe()
}

beforeEach(installChatSource)
afterEach(() => { useConversationDraftStore.getState().clearAllDrafts(); vi.unstubAllGlobals() })

describe('Board Agent chat live execution activity', () => {
  it('shows each labeled execution with its messages and tool steps live, and one compact working line in the composer', async () => {
    const state: AgentChatState = structuredClone(agentChatFixtures.empty)
    state.context.runId = 'selected-run'
    state.availability = { canSend: false, reason: 'run_active', message: 'Working — you can message it when it finishes' }
    const mounted = mountChat(state)
    mounted.mock.setExecutionActivity(state.context, snapshot('running', [
      message('execution-main', 'final', '3', 'Initial work finished'),
      message('execution-check', 'prompt', '5', 'Check CI', 'user'),
      tool('execution-check', 'cmd-1', '7', 'git status', 'running', 'On branch main', true),
    ]))
    await mounted.ready()
    const check = await screen.findByRole('region', { name: 'Interval check 1 · Working' })
    expect(within(check).getByText('Ran git status')).toBeVisible()
    expect(within(check).getByText('Running')).toBeVisible()
    expect(screen.getByText('Initial work finished')).toBeVisible()
    const composer = screen.getByRole('textbox', { name: 'Message' })
    expect(composer).toBeDisabled()
    expect(composer).toHaveAttribute('placeholder', 'Working — you can message it when it finishes')

    server.use(http.get('/api/workspaces/:workspaceId/agent-chat/execution-activity', ({ request }) => {
      const params = new URL(request.url).searchParams
      if (params.get('itemId') === 'cmd-1') return HttpResponse.json({ ...snapshot('running', [
        tool('execution-check', 'cmd-1', '7', 'git status', 'running', 'On branch main\nfull output')]), mode: 'item', cursor: undefined })
      if (params.get('before') === '5') return HttpResponse.json({ ...snapshot('running', [
        message('execution-check', 'older', '4', 'Older check note')]), mode: 'earlier', cursor: undefined,
        executions: executions('running').map((execution) => ({ ...execution, hasEarlierItems: false })) })
      return undefined
    }))
    fireEvent.click(within(check).getByText('Ran git status'))
    fireEvent.click(within(check).getByRole('button', { name: 'Show full details' }))
    expect(await within(check).findByText(/full output/)).toBeVisible()
    fireEvent.click(within(check).getByRole('button', { name: 'Load earlier activity' }))
    expect(await within(check).findByText('Older check note')).toBeVisible()

    mounted.mock.setExecutionActivity(state.context, snapshot('completed', [
      message('execution-check', 'prompt', '5', 'Check CI', 'user'),
      tool('execution-check', 'cmd-1', '9', 'git status', 'completed', 'clean'),
    ]))
    expect(await screen.findByRole('region', { name: 'Interval check 1 · Completed' }, { timeout: 3000 })).toBeVisible()
  })

  it('loads unread history from the contiguous window after a much older entry changes', async () => {
    const state = runState()
    const mounted = mountChat(state)
    mounted.mock.setExecutionActivity(state.context, livePage(numberedMessages(101, 103), '300', { hasEarlierItems: true }))
    const check = await screen.findByRole('region', { name: 'Interval check 1 · Working' })
    const oldPlan = { ...message('execution-check', 'plan', '1', 'Updated original plan'), revision: '301' }
    await pollActivity(mounted, livePage([oldPlan], '301', { hasEarlierItems: true }))
    expect(await within(check).findByText('Updated original plan')).toBeVisible()

    const before: string[] = []
    server.use(http.get('/api/workspaces/:workspaceId/agent-chat/execution-activity', ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('before')
      if (!cursor) return undefined
      before.push(cursor)
      const items = cursor === '101' ? numberedMessages(50, 100) : numberedMessages(2, 49)
      return HttpResponse.json({ ...livePage(items, '301', { hasEarlierItems: cursor === '101' }),
        mode: 'earlier', cursor: undefined })
    }))
    fireEvent.click(within(check).getByRole('button', { name: 'Load earlier activity' }))
    expect(await within(check).findByText('Activity 100')).toBeVisible()
    fireEvent.click(within(check).getByRole('button', { name: 'Load earlier activity' }))
    expect(await within(check).findByText('Activity 2')).toBeVisible()
    expect(before).toEqual(['101', '50'])
    expect(activityData(mounted.client)?.cursor).toBe('live-301')
  })

  it.each(['earlier', 'item'] as const)('keeps newer execution rows, status and cursor after a delayed %s read', async mode => {
    const state = runState()
    const mounted = mountChat(state)
    const main = { ...executions('running')[0]!, state: 'running' as const, revision: '10', hasEarlierItems: true }
    mounted.mock.setExecutionActivity(state.context, { ...snapshot('running', [
      message('execution-main', 'prompt', '9', 'Original prompt'),
      tool('execution-main', 'command', '10', 'check status', 'running', 'Initial output', true),
    ]), executions: [main], cursor: 'before-check' })
    const initial = await screen.findByRole('region', { name: 'Execution · Working' })
    const pending = deferred<AgentChatExecutionActivityPage>()
    let requested = false
    server.use(http.get('/api/workspaces/:workspaceId/agent-chat/execution-activity', async ({ request }) => {
      const params = new URL(request.url).searchParams
      if (!params.has(mode === 'earlier' ? 'before' : 'itemId')) return undefined
      requested = true
      return HttpResponse.json(await pending.promise)
    }))
    if (mode === 'earlier') fireEvent.click(within(initial).getByRole('button', { name: 'Load earlier activity' }))
    else {
      fireEvent.click(within(initial).getByText('Ran check status'))
      fireEvent.click(within(initial).getByRole('button', { name: 'Show full details' }))
    }
    await waitFor(() => expect(requested).toBe(true))
    const finished = { ...main, state: 'completed' as const, revision: '12' }
    await pollActivity(mounted, { ...snapshot('completed', [
      { ...tool('execution-main', 'command', '10', 'check status', 'unknown', 'Latest output'), revision: '12' },
      { ...tool('execution-main', 'older-command', '5', 'earlier status', 'unknown', 'Latest older output'), revision: '12' },
      message('execution-check', 'result', '5', 'New check transcript'),
    ]), executions: [finished, executions('completed')[1]!], cursor: 'after-check', hasEarlierExecutions: true })
    expect(await screen.findByText('New check transcript')).toBeVisible()

    const items = mode === 'earlier' ? [
      tool('execution-main', 'older-command', '5', 'earlier status', 'running', 'Old output'),
      message('execution-main', 'older-note', '8', 'Older execution note'),
    ] : [tool('execution-main', 'command', '10', 'check status', 'running', 'Old full output')]
    await finishRead(mounted.client, () => pending.resolve({ ...snapshot('running', items),
      mode, executions: [main], cursor: undefined }))
    const transcript = screen.getByRole('region', { name: 'Workflow execution transcript' })
    if (mode === 'earlier') expect(await within(transcript).findByText('Older execution note')).toBeVisible()
    expect(within(transcript).getByText('New check transcript')).toBeVisible()
    expect(within(transcript).getByRole('region', { name: 'Execution · Completed' })).toBeVisible()
    expect(within(transcript).getByRole('region', { name: 'Interval check 1 · Completed' })).toBeVisible()
    expect(within(transcript).queryByText('Running')).not.toBeInTheDocument()
    expect(within(transcript).getAllByText('Unconfirmed')[0]).toBeVisible()
    expect(within(transcript).getByText('Newest 20 executions')).toBeVisible()
    expect(activityData(mounted.client)?.cursor).toBe('after-check')
    if (mode === 'item') expect(within(transcript).queryByText('Old full output')).not.toBeInTheDocument()
  })

  it('bounds live retention and rendering during polling', async () => {
    const state = runState()
    const mounted = mountChat(state)
    mounted.mock.setExecutionActivity(state.context, livePage(numberedMessages(1, 200), '200'))
    const check = await screen.findByRole('region', { name: 'Interval check 1 · Working' })
    for (const end of [400, 600, 800]) {
      await pollActivity(mounted, livePage(numberedMessages(end - 199, end), String(end)))
      expect(await within(check).findByText(`Activity ${end}`)).toBeVisible()
      expect(activityData(mounted.client)?.items.length).toBeLessThanOrEqual(200)
      expect(within(check).getAllByRole('listitem', { hidden: true }).length).toBeLessThanOrEqual(200)
    }
    expect(within(check).getByText('Activity 800')).toBeVisible()
    expect(within(check).queryByText('Activity 1')).not.toBeInTheDocument()
  })

  it('keeps history browsable during polling and ignores an abandoned history read', async () => {
    const state = runState()
    const mounted = mountChat(state)
    mounted.mock.setExecutionActivity(state.context,
      livePage(numberedMessages(601, 800), '800', { hasEarlierItems: true }))
    const check = await screen.findByRole('region', { name: 'Interval check 1 · Working' })
    expect(within(check).getByText('Activity 800')).toBeVisible()

    const pending = deferred<AgentChatExecutionActivityPage>()
    const abandoned = deferred<AgentChatExecutionActivityPage>()
    const before: string[] = []
    server.use(http.get('/api/workspaces/:workspaceId/agent-chat/execution-activity', async ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('before')
      if (!cursor) return undefined
      before.push(cursor)
      if (cursor === '601') return HttpResponse.json(await pending.promise)
      if (cursor === '201') return HttpResponse.json(await abandoned.promise)
      return HttpResponse.json({ ...livePage(numberedMessages(201, 400), '850', { hasEarlierItems: true }),
        mode: 'earlier', cursor: undefined })
    }))
    fireEvent.click(within(check).getByRole('button', { name: 'Load earlier activity' }))
    await waitFor(() => expect(before).toEqual(['601']))
    await pollActivity(mounted, livePage(numberedMessages(801, 850), '850'))
    await finishRead(mounted.client, () => pending.resolve({
      ...livePage(numberedMessages(401, 600), '800', { hasEarlierItems: true }), mode: 'earlier', cursor: undefined,
    }))
    expect(await within(check).findByText('Activity 401')).toBeVisible()
    expect(within(check).queryByText('Activity 850')).not.toBeInTheDocument()
    await pollActivity(mounted, livePage(numberedMessages(851, 900), '900'))
    expect(within(check).getByText('Activity 401')).toBeVisible()
    fireEvent.click(within(check).getByRole('button', { name: 'Load earlier activity' }))
    expect(await within(check).findByText('Activity 201')).toBeVisible()
    expect(before).toEqual(['601', '401'])
    expect(within(check).getAllByRole('listitem', { hidden: true }).length).toBeLessThanOrEqual(200)
    fireEvent.click(within(check).getByRole('button', { name: 'Load earlier activity' }))
    await waitFor(() => expect(before).toEqual(['601', '401', '201']))
    fireEvent.click(within(check).getByRole('button', { name: 'Back to latest activity' }))
    expect(await within(check).findByText('Activity 900')).toBeVisible()
    await pollActivity(mounted, livePage(numberedMessages(901, 950), '950'))
    expect(await within(check).findByText('Activity 950')).toBeVisible()
    await finishRead(mounted.client, () => abandoned.resolve({
      ...livePage(numberedMessages(1, 200), '900'), mode: 'earlier', cursor: undefined,
    }))
    expect(within(check).getByText('Activity 950')).toBeVisible()
    expect(within(check).queryByText('Activity 201')).not.toBeInTheDocument()
    expect(within(check).queryByRole('button', { name: 'Back to latest activity' })).not.toBeInTheDocument()
    expect(activityData(mounted.client)?.items.length).toBeLessThanOrEqual(200)
  })

  it('caps multibyte transcript bytes and reloads entries evicted by the byte budget', async () => {
    const state = runState()
    const mounted = mountChat(state)
    const content = '漢'.repeat(4_000)
    const items = Array.from({ length: 30 }, (_, index) => message('execution-check', `large-${index + 1}`,
      String(index + 1), `Large activity ${index + 1}: ${content}`, 'user'))
    mounted.mock.setExecutionActivity(state.context, livePage(items.slice(0, 10), '10'))
    const check = await screen.findByRole('region', { name: 'Interval check 1 · Working' })
    await pollActivity(mounted, livePage(items.slice(10, 20), '20'))
    await pollActivity(mounted, livePage(items.slice(20), '30'))
    expect(await within(check).findByText(`Large activity 30: ${content}`)).toBeVisible()
    const retained = activityData(mounted.client)!
    const bytes = retained.items.reduce((total, item) => total + new TextEncoder().encode(JSON.stringify(item)).byteLength, 0)
    expect(bytes).toBeLessThanOrEqual(256 * 1024)
    expect(retained.items.length).toBeLessThan(30)
    expect(within(check).getAllByRole('listitem', { hidden: true })).toHaveLength(retained.items.length)
    expect(within(check).queryByText(`Large activity 1: ${content}`)).not.toBeInTheDocument()
    const boundary = retained.before['execution-check']!
    let requestedBefore: string | null = null
    server.use(http.get('/api/workspaces/:workspaceId/agent-chat/execution-activity', ({ request }) => {
      const before = new URL(request.url).searchParams.get('before')
      if (!before) return undefined
      requestedBefore = before
      return HttpResponse.json({ ...livePage([items[0]!], '30'), mode: 'earlier', cursor: undefined })
    }))
    fireEvent.click(within(check).getByRole('button', { name: 'Load earlier activity' }))
    expect(await within(check).findByText(`Large activity 1: ${content}`)).toBeVisible()
    expect(requestedBefore).toBe(boundary)
  })
})

describe('mergeExecutionActivity', () => {
  it('upserts changed entries in execution and native order without regressing a newer revision', () => {
    const base = mergeExecutionActivity(undefined, snapshot('running', [
      message('execution-main', 'final', '3', 'Done'), tool('execution-check', 'cmd-1', '7', 'git status', 'running', 'partial')]))
    const changed = mergeExecutionActivity(base, { ...snapshot('running', [
      { ...tool('execution-check', 'cmd-1', '7', 'git status', 'completed', 'clean'), revision: '9' },
      message('execution-check', 'reply', '8', 'All green')]), mode: 'changes', cursor: '{"execution-check":"9"}' })
    expect(changed.items.map((item) => item.id)).toEqual(['final', 'cmd-1', 'reply'])
    expect(changed.items[1]?.entry).toMatchObject({ activity: { status: 'completed', output: 'clean' } })
    const stale = mergeExecutionActivity(changed, { ...snapshot('running', [tool('execution-check', 'cmd-1', '7', 'git status', 'running', 'partial')]),
      mode: 'earlier', cursor: undefined })
    expect(stale.items[1]?.entry).toMatchObject({ activity: { status: 'completed' } })
    expect(stale.cursor).toBe('{"execution-check":"9"}')
    expect(stale.executions[1]?.hasEarlierItems).toBe(true)
  })
})

it.each([20_480, 80_000])('expands a shortened Run answer through the scoped item endpoint (%s bytes)', async size => {
  const state = runState()
  const mounted = mountChat(state)
  const content = 'x'.repeat(size - 8) + 'THE END!'
  const preview = message('execution-check', 'answer', '1', content.slice(0, 16_384))
  if (preview.entry.kind !== 'message') throw new Error('Expected a message fixture')
  preview.entry.message.truncation = { truncated: true, originalBytes: size }
  mounted.mock.setExecutionActivity(state.context, livePage([preview], '1'))
  const requests: URLSearchParams[] = []
  server.use(http.get('/api/workspaces/:workspaceId/agent-chat/execution-activity', ({ request }) => {
    const params = new URL(request.url).searchParams
    if (!params.has('itemId')) return undefined
    requests.push(params)
    const expanded = message('execution-check', 'answer', '1', content.slice(0, 65_536))
    if (expanded.entry.kind === 'message' && size > 65_536) {
      expanded.entry.message.truncation = { truncated: true, originalBytes: size }
    }
    return HttpResponse.json({ ...livePage([expanded], '1'), mode: 'item', cursor: undefined })
  }))
  fireEvent.click(await screen.findByRole('button', { name: 'Show full message' }))
  expect(await screen.findByText(content.slice(0, 65_536))).toBeVisible()
  expect(requests).toHaveLength(1)
  expect(requests[0]?.get('executionId')).toBe('execution-check')
  expect(requests[0]?.get('itemId')).toBe('answer')
  expect(requests[0]?.get('runId')).toBe('selected-run')
  if (size > 65_536) expect(screen.getByText(/shortened/i)).toBeVisible()
  else expect(screen.queryByText(/shortened/i)).not.toBeInTheDocument()
})

it('keeps a shortened answer visible during a failed expansion and allows retry with loading feedback', async () => {
  const state = runState()
  const mounted = mountChat(state)
  const preview = message('execution-check', 'answer', '1', 'Visible preview')
  if (preview.entry.kind !== 'message') throw new Error('Expected a message fixture')
  preview.entry.message.truncation = { truncated: true, originalBytes: 20_480 }
  mounted.mock.setExecutionActivity(state.context, livePage([preview], '1'))
  let attempts = 0
  const pending = deferred<void>()
  server.use(http.get('/api/workspaces/:workspaceId/agent-chat/execution-activity', async ({ request }) => {
    if (!new URL(request.url).searchParams.has('itemId')) return undefined
    attempts++
    if (attempts === 1) return HttpResponse.json({ error: { code: 'READ_FAILED', message: 'Full message unavailable.' } }, { status: 503 })
    await pending.promise
    return HttpResponse.json({ ...livePage([message('execution-check', 'answer', '1', 'Expanded answer')], '1'),
      mode: 'item', cursor: undefined })
  }))
  fireEvent.click(await screen.findByRole('button', { name: 'Show full message' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Full message unavailable.')
  expect(screen.getByText('Visible preview')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Show full message' }))
  expect(await screen.findByRole('button', { name: 'Loading full message…' })).toBeDisabled()
  await act(async () => pending.resolve())
  expect(await screen.findByText('Expanded answer')).toBeVisible()
})
