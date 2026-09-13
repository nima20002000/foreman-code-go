import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

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

afterEach(() => {
  setMockScenario('normal')
  sessionStorage.clear()
})

describe('workspace section routes', () => {
  it('deep-links to the agents directory and marks its navigation active', async () => {
    const { router } = renderRoute('/workspaces/workspace-1/agents?agentId=agent-researcher')

    expect(await screen.findByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: /Researcher, researcher, Available/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('dialog', { name: 'Researcher' })).toBeVisible()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close agent details' }))
    await waitFor(() => expect(router.state.location.search).toEqual({}))

    const developer = screen.getByRole('button', { name: /Developer, developer, Available/ })
    developer.focus()
    await userEvent.setup().keyboard('{Enter}')
    await waitFor(() => expect(router.state.location.search).toMatchObject({ agentId: 'agent-developer' }))
    expect(developer).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('dialog', { name: 'Developer' })).toBeVisible()
  })

  it('handles an unknown agent deep link honestly and clears it from the close control', async () => {
    const { router } = renderRoute('/workspaces/workspace-1/agents?agentId=agent-missing')

    expect(await screen.findByRole('dialog', { name: 'Agent unavailable' })).toHaveTextContent(
      'not available in the current workspace or browser session',
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close agent details' }))
    await waitFor(() => expect(router.state.location.search).toEqual({}))
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
