import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type WorkflowDefinition } from '@graphql/contracts'
import { AgentSettingsForm } from './AgentSettingsForm'
import { GraphEditor } from './GraphEditor'
import { defaultAgentForHarness } from '../agents/agentSettings'
import { useGraphDraftStore } from './store'

vi.mock('@tanstack/react-router', async (original) => ({ ...await original<typeof import('@tanstack/react-router')>(),
  Link: ({ children, className, 'aria-label': label }: { children?: ReactNode; className?: string; 'aria-label'?: string }) => <a href="#" className={className} aria-label={label}>{children}</a>,
}))
const clients: QueryClient[] = []
function withQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
}
const agent = defaultAgentForHarness('codex', 'agent-one', 'Researcher', DEFAULT_HARNESS_DEFAULTS.codex)
const workflow: WorkflowDefinition = { id: 'workflow-pr17', workspaceId: 'workspace-1', name: 'Settings test',
  executionCondition: { kind: 'manual' }, nodes: [{ id: 'step-one', agentId: agent.id, name: agent.name, position: { x: 80, y: 100 } }], edges: [] }
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); useGraphDraftStore.getState().clearAllDrafts(); vi.unstubAllGlobals() })
describe('PR17 graph editing surfaces', () => {
  it('keeps the common settings compact and moves the remaining controls into the advanced view', () => {
    withQuery(<AgentSettingsForm agent={agent} workspaceId="workspace-1" onClose={vi.fn()} onSave={vi.fn()} />)
    expect(screen.getByLabelText('Name').closest('.agent-settings-row')).toHaveClass('agent-settings-row-primary')
    expect(screen.getByLabelText('Effort').closest('.agent-settings-row')).toHaveClass('agent-settings-row-runtime')
    expect(screen.queryByLabelText('Initial prompt')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save agent settings' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated researcher' } })
    expect(screen.getByRole('button', { name: 'Save agent settings' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save agent settings' }).closest('header')).toHaveClass('agent-settings-heading')
    fireEvent.click(screen.getByRole('button', { name: /^Advanced settings/ }))
    expect(screen.getByLabelText('Initial prompt')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'App MCP detection' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check selected configuration' })).not.toBeInTheDocument()
  })
  it('coordinates Workflow settings with Add Agent and restores focus on Escape', async () => {
    withQuery(<GraphEditor workspaceId="workspace-1" workflow={workflow} agents={[agent]} />)
    const trigger = screen.getByRole('button', { name: 'Workflow settings' })
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Close workflow settings' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close workflow settings' }), { key: 'Escape' })
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('dialog', { name: 'Workflow settings' })).not.toBeInTheDocument()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Add agent to graph' }))
    expect(screen.queryByRole('dialog', { name: 'Workflow settings' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Add Agent' })).toBeInTheDocument()
  })
  it('portals the inspector out of the clipped canvas and isolates graph hotkeys', async () => {
    const { container } = withQuery(<GraphEditor workspaceId="workspace-1" workflow={workflow} agents={[agent]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open actions for Researcher' }))
    const inspector = await screen.findByRole('dialog', { name: 'Researcher settings' })
    expect(inspector.parentElement).toBe(document.body)
    expect(container.contains(inspector)).toBe(false)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close agent settings' }), { key: 'Delete' })
    expect(screen.getByTestId('agent-node-agent-one')).toBeInTheDocument()
    await act(async () => { fireEvent.keyDown(screen.getByRole('button', { name: 'Close agent settings' }), { key: 'Escape' }) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open actions for Researcher' })).toHaveFocus())
  })
})
