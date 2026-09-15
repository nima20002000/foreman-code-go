import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { renderWithRouter } from '../../test/renderWithRouter'
import { useWorkspaceSessionStore } from '../workspaces/workspaceSessionStore'
import { WorkflowDirectory } from './WorkflowDirectory'
import { useSessionWorkflowStore } from './sessionWorkflowStore'

afterEach(() => {
  useWorkspaceSessionStore.getState().reset()
  useSessionWorkflowStore.getState().clearSessionWorkflows()
  sessionStorage.clear()
})

describe('WorkflowDirectory', () => {
  it('lists saved and session workflows as directory cards', async () => {
    const draft = useSessionWorkflowStore.getState().createSessionWorkflow({
      workspaceId: 'workspace-1',
      name: 'Draft flow',
    })
    renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" />)

    expect(
      within(await screen.findByTestId('workflow-card-workflow-content-pipeline'))
        .getByRole('link', { name: 'Research to review' }),
    ).toHaveAttribute('href', expect.stringContaining('workflowId=workflow-content-pipeline'))
    expect(
      within(screen.getByTestId(`workflow-card-${draft.id}`))
        .getByRole('link', { name: 'Draft flow' }),
    ).toBeVisible()
  })

  it('renames and removes workflows from card actions', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" />)

    await user.click(await screen.findByRole('button', { name: 'Open actions for Research to review' }))
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Review flow')
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    expect(await screen.findByTestId('workflow-card-workflow-content-pipeline')).toHaveTextContent('Review flow')

    await user.click(screen.getByRole('button', { name: 'Open actions for Review flow' }))
    await user.click(screen.getByRole('button', { name: 'Remove workflow' }))
    await waitFor(() => {
      expect(screen.queryByTestId('workflow-card-workflow-content-pipeline')).not.toBeInTheDocument()
    })
  })
})
