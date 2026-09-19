import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkflowDirectory } from './WorkflowDirectory'

afterEach(() => {
  sessionStorage.clear()
})

describe('WorkflowDirectory', () => {
  it('lists durable workflows as directory cards', async () => {
    renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" />)

    expect(
      within(await screen.findByTestId('workflow-card-workflow-content-pipeline'))
        .getByRole('link', { name: 'Research to review' }),
    ).toHaveAttribute('href', expect.stringContaining('workflowId=workflow-content-pipeline'))
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
