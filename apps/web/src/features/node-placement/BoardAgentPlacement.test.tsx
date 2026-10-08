import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { ApiError } from '../../shared/api/client'
import { BoardAgentSettings } from '../workflow-board/AgentControls'
import { fixture } from '../graph/nextDraft/core.cases'
import { useGraphDraftStore } from '../graph/store'
import * as client from './client'
import { savedPlacementFixture as placement } from './fixtures'

it('Board Apply changes the exact node draft while keeping saved placement and other nodes separate', async () => {
  const context = fixture(), key = 'placement-apply-test'
  useGraphDraftStore.getState().installNextDraft(key, context)
  const read = vi.spyOn(client, 'readPlacementChoices').mockResolvedValue({ workspaceId: 'workspace', workflowId: 'workflow', nodeId: 'node-0', agentConfigurationVersionId: 'configuration-0',
    choices: [{ id: 'choice-laptop', label: 'Laptop', placement, availability: 'ready', reason: null }] })
  function Board() {
    const edit = useGraphDraftStore((state) => state.nextDrafts[key])!
    return <BoardAgentSettings draftKey={key} edit={edit} nodeId="node-0" close={() => undefined} />
  }
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={query}><Board /></QueryClientProvider>)
  await screen.findByRole('option', { name: 'Laptop' })
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), '0')
  const before = useGraphDraftStore.getState().nextDrafts[key]!
  expect(nativeNode(before.graph.nodes[0])?.placement).toBeUndefined()
  expect(before.agentForms?.['node-0']?.placement).toEqual(placement)
  expect(screen.getByText(/Editing computer choice/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Save agent settings' }))
  const applied = useGraphDraftStore.getState().nextDrafts[key]!
  expect(nativeNode(applied.graph.nodes[0])?.placement).toEqual(placement)
  expect(screen.getByText(/Applied to draft — Save graph/)).toBeInTheDocument()
  expect(nativeNode(applied.graph.nodes[1])?.placement).toBeUndefined()
  expect(nativeNode(applied.context.draft.graph.nodes[0])?.placement).toBeUndefined()
  expect(applied.agentForms?.['node-0']).toBeUndefined()
  view.unmount(); query.clear(); read.mockRestore(); useGraphDraftStore.getState().dropNextDraft(key)
})

it('keeps computer selection on the clicked node when two nodes share one Agent', async () => {
  const context = fixture(), key = 'shared-agent-placement-test'
  const original = nativeNode(context.draft.graph.nodes[0])!
  const sibling = { ...original, id: 'same-agent-second-node', position: { x: 500, y: 0 } }
  context.draft.graph = { ...context.draft.graph, nodes: [...context.draft.graph.nodes, sibling] }
  useGraphDraftStore.getState().installNextDraft(key, context)
  const read = vi.spyOn(client, 'readPlacementChoices').mockImplementation(async scope => ({ ...scope,
    choices: [{ id: 'choice-laptop', label: 'Laptop', placement, availability: 'ready', reason: null }] }))
  function Board() {
    const edit = useGraphDraftStore(state => state.nextDrafts[key])!
    return <BoardAgentSettings draftKey={key} edit={edit} nodeId={sibling.id} close={() => undefined} />
  }
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={query}><Board /></QueryClientProvider>)
  await screen.findByRole('option', { name: 'Laptop' })
  expect(read.mock.calls[0]?.[0].nodeId).toBe(sibling.id)
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), '0')
  expect(useGraphDraftStore.getState().nextDrafts[key]?.agentForms?.[sibling.id]?.placement).toEqual(placement)
  expect(useGraphDraftStore.getState().nextDrafts[key]?.agentForms?.[original.id]).toBeUndefined()
  await userEvent.click(screen.getByRole('button', { name: 'Save agent settings' }))
  const applied = useGraphDraftStore.getState().nextDrafts[key]!
  expect(nativeNode(applied.graph.nodes.find(node => node.id === sibling.id))?.placement).toEqual(placement)
  expect(nativeNode(applied.graph.nodes.find(node => node.id === original.id))?.placement).toBeUndefined()
  expect(nativeNode(applied.context.draft.graph.nodes.find(node => node.id === sibling.id))?.placement).toBeUndefined()
  view.unmount(); query.clear(); read.mockRestore(); useGraphDraftStore.getState().dropNextDraft(key)
})

it('applies inherited Main by removing only the selected node placement from the draft', async () => {
  const context = fixture()
  const key = 'placement-clear-test'
  context.draft.graph.nodes = context.draft.graph.nodes.map(node => ({ ...node, placement }))
  useGraphDraftStore.getState().installNextDraft(key, context)
  const read = vi.spyOn(client, 'readPlacementChoices').mockImplementation(async scope => ({ ...scope,
    choices: [{ id: 'choice-laptop', label: 'Laptop', placement, availability: 'ready', reason: null }] }))
  function Board() {
    const edit = useGraphDraftStore(state => state.nextDrafts[key])!
    return <BoardAgentSettings draftKey={key} edit={edit} nodeId="node-0" close={() => undefined} />
  }
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={query}><Board /></QueryClientProvider>)
  await screen.findByRole('option', { name: 'Laptop' })
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), 'inherited')
  expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]).placement).toEqual(placement)
  await userEvent.click(screen.getByRole('button', { name: 'Save agent settings' }))
  const applied = useGraphDraftStore.getState().nextDrafts[key]!
  expect(applied.graph.nodes[0]).not.toHaveProperty('placement')
  expect(nativeNode(applied.graph.nodes[1]).placement).toEqual(placement)
  expect(nativeNode(applied.context.draft.graph.nodes[0]).placement).toEqual(placement)
  view.unmount()
  query.clear()
  read.mockRestore()
  useGraphDraftStore.getState().dropNextDraft(key)
})

it('keeps unrelated Agent edits when placement choices are denied for a saved placed node', async () => {
  const context = fixture(), key = 'placement-denied-retains-edits'
  context.draft.graph = { ...context.draft.graph, nodes: context.draft.graph.nodes.map((node, index) => index ? node : { ...nativeNode(node)!, placement }) }
  useGraphDraftStore.getState().installNextDraft(key, context)
  let deny!: () => void
  const read = vi.spyOn(client, 'readPlacementChoices').mockImplementation(() => new Promise((_, reject) => { deny = () => reject(new ApiError({ code: 'FORBIDDEN', message: 'Forbidden' }, 403)) }))
  function Board() {
    const edit = useGraphDraftStore((state) => state.nextDrafts[key])!
    return <BoardAgentSettings draftKey={key} edit={edit} nodeId="node-0" close={() => undefined} />
  }
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={query}><Board /></QueryClientProvider>)
  await userEvent.clear(screen.getByRole('textbox', { name: 'Name' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Renamed')
  expect(useGraphDraftStore.getState().nextDrafts[key]?.agentForms?.['node-0']?.name).toBe('Renamed')
  await act(async () => { deny() })
  await screen.findByText('Computer choices are unavailable.')
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Renamed')
  await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), '!')
  const form = useGraphDraftStore.getState().nextDrafts[key]?.agentForms?.['node-0']
  expect(form).toMatchObject({ name: 'Renamed!' })
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Renamed!')
  view.unmount(); query.clear(); read.mockRestore(); useGraphDraftStore.getState().dropNextDraft(key)
})
