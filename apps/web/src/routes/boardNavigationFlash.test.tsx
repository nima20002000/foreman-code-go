import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { routeTree } from '../app/router'
import { setMockScenario } from '../shared/mocks/scenarios'

beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver })
afterEach(() => setMockScenario('normal'))

it.each(['/workspaces/workspace-1/workflows', '/workspaces/workspace-1/agents', '/workspaces'])(
  'leaves the board for %s without flashing an invalid board selection', async (destination) => {
    const history = createMemoryHistory({ initialEntries: ['/workspaces/workspace-1?workflowId=workflow-content-pipeline'] })
    const router = createRouter({ routeTree, history })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const flashes: string[] = []
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && node.textContent?.includes('Invalid board selection')) flashes.push(destination)
      }
    })
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
    expect((await screen.findAllByText('Researcher', {}, { timeout: 8000 })).length).toBeGreaterThan(0)
    observer.observe(document.body, { childList: true, subtree: true })
    await act(async () => { history.push(destination) })
    await waitFor(() => expect(router.state.location.pathname).toBe(destination))
    await waitFor(() => {
      expect(router.state.status).toBe('idle')
      expect(screen.queryByTestId('unified-workflow-board')).not.toBeInTheDocument()
    })
    observer.disconnect()
    expect(flashes).toEqual([])
    client.clear()
  }, 30_000)

it('still explains a board link that is invalid', async () => {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/workspaces/workspace-1?selectedRunId=run-1'] }) })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  expect(await screen.findByText('Invalid board selection', {}, { timeout: 8000 })).toBeVisible()
  client.clear()
})
