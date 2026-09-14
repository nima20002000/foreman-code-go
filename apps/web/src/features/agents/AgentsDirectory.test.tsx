import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Agent } from '@graphql/contracts'

import { renderWithRouter } from '../../test/renderWithRouter'
import { AgentsDirectoryContent } from './AgentsDirectory'
import { AgentNavigation } from './AgentNavigation'
import { useAgentDirectoryStore } from './agentDirectoryStore'
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

const reorderAgents: Agent[] = [
  ...agents,
  {
    id: 'agent-builder',
    name: 'Builder',
    role: 'builder',
    executionState: 'available',
    model: 'gpt-test',
  },
  {
    id: 'agent-reviewer',
    name: 'Reviewer',
    role: 'reviewer',
    executionState: 'available',
    model: 'gpt-test',
  },
]

afterEach(() => {
  sessionStorage.clear()
  useAgentDirectoryStore.getState().reset()
})

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

  it('updates the workspace agent submenu reactively after local add and delete', async () => {
    const user = userEvent.setup()
    renderWithRouter(
      <>
        <AgentNavigation workspaceId="session-reactive" />
        <AgentsDirectoryContent workspaceId="session-reactive" agents={[]} />
      </>,
    )

    expect(await screen.findByTestId('agent-navigation-empty')).toHaveTextContent('No agents yet')
    await user.click(screen.getByRole('button', { name: 'Add agent' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Gamma Agent')
    await user.click(screen.getByRole('button', { name: 'Add local agent' }))

    const submenuAgent = await screen.findByRole('link', { name: 'Gamma Agent' })
    expect(submenuAgent).toBeVisible()
    const createdAgent = useAgentDirectoryStore.getState().catalogs['session-reactive']?.localAgents[0]
    if (!createdAgent) throw new Error('Reactive local agent missing from store')
    useAgentDirectoryStore.getState().deleteAgent('session-reactive', createdAgent.id)
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Gamma Agent' })).not.toBeInTheDocument())
    expect(screen.getByTestId('agent-navigation-empty')).toHaveTextContent('No agents yet')
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

  it('closes the add modal when the agent detail surface takes over', async () => {
    const user = userEvent.setup()
    const view = render(<AgentsDirectoryContent workspaceId="workspace-1" agents={agents} />)
    await user.click(screen.getByRole('button', { name: 'Add agent' }))
    expect(screen.getByRole('dialog', { name: 'Add a local agent' })).toBeVisible()

    view.rerender(
      <AgentsDirectoryContent
        workspaceId="workspace-1"
        agents={agents}
        selectedAgentId="agent-researcher"
        onClearAgent={() => {}}
      />,
    )

    expect(screen.queryByRole('dialog', { name: 'Add a local agent' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Researcher' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close agent details' })).toHaveFocus()
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

  it('reorders cards with the accessible keyboard path and keeps order per workspace', async () => {
    const user = userEvent.setup()
    const view = render(<AgentsDirectoryContent workspaceId="workspace-1" agents={reorderAgents} />)
    const researcher = screen.getByRole('button', { name: 'Researcher, researcher, Available' })

    researcher.focus()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')

    const cards = [...document.querySelectorAll<HTMLElement>('[data-agent-id]')]
    expect(cards.map((card) => card.dataset.agentId)).toEqual([
      'agent-builder',
      'agent-researcher',
      'agent-reviewer',
    ])
    expect(screen.getByTestId('agent-reorder-announcement')).toHaveTextContent(
      'Moved Researcher to position 2 of 3',
    )

    view.unmount()
    render(<AgentsDirectoryContent workspaceId="workspace-1" agents={reorderAgents} />)
    expect([...document.querySelectorAll<HTMLElement>('[data-agent-id]')].map((card) => card.dataset.agentId)).toEqual([
      'agent-builder',
      'agent-researcher',
      'agent-reviewer',
    ])
  })

  it('distinguishes a pointer drag from a click and announces the committed order', () => {
    const rects = new Map<Element, DOMRect>()
    const cardRects = [
      ['agent-researcher', 100],
      ['agent-builder', 160],
      ['agent-reviewer', 220],
    ] as const
    const makeRect = (top: number, height = 50) => ({
      x: 0,
      y: top,
      top,
      left: 0,
      width: 260,
      height,
      right: 260,
      bottom: top + height,
      toJSON: () => ({}),
    }) as DOMRect
    const onSelect = vi.fn()
    render(<AgentsDirectoryContent workspaceId="workspace-1" agents={reorderAgents} onSelectAgent={onSelect} />)
    const list = document.querySelector('.agent-directory-grid')
    if (!list) throw new Error('Agent grid missing')
    rects.set(list, makeRect(100, 170))
    for (const [id, top] of cardRects) {
      const card = document.querySelector(`[data-agent-id="${id}"]`)
      if (card) rects.set(card, makeRect(top))
    }
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return rects.get(this) ?? makeRect(0, 0)
    })
    const source = document.querySelector<HTMLButtonElement>('[data-agent-id="agent-reviewer"]')
    if (!source) throw new Error('Reviewer card missing')

    fireEvent.pointerDown(source, {
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 20,
      clientY: 240,
    })
    fireEvent.pointerMove(window, {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 20,
      clientY: 180,
      buttons: 1,
    })
    fireEvent.pointerMove(window, {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 20,
      clientY: 110,
      buttons: 1,
    })
    fireEvent.pointerUp(window, {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 20,
      clientY: 110,
    })

    expect([...document.querySelectorAll<HTMLElement>('[data-agent-id]')].map((card) => card.dataset.agentId)).toEqual([
      'agent-reviewer',
      'agent-researcher',
      'agent-builder',
    ])
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByTestId('agent-reorder-announcement')).toHaveTextContent(
      'Moved Reviewer to position 1 of 3',
    )
  })
})
