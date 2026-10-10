import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import type { ManagedWorkspace } from '@foreman-code/contracts/management'
import { WorkspaceRepositoryAddInputSchema, type WorkspaceRepositoryAddInput,
  type WorkspaceRepositoryReadResult } from '@foreman-code/contracts/workspace-git'

import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { mainRoot } from '../settings/workspaceBoundLocation.fixtures'
import { worktreeFixture } from '../workflow-board/worktree.fixtures'
import { WorkspaceDetailPage } from './WorkspaceDetailPage'

describe('workspace settings actions', () => {
  it('waits for workspace identity before mounting the section navigation and actions', async () => {
    let finishRead!: () => void
    const pending = new Promise<void>((resolve) => { finishRead = resolve })
    server.use(http.get('/api/management/workspaces/workspace-1', async () => {
      await pending
      return undefined
    }))
    renderWithRouter(<WorkspaceDetailPage workspaceId="workspace-1" section="settings" />)

    expect(await screen.findByText('Loading workspace…')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Workspace sections' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Workspace actions' })).not.toBeInTheDocument()
    finishRead()
    expect(await screen.findByRole('navigation', { name: 'Workspace sections' })).toBeVisible()
    expect(screen.getByRole('group', { name: 'Workspace actions' })).toBeVisible()
  })

  it('uses one label per action without repeating the workspace identity or settings heading', async () => {
    renderWithRouter(<WorkspaceDetailPage workspaceId="workspace-1" section="settings" />)

    const actions = within(await screen.findByRole('group', { name: 'Workspace actions' }))
    expect(actions.getAllByRole('button')).toHaveLength(3)
    expect(actions.getByRole('button', { name: 'Rename workspace' })).toBeEnabled()
    expect(actions.getByRole('button', { name: 'Choose location' })).toBeEnabled()
    expect(actions.getByRole('button', { name: 'Remove workspace' })).toBeEnabled()
    expect(screen.getAllByText('Website')).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Workspace settings' })).not.toBeInTheDocument()
    expect(screen.queryByText('Name', { exact: true })).not.toBeInTheDocument()
  })

  it('keeps the existing persisted rename and removal confirmation flows', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceDetailPage workspaceId="workspace-1" section="settings" />)
    const actions = within(await screen.findByRole('group', { name: 'Workspace actions' }))

    await user.click(actions.getByRole('button', { name: 'Rename workspace' }))
    const input = screen.getByRole('textbox', { name: 'Workspace name' })
    await user.clear(input)
    await user.type(input, 'Settings action rename')
    await user.click(screen.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByRole('button', { name: 'Rename workspace Settings action rename' })).toBeVisible()

    await user.click(actions.getByRole('button', { name: 'Remove workspace' }))
    const removal = screen.getByRole('dialog', { name: 'Remove Settings action rename?' })
    expect(removal).toHaveTextContent('Existing folders you selected are kept.')
    await user.click(within(removal).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename workspace Settings action rename' })).toBeVisible()
  })

  it('opens the same folder selection from the body and compact header location controls', async () => {
    server.use(
      http.get('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json({
        evidence: 'legacy_missing', workspaceId: 'workspace-1', locationRevision: 0,
        executionLocation: { runnerId: 'original-runner', rootPath: '/previous' },
      })),
      http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({
        workspaceId: 'workspace-1', readiness: 'metadata-only', policies: [], allowlists: [mainRoot],
      })),
    )
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceDetailPage workspaceId="workspace-1" section="settings" />)
    await user.click(await screen.findByLabelText('Execution location', { selector: 'button' }))
    const title = within(await screen.findByRole('dialog')).getByRole('heading').textContent!
    await user.keyboard('{Escape}')
    await user.click(within(await screen.findByRole('group', { name: 'Workspace actions' })).getByRole('button', { name: 'Choose location' }))

    expect(await screen.findByRole('dialog', { name: title })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows a denied read and retries before exposing workspace actions', async () => {
    let fail = true
    server.use(http.get('/api/management/workspaces/workspace-1', () => fail
      ? HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Workspace access denied.' } }, { status: 403 })
      : undefined))
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceDetailPage workspaceId="workspace-1" section="settings" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace access denied.')
    expect(screen.queryByRole('group', { name: 'Workspace actions' })).not.toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByRole('group', { name: 'Workspace actions' })).toBeVisible())
  })

  it('adds the GitHub project whose worktrees the agents will use', async () => {
    const user = userEvent.setup()
    const project = worktreeFixture()
    const bodies: WorkspaceRepositoryAddInput[] = []
    let workspace: ManagedWorkspace = {
      workspace: { id: 'workspace-1', name: 'Website' }, revision: 1, archivedAt: null,
      executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' },
    }
    let status: WorkspaceRepositoryReadResult = {
      workspaceId: 'workspace-1', state: 'unconfigured', repository: null, revision: 1,
    }
    server.use(
      http.get('/api/management/workspaces/workspace-1', () => HttpResponse.json(workspace)),
      http.get('/api/management/workspaces/workspace-1/repository', () => HttpResponse.json(status)),
      http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({
        workspaceId: 'workspace-1', readiness: 'metadata-only', policies: [], allowlists: [mainRoot],
      })),
      http.post('/api/management/workspaces/workspace-1/repository/add', async ({ request }) => {
        const input = WorkspaceRepositoryAddInputSchema.parse(await request.json())
        bodies.push(input)
        status = { ...project.ready, operation: { ...project.ready.operation!, commandId: input.commandId } }
        workspace = { ...workspace, revision: status.revision,
          workspace: { ...workspace.workspace, repository: input.repository } }
        return HttpResponse.json({ value: status, replayed: false })
      }),
    )
    const view = renderWithRouter(<WorkspaceDetailPage workspaceId="workspace-1" section="settings" />)
    const section = within(await screen.findByRole('region', { name: 'GitHub repository' }))
    const save = section.getByRole('button', { name: 'Add project' })
    await user.type(section.getByRole('textbox', { name: 'Repository' }), 'not a repo')
    expect(section.getByText('Use owner/name or a GitHub repository URL without extra path segments.')).toBeVisible()
    expect(save).toBeDisabled()
    await user.clear(section.getByRole('textbox', { name: 'Repository' }))
    await user.type(section.getByRole('textbox', { name: 'Repository' }), 'https://github.com/octo-owner/website.git')
    await waitFor(() => expect(save).toBeEnabled())
    await user.click(save)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ repository: { provider: 'github', owner: 'octo-owner', name: 'website', defaultBranch: 'main' } })
    expect(await section.findByText('Project ready')).toBeVisible()
    view.unmount()
    view.queryClient.clear()
    renderWithRouter(<WorkspaceDetailPage workspaceId="workspace-1" section="settings" />)
    expect(await screen.findByText('Project ready')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Repository' })).toHaveValue('octo-owner/website')
    expect(bodies).toHaveLength(1)
  })
})
