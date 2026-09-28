// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { AgentChatPanel } from '../graph/AgentPanels'
import { installFlowLayout } from '../run-board/testFlowLayout'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { useRunsSelectorUi } from '../runs-selector/uiStore'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { installChatSource } from '../conversations/agentChat/testSupport'
import { agentChatContextKey } from '../conversations/agentChat/model'
import { admitted, clients, context, envelope, execution, historicalState, installSelectedHandlers,
  scope, selectedRoute, snapshot, snapshotRoute } from '../conversations/agentChat/sch10.testSupport'
import { boardDraftContextKey } from './keys'
import { WorkflowBoard } from './WorkflowBoard'

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
  expect(await within(panel).findByRole('region', { name: 'Selected Run chat' })).toBeInTheDocument()
  await userEvent.selectOptions(within(panel).getByRole('combobox', { name: 'Agent' }), 'node-second')
  expect(await within(panel).findByText('Reply execution-run-a')).toBeInTheDocument()
  await userEvent.type(within(panel).getByRole('textbox', { name: 'Message' }), 'To saved Agent')
  await userEvent.click(within(panel).getByRole('button', { name: 'Send message' }))
  await waitFor(() => expect(posts).toHaveLength(1))
  expect(posts[0]).toMatchObject({ executionId: 'execution-run-a', content: 'To saved Agent' })
  expect(source.current.calls.filter((call) => call.method === 'POST')).toHaveLength(0)

  await userEvent.click(screen.getByRole('button', { name: 'Runs' }))
  await userEvent.click(within(await screen.findByRole('menu', { name: 'Runs' })).getByRole('menuitemradio', { name: 'Current workflow' }))
  await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Agent chat' })).not.toBeInTheDocument())
  expect(screen.getByTestId('agent-conversation')).toHaveAttribute('data-chat-key', agentChatContextKey(context()))
  expect(screen.queryByText('To saved Agent')).not.toBeInTheDocument()
})
