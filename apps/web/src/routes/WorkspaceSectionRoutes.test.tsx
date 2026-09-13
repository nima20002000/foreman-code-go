import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { routeTree } from '../app/router'
import { setMockScenario } from '../shared/mocks/scenarios'

function renderRoute(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  setMockScenario('normal')
  sessionStorage.clear()
})

describe('workspace section routes', () => {
  it('deep-links to the agents directory and marks its navigation active', async () => {
    renderRoute('/workspaces/workspace-1/agents')

    expect(await screen.findByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: 'Researcher' })).toBeVisible()
  })

  it('shows an honest error state when the agents request fails', async () => {
    setMockScenario('error')
    renderRoute('/workspaces/workspace-1/agents')

    expect(await screen.findByTestId('agents-error')).toHaveTextContent('selected mock scenario fails read requests')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  it('deep-links unimplemented destinations to conventional coming-soon pages', async () => {
    renderRoute('/workspaces/workspace-1/terminal')

    expect(await screen.findByRole('heading', { name: 'Terminal' })).toBeVisible()
    expect(screen.getByTestId('coming-soon')).toHaveTextContent('Coming soon')
    expect(screen.getByRole('link', { name: 'Terminal' })).toHaveAttribute('aria-current', 'page')
  })

  it('places Browsers under Settings and preserves its deep link', async () => {
    renderRoute('/workspaces/workspace-1/browsers')

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
    expect(screen.getByRole('link', { name: /Browsers/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: 'Browsers' })).toBeVisible()
    expect(screen.getAllByText('Coming soon')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
  })
})
