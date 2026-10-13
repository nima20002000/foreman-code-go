import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { routeTree } from '../app/router'
import { useGraphDraftStore } from '../features/graph/store'
import { installFlowLayout } from '../features/run-board/testFlowLayout'
import { setMockScenario } from '../shared/mocks/scenarios'
import { installBrowserLocks } from '../test/browserLocks'

beforeEach(() => {
  sessionStorage.clear()
  useGraphDraftStore.getState().clearAllDrafts()
  installBrowserLocks()
  installFlowLayout(1000, 720)
})
afterEach(() => {
  cleanup()
  useGraphDraftStore.getState().clearAllDrafts()
  setMockScenario('normal')
  vi.unstubAllGlobals()
})

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
    const authoring = await screen.findByRole('region', { name: 'Workflow authoring' }, { timeout: 8000 })
    expect(within(authoring).getByRole('heading', { name: 'Research to review' })).toBeVisible()
    const canvas = within(authoring).getByLabelText('Editable workflow graph')
    expect(await within(canvas).findByRole('button', { name: /^Researcher,/ }, { timeout: 8000 })).toBeVisible()
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
