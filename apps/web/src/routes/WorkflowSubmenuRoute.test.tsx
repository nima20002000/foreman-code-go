import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { routeTree } from '../app/router'
import { setMockScenario } from '../shared/mocks/scenarios'

function renderRoute(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  }
}

describe('workflow submenu route integration', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })

  afterEach(() => {
    setMockScenario('normal')
    sessionStorage.clear()
  })

  it('mounts the nested workflow submenu on workspace section routes', async () => {
    renderRoute('/workspaces/workspace-1/agents')

    const submenu = await screen.findByRole('region', { name: 'Workspace workflows' }, { timeout: 5000 })
    expect(within(submenu).getByRole('button', { name: 'New workflow' })).toBeVisible()
    const link = await within(submenu).findByRole('link', { name: 'Research to review' }, { timeout: 5000 })
    expect(link).toHaveAttribute('href', expect.stringContaining('workflowId=workflow-content-pipeline'))
  })

  it('keeps New workflow visible when the workspace has no workflows', async () => {
    setMockScenario('empty')
    renderRoute('/workspaces/workspace-1')

    expect(await screen.findByTestId('workflow-navigation-empty')).toBeVisible()
    expect(within(screen.getByRole('region', { name: 'Workspace workflows' })).getByRole('button', { name: 'New workflow' })).toBeVisible()
  })

  it('marks the URL-selected workflow active on the graph route', async () => {
    renderRoute('/workspaces/workspace-1?workflowId=workflow-content-pipeline')

    const link = await screen.findByRole('link', { name: 'Research to review' })
    expect(link).toHaveAttribute('aria-current', 'page')
  })
})
