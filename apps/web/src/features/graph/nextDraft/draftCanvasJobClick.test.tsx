import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { definition } from '../../jobs/fixtures'
import { GraphPresentationProvider } from '../GraphPresentation'
import { useGraphDraftStore } from '../store'
import { fixture } from './core.cases'
import { DraftCanvas } from './DraftCanvas'
import { attachJob } from './model'
import { nextDraftKey } from './state'

// Real React Flow node-wrapper bubbling: DraftCanvas is not stubbed.
const key = nextDraftKey('workspace', 'workflow')
const context = fixture()
const graph = attachJob(context.draft.graph, { ...definition, workspaceId: 'workspace' }, 'job-node')
beforeEach(() => { useGraphDraftStore.getState().installNextDraft(key, structuredClone(context)) })
afterEach(() => { cleanup(); useGraphDraftStore.getState().clearAllDrafts() })

function mount() {
  const change = vi.fn()
  render(<GraphPresentationProvider><DraftCanvas draftKey={key} graph={graph} agents={context.agents.map((item) => item.agent)} kind="execution"
    change={change} geometry={vi.fn()} pending={vi.fn()} report={vi.fn()} /></GraphPresentationProvider>)
  const job = () => screen.getByRole('button', { name: new RegExp(`${definition.name}, job`) })
  const agent = (index: number) => screen.getByRole('button', { name: new RegExp(`^Node ${index}, `) })
  const edges = () => change.mock.calls.map(([update]) => update(graph).edges.at(-1)).map((edge: { source: string; target: string }) => `${edge.source}>${edge.target}`)
  return { change, job, agent, edges }
}

it('connects Job to Agent with one selection per click', async () => {
  const { job, agent, edges, change } = mount()
  await userEvent.click(job())
  await userEvent.click(agent(1))
  expect(change).toHaveBeenCalledOnce()
  expect(edges()).toEqual(['job-node>node-1'])
})

it('connects Agent to Job and does not rearm the Job', async () => {
  const { job, agent, edges, change } = mount()
  await userEvent.click(agent(0))
  await userEvent.click(job())
  expect(change).toHaveBeenCalledOnce()
  expect(edges()).toEqual(['node-0>job-node'])
  await userEvent.click(agent(1))
  expect(change).toHaveBeenCalledOnce()
})
