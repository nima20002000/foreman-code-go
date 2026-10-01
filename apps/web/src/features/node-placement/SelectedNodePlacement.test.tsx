import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { ApiError } from '../../shared/api/client'
import { beginSessionChange, finishSessionChange } from '../../shared/api/sessionBoundary'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { SelectedNodePlacement } from './SelectedNodePlacement'
import * as client from './client'
import { acceptedPlacementFixture as placement } from './fixtures'

const scope = { workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a', nodeId: 'node-a' }
function selection(id: number, current: () => boolean): SelectedRunState {
  return { identity: { workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId }, generation: { id }, active: true,
    invalid: false, isCurrent: current } as unknown as SelectedRunState
}
function result() { return { ...scope, readback: { evidence: 'accepted' as const, placement, observations: [] } } }
const clients: QueryClient[] = []
afterEach(() => { clients.splice(0).forEach((item) => item.clear()); vi.restoreAllMocks() })
function wrap() {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(query)
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={query}>{children}</QueryClientProvider>
}
it('fences late A→B→A reads by visit even when transport ignores abort', async () => {
  let visit = 1
  let release!: (value: ReturnType<typeof result>) => void
  const oldRead = new Promise<ReturnType<typeof result>>((resolve) => { release = resolve })
  const read = vi.spyOn(client, 'readNodePlacement').mockImplementationOnce(() => oldRead).mockResolvedValue({ ...scope, readback: { evidence: 'legacy_missing', originalMainInstallationId: null } })
  const view = render(<SelectedNodePlacement selection={selection(1, () => visit === 1)} nodeId="node-a" />, { wrapper: wrap() })
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  visit = 2
  view.rerender(<SelectedNodePlacement selection={selection(2, () => visit === 2)} nodeId="node-a" />)
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  visit = 3
  view.rerender(<SelectedNodePlacement selection={selection(3, () => visit === 3)} nodeId="node-a" />)
  await screen.findByText(/Computer evidence unavailable/)
  await act(async () => { release(result()); await oldRead })
  expect(screen.queryByText('Laptop at acceptance')).not.toBeInTheDocument()
})
it('withdraws private facts after a denied read', async () => {
  const read = vi.spyOn(client, 'readNodePlacement').mockResolvedValue(result())
  const view = render(<SelectedNodePlacement selection={selection(1, () => true)} nodeId="node-a" />, { wrapper: wrap() })
  await screen.findByText('Laptop at acceptance')
  read.mockRejectedValue(new ApiError({ code: 'DENIED', message: 'No access' }, 403))
  view.rerender(<SelectedNodePlacement selection={selection(2, () => true)} nodeId="node-a" />)
  await screen.findByText(/No access/)
  expect(screen.queryByText('Laptop at acceptance')).not.toBeInTheDocument()
})
it('a response from a prior Operator session cannot reveal placement', async () => {
  let release!: (value: ReturnType<typeof result>) => void
  const pending = new Promise<ReturnType<typeof result>>((resolve) => { release = resolve })
  const read = vi.spyOn(client, 'readNodePlacement').mockImplementation(() => pending)
  const view = render(<SelectedNodePlacement selection={selection(1, () => true)} nodeId="node-a" />, { wrapper: wrap() })
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  beginSessionChange()
  await act(async () => { release(result()); await pending })
  view.rerender(<SelectedNodePlacement selection={selection(1, () => true)} nodeId="node-a" />)
  expect(screen.queryByText('Laptop at acceptance')).not.toBeInTheDocument()
  finishSessionChange()
})
