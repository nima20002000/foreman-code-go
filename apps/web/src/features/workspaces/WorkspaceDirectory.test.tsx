import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { renderWithRouter } from '../../test/renderWithRouter'
import { useAgentDirectoryStore } from '../agents/agentDirectoryStore'
import { writeLocalAgents } from '../agents/localAgents'
import { useSessionWorkflowStore } from '../workflows/sessionWorkflowStore'
import { useNavigationUiStore } from './navigationUiStore'
import { WorkspaceDirectory } from './WorkspaceDirectory'
import { useWorkspaceSessionStore } from './workspaceSessionStore'

afterEach(() => {
  useWorkspaceSessionStore.getState().reset()
  useSessionWorkflowStore.getState().clearSessionWorkflows()
  useAgentDirectoryStore.getState().reset()
  useNavigationUiStore.getState().reset()
  sessionStorage.clear()
})

describe('WorkspaceDirectory', () => {
  it('lists server and session workspaces as simple cards', async () => {
    const scratch = useWorkspaceSessionStore.getState().createWorkspace('Scratch')
    renderWithRouter(<WorkspaceDirectory />)

    expect(
      within(await screen.findByTestId('workspace-card-workspace-1'))
        .getByRole('link', { name: 'Website' }),
    ).toBeVisible()
    expect(
      within(screen.getByTestId(`workspace-card-${scratch.id}`))
        .getByRole('link', { name: 'Scratch' }),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Open actions for Website' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Open actions for Scratch' })).toBeVisible()
  })

  it('deletes a workspace card and its session-owned child state', async () => {
    const user = userEvent.setup()
    const workspace = useWorkspaceSessionStore.getState().createWorkspace('Scratch')
    useSessionWorkflowStore.getState().createSessionWorkflow({
      workspaceId: workspace.id,
      name: 'Scratch flow',
    })
    writeLocalAgents(workspace.id, [{ id: 'agent-scratch', name: 'Scratch agent' }])
    useAgentDirectoryStore.getState().hydrateWorkspace(workspace.id)
    useNavigationUiStore.getState().rememberWorkspace(workspace.id)
    renderWithRouter(<WorkspaceDirectory />)

    await user.click(await screen.findByRole('button', { name: 'Open actions for Scratch' }))
    await user.click(screen.getByRole('button', { name: 'Remove workspace' }))

    await waitFor(() => expect(screen.queryByTestId(`workspace-card-${workspace.id}`)).not.toBeInTheDocument())
    expect(useWorkspaceSessionStore.getState().workspaces).toEqual([])
    expect(Object.values(useSessionWorkflowStore.getState().workflows)).toEqual([])
    expect(useAgentDirectoryStore.getState().catalogs[workspace.id]).toBeUndefined()
    expect(sessionStorage.getItem(`graphql-local-agents:${workspace.id}`)).toBeNull()
    expect(useNavigationUiStore.getState().activeWorkspaceId).toBeUndefined()
  })

  it('shows an actionable empty state after every card is removed', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceDirectory />)

    await user.click(await screen.findByRole('button', { name: 'Open actions for Website' }))
    await user.click(screen.getByRole('button', { name: 'Remove workspace' }))

    expect(await screen.findByTestId('workspace-directory-empty')).toHaveTextContent(
      'Use New workspace in the navigation',
    )
  })

  it('renames a workspace from its three-dot actions', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceDirectory />)

    await user.click(await screen.findByRole('button', { name: 'Open actions for Website' }))
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Docs')
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    expect(await screen.findByTestId('workspace-card-workspace-1')).toHaveTextContent('Docs')
  })
})
