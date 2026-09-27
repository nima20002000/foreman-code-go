import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { UnsavedChangesContext, type EditorRegistration } from '../../../shared/ui/unsavedChanges'
import { useGraphDraftStore } from '../store'
import { nextDraftKey } from './state'
import { fixture } from './core.cases'
import { NextDraftEditor } from './NextDraftEditor'
import { queryKeys } from '../../../shared/api/query'

async function confirmDiscard(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Discard changes$/ }))
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }))
}
// Form/registration tests. This is not React Flow or authenticated browser evidence.
vi.mock('./DraftCanvas', () => ({ DraftCanvas: ({ open, panels }: { open?: { nodeId: string; panel: 'chat' | 'settings' | 'info' }; panels?: (nodeId: string) => Record<string, unknown> }) => <div>Canvas fixture{open && panels
  ? <section role="dialog" aria-label={`${open.nodeId} ${open.panel}`}>{panels(open.nodeId)[open.panel] as never}</section> : null}</div> }))
vi.mock('../../../shared/api/query', async (original) => ({
  ...await original<typeof import('../../../shared/api/query')>(),
  useInteractionsQuery: () => ({ data: { items: [] } }),
}))
const key = nextDraftKey('workspace', 'workflow')
beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts()
  const queues = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, work: () => unknown) => {
    const result = (queues.get(name) ?? Promise.resolve()).then(work)
    queues.set(name, result.catch(() => undefined))
    return result
  } } })
})
afterEach(() => { cleanup(); useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks() })

function readyClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.managedWorkspace('workspace'), { workspace: { id: 'workspace', name: 'Fixture' },
    locationRevision: 1, locationValidation: { status: 'ready', checkedAt: '2026-09-23T00:00:00.000Z' } })
  return client
}
it('registers local form dirtiness and discard with the existing navigation guard', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const registrations = new Map<string, EditorRegistration>()
  const guard = { changed: vi.fn(), surfaces: async () => true, request: async () => true,
    register: (id: string, editor: EditorRegistration) => { registrations.set(id, editor); return () => { registrations.delete(id) } } }
  const user = userEvent.setup(), client = readyClient()
  render(<QueryClientProvider client={client}><UnsavedChangesContext.Provider value={guard}>
    <NextDraftEditor workspaceId="workspace" workflowId="workflow" />
  </UnsavedChangesContext.Provider></QueryClientProvider>)
    await user.click(screen.getByRole('button', { name: /Entry · Node 0/ }))
  const panel = await screen.findByRole('dialog', { name: /settings$/ })
  const name = within(panel).getByRole('textbox', { name: 'Name' }), original = (name as HTMLInputElement).value
  await user.clear(name); await user.type(name, 'Unsaved name')
  await user.click(within(panel).getByRole('button', { name: 'Save agent settings' }))
  const registered = [...registrations.values()].find((item) => item.current.label.endsWith('next draft'))!
  expect(registered.current.dirty).toBe(true)
  await act(async () => { await registered.current.discard() })
  expect(within(screen.getByRole('dialog', { name: /settings$/ })).getByRole('textbox', { name: 'Name' })).toHaveValue(original)
  expect(registered.current.dirty).toBe(false)
})
it('discarding a semantic edit preserves independent node layout', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const client = readyClient(), user = userEvent.setup()
  render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
  const position = { x: 615, y: -90 }
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, position, initialPrompt: 'Unpublished instruction' } : node),
  })))
  await confirmDiscard(user)
  const draft = useGraphDraftStore.getState().nextDrafts[key]!
  expect(draft.graph.nodes[0]?.initialPrompt).toBeUndefined()
  expect(draft.graph.nodes[0]?.position).toEqual(position)
  expect(draft.context.draft.revision).toBe(7)
})
it('principal teardown purges the unified local draft store', () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  useGraphDraftStore.getState().clearAllDrafts()
  expect(useGraphDraftStore.getState().nextDrafts).toEqual({})
})

it.each(['navigation', 'reload'])('quietly retains unfinished agent settings across %s', async (departure) => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const registrations = new Map<string, EditorRegistration>()
  const guard = { changed: vi.fn(), surfaces: async () => true, request: async () => true,
    register: (id: string, editor: EditorRegistration) => { registrations.set(id, editor); return () => { registrations.delete(id) } } }
  const user = userEvent.setup(), client = readyClient()
  const mount = () => render(<QueryClientProvider client={client}><UnsavedChangesContext.Provider value={guard}>
    <NextDraftEditor workspaceId="workspace" workflowId="workflow" />
  </UnsavedChangesContext.Provider></QueryClientProvider>)
  const first = mount()
  await user.click(screen.getByRole('button', { name: /Entry · Node 0/ }))
  const name = within(await screen.findByRole('dialog', { name: /settings$/ })).getByRole('textbox', { name: 'Name' })
  await user.clear(name); await user.type(name, 'Continue here')
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, description: 'Local workflow edit' })))
  const form = [...registrations.values()].find((entry) => entry.current.label === 'agent settings')!
  expect(form.current.dirty).toBe(true)
  expect(form.current.canResume?.()).toBe(true)
  first.unmount()
  if (departure === 'reload') useGraphDraftStore.setState({ nextDrafts: {} })
  mount()
  await user.click(await screen.findByRole('button', { name: /Entry · Node 0/ }))
  expect(within(await screen.findByRole('dialog', { name: /settings$/ })).getByRole('textbox', { name: 'Name' })).toHaveValue('Continue here')
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(screen.queryByText(/Draft restored/)).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Save agent settings' }))
  const draft = useGraphDraftStore.getState().nextDrafts[key]!
  expect(draft.graph.nodes[0]?.name).toBe('Continue here')
  expect(draft.graph.description).toBe('Local workflow edit')
  expect(draft.context.draft.revision).toBe(7)
})

it('keeps protection when local storage fails', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const registrations = new Map<string, EditorRegistration>()
  const guard = { changed: vi.fn(), surfaces: async () => true, request: async () => true,
    register: (id: string, editor: EditorRegistration) => { registrations.set(id, editor); return () => { registrations.delete(id) } } }
  render(<QueryClientProvider client={readyClient()}><UnsavedChangesContext.Provider value={guard}>
    <NextDraftEditor workspaceId="workspace" workflowId="workflow" />
  </UnsavedChangesContext.Provider></QueryClientProvider>)
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, name: 'Unpublished name' })))
  const board = [...registrations.values()].find((entry) => entry.current.label.endsWith('next draft'))!
  expect(board.current.canResume?.()).toBe(true)
  const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
  expect(board.current.canResume?.()).toBe(false)
  fail.mockRestore()
})
