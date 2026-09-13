import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import type { Agent } from '@graphql/contracts'

import { AgentsDirectoryContent } from './AgentsDirectory'

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
    expect(screen.getByText('Finds and summarizes source material.')).toBeVisible()
    expect(screen.getByText('Workspace data')).toBeVisible()
    expect(screen.getByText('Available')).toBeVisible()
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
    expect(screen.getByText('Local session')).toBeVisible()
    expect(screen.getByText('Not connected')).toBeVisible()
    expect(sessionStorage.getItem('graphql-local-agents:workspace-1')).toContain('Planner')
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
})
