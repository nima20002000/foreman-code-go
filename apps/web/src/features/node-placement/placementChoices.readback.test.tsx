import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { usePlacementChoices } from './usePlacementChoices'
import { savedPlacementFixture as placement } from './fixtures'

const scope = { workspaceId: 'workspace-a', workflowId: 'workflow-a', nodeId: 'node-a',
  agentConfigurationVersionId: 'configuration-old' }
const clients: QueryClient[] = []
afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.useRealTimers() })
function Choices() {
  const query = usePlacementChoices(scope, 'visit-a')
  return <><span>{query.isSuccess ? 'Choices loaded' : 'Loading choices'}</span><select aria-label="Computer">{query.options.map(option => <option key={option.label}
    disabled={Boolean(option.unavailableReason)}>{option.label}: {option.unavailableReason ?? 'Ready'}</option>)}</select></>
}

it.each(['unavailable', 'omitted', 'ready'] as const)(
  'refreshes a mounted %s choice when Worker readiness changes', async initial => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let ready = initial === 'ready'
    let reads = 0
    server.use(http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/nodes/:nodeId/placement-choices', () => {
      reads++
      const choices = initial === 'omitted' && !ready ? [] : [{ id: 'choice-a', label: 'Paired computer', placement,
        availability: ready ? 'ready' : 'unavailable', reason: ready ? null : 'Worker qualification pending' }]
      return HttpResponse.json({ ...scope, choices })
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    render(<QueryClientProvider client={client}><Choices /></QueryClientProvider>)
    if (initial === 'omitted') {
      await screen.findByText('Choices loaded')
    } else {
      await screen.findByRole('option', { name: ready ? 'Paired computer: Ready' : /qualification pending/ })
    }
    expect(reads).toBe(1)
    ready = !ready
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    const option = await screen.findByRole('option', { name: ready ? 'Paired computer: Ready' : /qualification pending/ })
    if (ready) expect(option).toBeEnabled()
    else expect(option).toBeDisabled()
  },
)
