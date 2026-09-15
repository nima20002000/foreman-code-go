import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type HarnessDefaults, type WorkflowDefinition } from '@graphql/contracts'

import { queryKeys } from '../../shared/api/query'
import { useAgentDirectoryStore } from '../agents/agentDirectoryStore'
import { defaultAgentForHarness } from '../agents/agentSettings'
import { AgentSettingsForm, GraphEditor, type GraphEditorProps } from './GraphEditor'
import { getGraphDraft, useGraphDraftStore, workflowDraftKey } from './store'
import type { GraphNode } from './types'

type SaveGraph = ReturnType<typeof import('../../shared/api/query').useSaveGraphMutation>['mutateAsync']
type SaveInput = Parameters<SaveGraph>[0]
type SaveResponse = Awaited<ReturnType<SaveGraph>>
const { saveGraph, canvas } = vi.hoisted(() => ({
  saveGraph: vi.fn<SaveGraph>(),
  canvas: { nodes: [] as GraphNode[] },
}))

vi.mock('../../shared/api/query', async () => {
  const actual = await vi.importActual<typeof import('../../shared/api/query')>('../../shared/api/query')
  return { ...actual, useSaveGraphMutation: () => useMutation({ mutationFn: (input: SaveInput) => saveGraph(input) }) }
})

// Keep layout/measurement out of state-lifetime tests. The editor, picker,
// settings form, draft store, and asynchronous mutation lifecycle are real.
vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react')
  return {
    ...actual,
    ReactFlow: ({ nodes, children }: { nodes: GraphNode[]; children?: ReactNode }) => {
      canvas.nodes = nodes
      return <div>{children}</div>
    },
    Background: () => null,
    MiniMap: () => null,
  }
})

const workflow: WorkflowDefinition = {
  id: 'workflow-pr3', workspaceId: 'workspace-pr3', name: 'Regression workflow',
  executionCondition: { kind: 'manual' }, nodes: [], edges: [],
}
const key = workflowDraftKey(workflow.workspaceId, workflow.id)
const defaults: HarnessDefaults = {
  codex: { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'workspace-write', serviceTier: 'priority', reasoningEffort: 'high' },
  opencode: { ...DEFAULT_HARNESS_DEFAULTS.opencode, nativeAgent: 'plan', thinking: true, variant: 'low' },
}
const clients: QueryClient[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function response(input: SaveInput, version = 1): SaveResponse {
  return {
    workflow: { ...input.workflow, version },
    agents: (input.agents ?? []).map((agent) => ({ ...agent, configurationVersionId: `${agent.id}-config-${version}` })),
  }
}

function client() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queryKeys.harnessDefaults, { defaults })
  clients.push(queryClient)
  return queryClient
}

function editor(queryClient: QueryClient, props: Partial<GraphEditorProps> = {}, mountKey = 'draft') {
  return (
    <QueryClientProvider client={queryClient}>
      <GraphEditor key={mountKey} workspaceId={workflow.workspaceId} workflow={workflow} agents={[]} {...props} />
    </QueryClientProvider>
  )
}

async function addAgent(user: ReturnType<typeof userEvent.setup>, harness: 'Codex' | 'OpenCode') {
  await user.click(screen.getByRole('button', { name: 'Add agent to graph' }))
  await user.click(await screen.findByRole('button', { name: harness, exact: true }))
  const form = within(screen.getByRole('dialog', { name: 'Configure agent' }))
  await user.type(form.getByRole('textbox', { name: 'Initial prompt' }), 'Keep this instruction.')
  await user.click(form.getByRole('button', { name: 'Save agent settings' }))
  return Object.values(getGraphDraft(key)!.agentOverrides)[0]!
}

beforeEach(() => {
  saveGraph.mockReset()
  saveGraph.mockImplementation(async (input) => response(input))
})

afterEach(() => {
  cleanup()
  for (const queryClient of clients.splice(0)) queryClient.clear()
  useGraphDraftStore.getState().clearAllDrafts()
  useAgentDirectoryStore.getState().reset()
  sessionStorage.clear()
})

describe('PR #3 editor lifecycle regressions', () => {
  it('submits unchanged OpenCode settings and the prompt after unmounting and remounting', async () => {
    const user = userEvent.setup()
    const queryClient = client()
    const first = render(editor(queryClient))
    const agent = await addAgent(user, 'OpenCode')
    expect(agent.harnessConfiguration).toEqual(defaults.opencode)
    first.unmount()
    render(editor(queryClient))
    await user.click(screen.getByRole('button', { name: 'Save graph' }))
    await waitFor(() => expect(saveGraph).toHaveBeenCalledOnce())
    const sent = saveGraph.mock.calls[0]![0]
    expect(sent.agents).toEqual([agent])
    expect(sent.workflow.nodes[0]?.initialPrompt).toBe('Keep this instruction.')
    await waitFor(() => expect(getGraphDraft(key)).toBeUndefined())
  })

  it('keeps settings edited during a save across first-save promotion, then submits the new base version', async () => {
    const pending = deferred<SaveResponse>()
    saveGraph.mockImplementationOnce(() => pending.promise)
    const user = userEvent.setup()
    const queryClient = client()
    const view = render(editor(queryClient))
    const agent = await addAgent(user, 'Codex')
    await user.click(screen.getByRole('button', { name: 'Save graph' }))
    await waitFor(() => expect(saveGraph).toHaveBeenCalledOnce())
    const node = canvas.nodes[0]!
    const edited = {
      ...agent, model: 'gpt-5.6-terra',
      harnessConfiguration: { ...defaults.codex, model: 'gpt-5.6-terra' },
    }
    act(() => node.data.onSaveSettings?.(node.data.workflowNodeId, edited, node.data.initialPrompt))
    const saved = response(saveGraph.mock.calls[0]![0])
    await act(async () => { pending.resolve(saved); await pending.promise })
    await waitFor(() => expect(getGraphDraft(key)?.agentOverrides[agent.id]).toMatchObject({
      model: 'gpt-5.6-terra', configurationVersionId: `${agent.id}-config-1`,
    }))
    expect(screen.getByText('Graph saved. Newer local changes remain unsaved.')).toBeInTheDocument()
    view.rerender(editor(queryClient, { workflow: saved.workflow, agents: saved.agents ?? [] }, 'persisted'))
    expect(getGraphDraft(key)?.agentOverrides[agent.id]?.model).toBe('gpt-5.6-terra')
    saveGraph.mockImplementationOnce(async (input) => response(input, 2))
    await user.click(screen.getByRole('button', { name: 'Save graph' }))
    await waitFor(() => expect(saveGraph).toHaveBeenCalledTimes(2))
    expect(saveGraph.mock.calls[1]![0].agents?.[0]).toMatchObject({
      model: 'gpt-5.6-terra', configurationVersionId: `${agent.id}-config-1`,
    })
    await waitFor(() => expect(getGraphDraft(key)).toBeUndefined())
  })

  it('finishes the save and promotion when navigation unmounts the editor during the request', async () => {
    const pending = deferred<SaveResponse>()
    saveGraph.mockImplementationOnce(() => pending.promise)
    const user = userEvent.setup()
    const onPersisted = vi.fn()
    const view = render(editor(client(), { onPersisted }))
    await addAgent(user, 'Codex')
    await user.click(screen.getByRole('button', { name: 'Save graph' }))
    await waitFor(() => expect(saveGraph).toHaveBeenCalledOnce())
    view.unmount()
    const saved = response(saveGraph.mock.calls[0]![0])
    await act(async () => { pending.resolve(saved); await pending.promise })
    await waitFor(() => expect(getGraphDraft(key)).toBeUndefined())
    expect(onPersisted).toHaveBeenCalledWith(saved.workflow)
  })

  it.each(['codex', 'opencode'] as const)('copies every saved %s setting when switching harnesses in the creation form', async (target) => {
    const source = target === 'codex' ? 'opencode' : 'codex'
    const onSave = vi.fn()
    render(<AgentSettingsForm
      agent={defaultAgentForHarness(source, 'agent-new', 'New agent', defaults[source])}
      creationDefaults={defaults}
      onClose={() => undefined}
      onSave={onSave}
    />)
    const user = userEvent.setup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Harness' }), target)
    await user.click(screen.getByRole('button', { name: 'Save agent settings' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ harnessConfiguration: defaults[target] }), undefined)
  })
})
