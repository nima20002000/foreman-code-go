import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Agent } from '@graphql/contracts'

import { AgentsDirectoryContent } from './AgentsDirectory'
import { deleteAgentForSession, writeLocalAgents } from './localAgents'

const agents: Agent[] = [
  {
    id: 'agent-researcher',
    name: 'Researcher',
    role: 'researcher',
    description: 'Finds and summarizes source material.',
    executionState: 'available',
    model: 'gpt-test',
  },
]

afterEach(() => sessionStorage.clear())

describe('AgentsDirectoryContent', () => {
  it('renders existing contract-shaped agents as directory cards', () => {
    render(<AgentsDirectoryContent workspaceId="workspace-1" agents={agents} />)

    expect(screen.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Researcher' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Researcher, researcher, Available' })).toBeVisible()
    expect(screen.getByText('researcher · Available')).toBeVisible()
    expect(screen.queryByText('Finds and summarizes source material.')).not.toBeInTheDocument()
    expect(screen.queryByText('Workspace data')).not.toBeInTheDocument()
  })

  it('validates and adds a clearly local session agent through the modal form', async () => {
    const user = userEvent.setup()
    render(<AgentsDirectoryContent workspaceId="workspace-1" agents={agents} />)

    await user.click(screen.getByRole('button', { name: 'Add agent' }))
    const name = screen.getByRole('textbox', { name: 'Name' })
    expect(name).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Add local agent' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required.')
    expect(name).toHaveAttribute('aria-invalid', 'true')

    await user.type(name, 'Planner')
    await user.type(screen.getByRole('textbox', { name: /Role/ }), 'planning')
    await user.type(screen.getByRole('textbox', { name: /Description/ }), 'Creates implementation plans.')
    await user.click(screen.getByRole('button', { name: 'Add local agent' }))

    expect(screen.getByRole('heading', { name: 'Planner' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Planner, planning, Local session' })).toBeVisible()
    expect(screen.getByText('planning · Local session')).toBeVisible()
    expect(sessionStorage.getItem('graphql-local-agents:workspace-1')).toContain('Planner')
  })

  it('exposes single selection through an accessible card button for mouse and keyboard', async () => {
    const onSelectAgent = vi.fn()
    const onClearAgent = vi.fn()
    const user = userEvent.setup()
    const view = render(
      <AgentsDirectoryContent
        workspaceId="workspace-1"
        agents={agents}
        onSelectAgent={onSelectAgent}
        onClearAgent={onClearAgent}
      />,
    )
    const card = screen.getByRole('button', { name: 'Researcher, researcher, Available' })

    await user.click(card)
    expect(onSelectAgent).toHaveBeenLastCalledWith('agent-researcher')
    card.focus()
    await user.keyboard('{Enter}')
    expect(onSelectAgent).toHaveBeenCalledTimes(2)

    view.rerender(
      <AgentsDirectoryContent
        workspaceId="workspace-1"
        agents={agents}
        selectedAgentId="agent-researcher"
        onSelectAgent={onSelectAgent}
        onClearAgent={onClearAgent}
      />,
    )
    expect(card).toHaveAttribute('aria-pressed', 'true')
    expect(card).toHaveAttribute('data-selected', 'true')
    expect(screen.getByRole('dialog', { name: 'Researcher' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close agent details' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(onClearAgent).toHaveBeenCalledOnce()
  })

  it('keeps detail-dialog inside clicks open and dismisses from its backdrop', () => {
    const onClearAgent = vi.fn()
    const { container } = render(
      <AgentsDirectoryContent
        workspaceId="workspace-1"
        agents={agents}
        selectedAgentId="agent-researcher"
        onClearAgent={onClearAgent}
      />,
    )
    const dialog = screen.getByRole('dialog', { name: 'Researcher' })
    fireEvent.mouseDown(dialog)
    expect(onClearAgent).not.toHaveBeenCalled()

    const backdrop = container.querySelector('.agent-detail-backdrop')
    if (!backdrop) throw new Error('Agent detail backdrop missing')
    fireEvent.mouseDown(backdrop)
    expect(onClearAgent).toHaveBeenCalledOnce()
  })

  it('dismisses the add modal from its backdrop, close control, or Escape and restores focus', async () => {
    const user = userEvent.setup()
    const { container } = render(<AgentsDirectoryContent workspaceId="workspace-1" agents={agents} />)
    const add = screen.getByRole('button', { name: 'Add agent' })

    await user.click(add)
    const dialog = screen.getByRole('dialog', { name: 'Add a local agent' })
    fireEvent.mouseDown(dialog)
    expect(dialog).toBeVisible()

    const backdrop = container.querySelector('.agent-add-backdrop')
    if (!backdrop) throw new Error('Add-agent backdrop missing')
    fireEvent.mouseDown(backdrop)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(add).toHaveFocus()

    await user.click(add)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(add).toHaveFocus()

    await user.click(add)
    await user.click(screen.getByRole('button', { name: 'Close add agent' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(add).toHaveFocus()
  })

  it('teaches the session-only path when there are no agents', () => {
    render(<AgentsDirectoryContent workspaceId="workspace-empty" agents={[]} />)

    expect(screen.getByTestId('agents-empty')).toHaveTextContent('No agents yet')
    expect(screen.getByTestId('agents-empty')).toHaveTextContent('Persistent agent creation is not available in Phase 1')
  })

  it('hides session-deleted workspace and local agents across remounts', () => {
    writeLocalAgents('workspace-1', [{ id: 'agent-planner', name: 'Planner' }])
    deleteAgentForSession('workspace-1', 'agent-researcher')
    deleteAgentForSession('workspace-1', 'agent-planner')

    const first = render(<AgentsDirectoryContent workspaceId="workspace-1" agents={agents} />)
    expect(screen.queryByRole('heading', { name: 'Researcher' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Planner' })).not.toBeInTheDocument()
    expect(screen.getByTestId('agents-empty')).toHaveTextContent('No agents yet')

    first.unmount()
    render(<AgentsDirectoryContent workspaceId="workspace-1" agents={agents} />)
    expect(screen.queryByRole('heading', { name: 'Researcher' })).not.toBeInTheDocument()
    expect(sessionStorage.getItem('graphql-local-agents:workspace-1')).not.toContain('Planner')
  })
})
