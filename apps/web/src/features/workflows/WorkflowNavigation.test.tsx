import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { UrlSearchSelectionSchema } from '@graphql/contracts'

import { setMockScenario } from '../../shared/mocks/scenarios'
import { useWorkspaceSessionStore } from '../workspaces/workspaceSessionStore'
import { WorkflowNavigation } from './WorkflowNavigation'

function renderNavigation(activeWorkflowId?: string, workspaceId = 'workspace-1') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <WorkflowNavigation workspaceId={workspaceId} activeWorkflowId={activeWorkflowId} />
        <Outlet />
      </>
    ),
  })
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workspaces/$workspaceId',
    validateSearch: UrlSearchSelectionSchema,
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([workspaceRoute]),
    history: createMemoryHistory({ initialEntries: [`/workspaces/${workspaceId}`] }),
  })

  return {
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  }
}

afterEach(() => {
  setMockScenario('normal')
  useWorkspaceSessionStore.getState().reset()
})

describe('WorkflowNavigation', () => {
  it('lists the workspace workflows and marks the URL-selected workflow', async () => {
    renderNavigation('workflow-content-pipeline')

    const link = await screen.findByRole('link', { name: 'Research to review' })
    expect(screen.getByRole('region', { name: 'Workspace workflows' })).toBeVisible()
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(link).toHaveAttribute('href', expect.stringContaining('workflowId=workflow-content-pipeline'))
    expect(screen.getByRole('button', { name: 'New workflow' })).toBeVisible()
  })

  it('does not mark a workflow active without a URL selection', async () => {
    renderNavigation()

    const link = await screen.findByRole('link', { name: 'Research to review' })
    expect(link).not.toHaveAttribute('aria-current')
  })

  it('selects a workflow through the URL', async () => {
    const user = userEvent.setup()
    const { router } = renderNavigation()

    await user.click(await screen.findByRole('link', { name: 'Research to review' }))

    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ workflowId: 'workflow-content-pipeline' }),
    )
  })

  it('clears an agent selection when workflow identity changes', async () => {
    const user = userEvent.setup()
    const { router } = renderNavigation()
    await router.navigate({
      to: '/workspaces/$workspaceId',
      params: { workspaceId: 'workspace-1' },
      search: { agentId: 'agent-researcher' },
    })

    await user.click(await screen.findByRole('link', { name: 'Research to review' }))

    await waitFor(() => {
      expect(router.state.location.search.workflowId).toBe('workflow-content-pipeline')
      expect(router.state.location.search.agentId).toBeUndefined()
    })
  })

  it('keeps New workflow visible when the workspace has no workflows', async () => {
    setMockScenario('empty')
    renderNavigation()

    expect(await screen.findByTestId('workflow-navigation-empty')).toHaveTextContent('No workflows yet')
    expect(screen.getByRole('button', { name: 'New workflow' })).toBeVisible()
  })

  it('keeps New workflow visible when workflows cannot be loaded', async () => {
    setMockScenario('error')
    renderNavigation()

    expect(await screen.findByTestId('workflow-navigation-error')).toHaveTextContent('Workflows unavailable')
    expect(screen.getByRole('button', { name: 'New workflow' })).toBeVisible()
  })

  it('opens a compact creation dialog and creates a session workflow', async () => {
    const user = userEvent.setup()
    renderNavigation()
    const trigger = await screen.findByRole('button', { name: 'New workflow' })

    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'New workflow' })
    expect(dialog).toHaveTextContent('Start an empty workflow')
    expect(screen.getByRole('button', { name: 'Create workflow' })).toBeEnabled()

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Draft workflow')
    await user.click(screen.getByRole('button', { name: 'Create workflow' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('link', { name: /Draft workflow/ })).toBeVisible()
  })

  it('resolves an empty session workspace without a workflow request', async () => {
    const sessionWorkspace = useWorkspaceSessionStore.getState().createWorkspace('Scratch')
    renderNavigation(undefined, sessionWorkspace.id)

    expect(await screen.findByTestId('workflow-navigation-empty')).toHaveTextContent('No workflows yet')
    expect(screen.queryByText('Loading workflows…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New workflow' })).toBeVisible()
  })

  it('names the session workspace in its workflow creation dialog', async () => {
    const user = userEvent.setup()
    const sessionWorkspace = useWorkspaceSessionStore.getState().createWorkspace('Scratch')
    renderNavigation(undefined, sessionWorkspace.id)

    await user.click(await screen.findByRole('button', { name: 'New workflow' }))

    expect(await screen.findByRole('dialog', { name: 'New workflow' })).toHaveTextContent(
      'Start an empty workflow in Scratch',
    )
  })

  it('keeps inside presses open and dismisses the creation dialog from its backdrop', async () => {
    const user = userEvent.setup()
    const { container } = renderNavigation()
    const trigger = await screen.findByRole('button', { name: 'New workflow' })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'New workflow' })

    fireEvent.mouseDown(dialog)
    expect(screen.getByRole('dialog', { name: 'New workflow' })).toBeVisible()

    const backdrop = container.querySelector('.workflow-create-backdrop')
    if (!backdrop) throw new Error('Create-workflow backdrop missing')
    fireEvent.mouseDown(backdrop)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})
