// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { RunBoardSnapshotGetResultSchema } from '@foreman-code/contracts/run-snapshots'
import { RunActivitiesPageSchema, type RunActivityPublic } from '@foreman-code/contracts/wave25'
import { server } from '../../mocks/server'
import { AgentChatPanel } from '../graph/AgentPanels'
import { installFlowLayout } from '../run-board/testFlowLayout'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { useRunsSelectorUi } from '../runs-selector/uiStore'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { installChatSource } from '../conversations/agentChat/testSupport'
import { agentChatContextKey } from '../conversations/agentChat/model'
import { activitiesRoute, activityPage, admitted, clients, context, envelope, execution, historicalState,
  installSelectedHandlers, nodeId, scope, selectedRoute, snapshot, snapshotRoute } from '../conversations/agentChat/sch10.testSupport'
import { boardDraftContextKey } from './keys'
import { WorkflowBoard } from './WorkflowBoard'
import { useWorkflowBoard } from './context'
import boardStyles from './workflowBoard.css?inline'
import chatStyles from '../conversations/agentChat/agentChat.css?inline'
import historyStyles from '../conversations/conversationHistory.css?inline'

function CurrentNavigation() { return useWorkflowBoard()?.navigationControls }

vi.mock('../schedules', () => ({ ScheduleClockButton: () => null }))
vi.mock('../workflow-files', () => ({ WorkflowFilesButton: () => null }))

beforeEach(() => { installChatSource(); installFlowLayout(); useRunsSelectorUi.getState().setOpen(null) })
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  useRunsSelectorUi.getState().setOpen(null)
  useConversationDraftStore.getState().clearAllDrafts()
  localStorage.clear()
  vi.unstubAllGlobals()
})

it('opens saved Agent chat for a selected past Run and returns to Current chat', async () => {
  const source = installSelectedHandlers()
  const first = snapshot('run-a').snapshot
  if (first.kind !== 'available') throw new Error('Expected available snapshot')
  const saved = { snapshot: { ...first, nodes: [...first.nodes,
    { ...first.nodes[0]!, id: 'node-second', name: 'Second saved Agent', agentId: 'agent-second' }] } }
  server.use(http.get(snapshotRoute, () => HttpResponse.json(saved)))
  const second = historicalState('run-a')
  second.context = { ...second.context, workflowNodeId: 'node-second', agentId: 'agent-second' }
  if (second.conversation) second.conversation = { ...second.conversation, workflowNodeId: 'node-second', agentId: 'agent-second' }
  const posts: Record<string, unknown>[] = []
  server.use(http.get(selectedRoute, ({ params }) => String(params.workflowNodeId) === 'node-second'
    ? HttpResponse.json(envelope(second, execution('run-a', 'execution-run-a', 'node-second')))
    : HttpResponse.json(envelope(source.states.get(String(params.runId))!))),
  http.post(`${selectedRoute}/messages`, async ({ params, request }) => {
    const body = await request.json() as Record<string, unknown>
    if (String(params.workflowNodeId) !== 'node-second') return HttpResponse.json({ error: 'Wrong Agent' }, { status: 400 })
    posts.push(body)
    return HttpResponse.json(admitted(second, body as Parameters<typeof admitted>[1], execution('run-a', 'execution-run-a', 'node-second')))
  }))

  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  client.setQueryData(boardDraftContextKey(scope.workspaceId, scope.workflowId), { draft: { baseWorkflowVersionId: 'version-current' } })
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId', validateSearch: RunsSelectorSearchSchema,
    component: () => <WorkflowBoard {...scope} inspection={{}} selectInspection={() => undefined} selectRun={() => undefined} summaries={[]}>
      <CurrentNavigation />
      <AgentChatPanel name="Current Agent" context={context()} />
    </WorkflowBoard> })
  const router = createRouter({ routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/workspaces/${scope.workspaceId}?workflowId=${scope.workflowId}`] }), defaultPendingMinMs: 0 })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)

  expect(await screen.findByTestId('agent-conversation')).toHaveAttribute('data-chat-key', agentChatContextKey(context()))
  expect(screen.queryByRole('complementary', { name: 'Agent chat' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Runs' }))
  const menu = await screen.findByRole('menu', { name: 'Runs' })
  await userEvent.click(await within(menu).findByRole('menuitemradio', { name: /run-a/i }))

  const panel = await screen.findByRole('complementary', { name: 'Agent chat' })
  const chat = await within(panel).findByRole('region', { name: 'Selected Run chat' })
  expect(chat).toBeInTheDocument()
  const history = within(panel).getByRole('region', { name: 'Run-wide Activities' })
  const activityAgent = await within(history).findByRole('combobox', { name: 'Agent' })
  await userEvent.selectOptions(within(chat).getByRole('combobox', { name: 'Agent' }), 'node-second')
  expect(await within(panel).findByText('Reply execution-run-a')).toBeInTheDocument()
  expect(activityAgent).toHaveValue('')
  await userEvent.type(within(panel).getByRole('textbox', { name: 'Message' }), 'To saved Agent')
  await userEvent.click(within(panel).getByRole('button', { name: 'Send message' }))
  await waitFor(() => expect(posts).toHaveLength(1))
  expect(posts[0]).toMatchObject({ executionId: 'execution-run-a', content: 'To saved Agent' })
  expect(source.current.calls.filter((call) => call.method === 'POST')).toHaveLength(0)

  await userEvent.click(screen.getByRole('button', { name: 'Runs' }))
  await screen.findByRole('menu', { name: 'Runs' })
  await userEvent.click(screen.getByRole('button', { name: 'Return to workflow' }))
  await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Agent chat' })).not.toBeInTheDocument())
  expect(screen.getByTestId('agent-conversation')).toHaveAttribute('data-chat-key', agentChatContextKey(context()))
  expect(screen.queryByText('To saved Agent')).not.toBeInTheDocument()
})

async function mountBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  client.setQueryData(boardDraftContextKey(scope.workspaceId, scope.workflowId), { draft: { baseWorkflowVersionId: 'version-current' } })
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema,
    component: () => <WorkflowBoard {...scope} inspection={{}} selectInspection={() => undefined}
      selectRun={() => undefined} summaries={[]}><CurrentNavigation /><button type="button">Edit workflow</button></WorkflowBoard> })
  const router = createRouter({ routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/workspaces/${scope.workspaceId}?workflowId=${scope.workflowId}`] }),
    defaultPendingMinMs: 0 })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await userEvent.click(await screen.findByRole('button', { name: 'Runs' }))
  const menu = await screen.findByRole('menu', { name: 'Runs' })
  await userEvent.click(await within(menu).findByRole('menuitemradio', { name: /run-a/i }))
  return { client, router }
}

function runHistory(kind: 'job-only' | 'early-failed' | 'mixed') {
  const base = activityPage('run-a')
  const item = (sequence: string, summary: string, facts: Partial<RunActivityPublic> = {}) => ({
    ...base.items[0]!, id: `activity-history-${sequence}`, sequence, summary,
    actor: undefined, kind: 'run', refs: {}, ...facts,
  })
  const items = [item('1', 'Run admitted')]
  if (kind === 'early-failed') {
    items.push(item('2', 'Run failed before execution', { kind: 'error', status: 'failed', severity: 'error' }))
  } else {
    items.push(item('2', 'Build job ran', { kind: 'job_work', refs: { jobExecutionId: 'job-execution' },
      actor: { kind: 'job', nodeId: 'node-job', nodeName: 'Build Job', jobDefinitionId: 'job-build',
        jobDefinitionRevision: 1, jobDefinitionVersionId: 'job-version-pinned' } }))
  }
  if (kind === 'mixed') {
    items.push(item('3', 'Selected Agent ran', { kind: 'agent_work', actor: base.items[0]!.actor,
      refs: { executionId: 'execution-run-a' } }))
    items.push(item('4', 'Other Agent ran', { kind: 'agent_work', refs: { executionId: 'execution-other' },
      actor: { agentId: 'agent-other', agentName: 'Other saved Agent', nodeId: 'node-other', nodeName: 'Other saved Agent' } }))
  }
  return RunActivitiesPageSchema.parse({ ...base, items })
}

function renderedNodeBounds(node: HTMLElement) {
  const viewport = node.closest<HTMLElement>('.react-flow__viewport')!
  const transform = /translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(viewport.style.transform)!
  const zoom = Number(transform[3])
  const bounds = node.getBoundingClientRect()
  const left = Number(transform[1]) + bounds.x * zoom
  const top = Number(transform[2]) + bounds.y * zoom
  return { left, top, right: left + bounds.width * zoom, bottom: top + bounds.height * zoom }
}

it.each([{ width: 1431, height: 1061 }, { width: 320, height: 480 }])(
  'reserves readable transcript space beside long Activities at $width × $height', async ({ width, height }) => {
    installSelectedHandlers()
    installFlowLayout(width, height)
    const history = activityPage('run-a')
    history.items = Array.from({ length: 40 }, (_, index) => ({
      ...history.items[0]!, id: `activity-${index}`, sequence: String(index + 1), summary: `Run event ${index + 1}`,
    }))
    history.highWater = '40'
    server.use(http.get(activitiesRoute, () => HttpResponse.json(RunActivitiesPageSchema.parse(history))))
    render(<style>{boardStyles}{chatStyles}{historyStyles}</style>)
    await mountBoard()

    const panel = screen.getByRole('complementary', { name: 'Agent chat' })
    const activities = within(panel).getByRole('region', { name: 'Run-wide Activities' })
    await within(activities).findByText('Run event 40')
    await within(panel).findByText('Question execution-run-a')
    const transcript = within(panel).getByRole('region', { name: 'Agent conversation transcript' })
    expect(within(transcript).getByText('Reply execution-run-a')).toBeVisible()
    const viewportStyle = getComputedStyle(transcript.parentElement!)
    // jsdom resolves the rendered CSS but does not measure browser geometry.
    const minimumHeight = Number.parseFloat(viewportStyle.minHeight)
      * (viewportStyle.minHeight.endsWith('rem') ? 16 : 1)
    expect(minimumHeight).toBeGreaterThanOrEqual(192)
    expect(viewportStyle.flexShrink).toBe('0')
    expect(getComputedStyle(transcript).overflowY).toBe('auto')
    expect(getComputedStyle(activities.parentElement!).overflow).toBe('auto')
    expect(getComputedStyle(within(panel).getByRole('button', { name: 'Close Selected Run panel' }).parentElement!)
      .flexShrink).toBe('0')
    expect(within(panel).getByRole('textbox', { name: 'Message' })).toBeVisible()

    await userEvent.click(within(panel).getByRole('button', { name: 'Close Selected Run panel' }))
    expect(screen.queryByRole('complementary', { name: 'Agent chat' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Open Selected Run panel' }))
    const reopened = await screen.findByRole('complementary', { name: 'Agent chat' })
    await within(reopened).findByText('Reply execution-run-a')
    const restored = within(reopened).getByRole('region', { name: 'Agent conversation transcript' })
    expect(getComputedStyle(restored.parentElement!).minHeight).toBe(viewportStyle.minHeight)
  },
)

it('keeps the saved Agent and Inspect reachable after desktop resize and Selected Run panel close', async () => {
  installSelectedHandlers()
  server.use(http.get('*/api/management/workspaces/:workspaceId/runs/:runId/subagents', () =>
    HttpResponse.json({ items: [], nextCursor: null, projection: 'caught-up' })),
  http.get('*/api/management/workspaces/:workspaceId/runs/:runId/executions', () =>
    HttpResponse.json({ error: { code: 'DENIED', message: 'No access' } }, { status: 403 })),
  http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/nodes/:nodeId/placement', () =>
    HttpResponse.json({ error: { code: 'DENIED', message: 'No access' } }, { status: 403 })))
  const layout = installFlowLayout(1431, 800)
  await mountBoard()
  const node = await screen.findByRole('group', { name: 'Removed Coder, saved agent, read only' })
  await waitFor(() => expect(renderedNodeBounds(node).left).toBeGreaterThan(320))
  const savedPosition = node.style.transform
  const pane = node.closest('.react-flow')!.querySelector('.react-flow__pane')!
  for (const type of ['mousedown', 'mouseup']) {
    const event = new MouseEvent(type, { bubbles: true, clientX: 200, clientY: 200, button: 0 })
    // jsdom's UIEvent constructor rejects Vitest's Window proxy.
    Object.defineProperty(event, 'view', { value: document.defaultView })
    fireEvent(pane, event)
  }

  act(() => layout.resize(320, 480))
  await userEvent.click(screen.getByRole('button', { name: 'Close Selected Run panel' }))
  expect(screen.queryByRole('complementary', { name: 'Agent chat' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Open Selected Run panel' })).toHaveFocus()
  await waitFor(() => {
    const bounds = renderedNodeBounds(node)
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(320)
    expect(bounds.top).toBeGreaterThanOrEqual(0)
    expect(bounds.bottom).toBeLessThanOrEqual(480)
  })
  expect(node.style.transform).toBe(savedPosition)
  expect(within(node).getByRole('button', { name: 'Inspect Removed Coder' })).toBeEnabled()

  await userEvent.click(screen.getByRole('button', { name: 'Open Selected Run panel' }))
  act(() => layout.resize(280, 480))
  await screen.findByRole('button', { name: 'Close Selected Run panel' })
  await waitFor(() => expect(renderedNodeBounds(node).right).toBeLessThanOrEqual(280))
  await userEvent.click(screen.getByRole('button', { name: 'Close Selected Run panel' }))
  await userEvent.click(within(node).getByRole('button', { name: 'Inspect Removed Coder' }))
  expect(await screen.findByRole('region', { name: 'Run node inspector: Removed Coder' })).toBeInTheDocument()
})

it.each(['Zoom In', 'Zoom Out'])('preserves a saved Run viewport adjusted with %s when resized and the panel closes', async (action) => {
  installSelectedHandlers()
  server.use(http.get('*/api/management/workspaces/:workspaceId/runs/:runId/subagents', () =>
    HttpResponse.json({ items: [], nextCursor: null, projection: 'caught-up' })))
  const layout = installFlowLayout(1431, 800)
  await mountBoard()
  const node = await screen.findByRole('group', { name: 'Removed Coder, saved agent, read only' })
  await waitFor(() => expect(renderedNodeBounds(node).left).toBeGreaterThan(320))
  const viewport = node.closest<HTMLElement>('.react-flow__viewport')!
  await userEvent.click(screen.getByRole('button', { name: action }))
  const expectedZoom = action === 'Zoom In' ? 1.2 : 1 / 1.2
  await waitFor(() => {
    const zoom = Number(/scale\(([-\d.]+)\)/.exec(viewport.style.transform)![1])
    expect(zoom).toBeCloseTo(expectedZoom, 5)
  })
  const adjusted = viewport.style.transform
  act(() => layout.resize(320, 480))
  await userEvent.click(screen.getByRole('button', { name: 'Close Selected Run panel' }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)) })
  expect(viewport.style.transform).toBe(adjusted)
})

it.each(['job-only', 'early-failed', 'mixed'] as const)('shows Run-wide history for a %s Run chosen in the picker', async (kind) => {
  const source = installSelectedHandlers()
  const saved = snapshot('run-a').snapshot
  if (saved.kind !== 'available') throw new Error('Expected available snapshot')
  const job = { kind: 'job', id: 'node-job', name: 'Build Job', jobDefinitionId: 'job-build',
    jobDefinitionRevision: 1, jobDefinitionVersionId: 'job-version-pinned',
    position: { x: 0, y: 0 }, size: { width: 240, height: 100 } }
  const nodes = kind === 'job-only' ? [job] : [...saved.nodes, ...(kind === 'mixed' ? [job, {
    ...saved.nodes[0]!, id: 'node-other', name: 'Other saved Agent', agentId: 'agent-other',
  }] : [])]
  const history = runHistory(kind)
  server.use(http.get(snapshotRoute, () => HttpResponse.json(RunBoardSnapshotGetResultSchema.parse({
    snapshot: { ...saved, nodes },
  }))), http.get(activitiesRoute, () => HttpResponse.json(history)))
  if (kind === 'early-failed') server.use(http.get(selectedRoute, () => HttpResponse.json({
    kind: 'unavailable', reason: 'execution_missing', target: { ...scope, runId: 'run-a', workflowNodeId: nodeId },
  })))
  await mountBoard()
  const runWide = await screen.findByRole('region', { name: 'Run-wide Activities' })
  await within(runWide).findByText('Run admitted')
  for (const event of history.items) expect(within(runWide).getByText(event.summary)).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Selected Run board' })).toHaveTextContent('Read only')
  expect(screen.queryByRole('button', { name: 'Edit workflow' })).toBeNull()
  if (kind === 'job-only') {
    expect(screen.getByText('No agents')).toBeInTheDocument()
    expect(source.reads).toHaveLength(0)
  } else if (kind === 'early-failed') {
    await screen.findByText('Execution unavailable')
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull()
  } else {
    const chat = await screen.findByRole('region', { name: 'Selected Run chat' })
    await within(chat).findByText('Reply execution-run-a')
    const executionFeed = within(chat).getByRole('region', { name: 'Activities' })
    await within(executionFeed).findByText('Selected Agent ran')
    for (const summary of ['Run admitted', 'Build job ran', 'Other Agent ran']) {
      expect(within(executionFeed).queryByText(summary)).toBeNull()
    }
  }
  expect(source.current.calls).toHaveLength(0)
})

it('keeps Run-wide Activities hidden when the selected snapshot is denied', async () => {
  const source = installSelectedHandlers()
  const reads = vi.fn(() => HttpResponse.json(runHistory('mixed')))
  server.use(http.get(snapshotRoute, () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'No access' } }, { status: 403 })),
    http.get(activitiesRoute, reads))
  await mountBoard()
  const runWide = await screen.findByRole('region', { name: 'Run-wide Activities' })
  await within(runWide).findByText('No access')
  expect(within(runWide).queryByText('Run admitted')).toBeNull()
  expect(reads).not.toHaveBeenCalled()
  expect(source.reads).toHaveLength(0)
})
