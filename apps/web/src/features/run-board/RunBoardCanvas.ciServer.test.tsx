import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CiRunJob } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { RunBoardCanvas } from './RunBoardCanvas'
import { runA } from './testFixtures'
import { installFlowLayout } from './testFlowLayout'

const ticketId = '00000000-0000-4000-8000-000000000001'
const job: CiRunJob = { ticketId, scope: 'affected', placement: 'host', message: null,
  tests: { passed: 0, failed: 1, skipped: 0 },
  requester: { executionId: 'execution', agentId: 'agent-x', nodeId: 'node-x', nodeName: 'X before rename' },
  ci: { id: ticketId, groupId: '00000000-0000-4000-8000-000000000002', suite: 'unit', part: 'unit-api',
    partition: null, state: 'failed', exitCode: 1, computer: null, step: null,
    queuedAt: '2026-10-01T00:00:00.000Z', startedAt: '2026-10-01T00:00:01.000Z',
    finishedAt: '2026-10-01T00:00:02.000Z' } }

beforeEach(() => {
  installFlowLayout()
  server.use(http.get('*/api/management/workspaces/:workspaceId/runs/:runId/subagents', () =>
    HttpResponse.json({ items: [], nextCursor: null, projection: 'caught-up' })))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><RunBoardCanvas snapshot={runA} /></QueryClientProvider>)
}

it('shows the CI server on a saved Run Board and opens the Run CI jobs', async () => {
  server.use(http.get('*/api/management/workspaces/:workspaceId/ci', ({ request }) =>
    HttpResponse.json({ runId: new URL(request.url).searchParams.get('runId'), jobs: [job], truncated: false })))
  mount()
  await userEvent.click(await screen.findByRole('button', { name: /^CI server, .*Open CI jobs/ }))
  const dialog = await screen.findByRole('dialog', { name: 'CI server' })
  expect(await within(dialog).findByRole('button', { name: 'Show tests of unit · unit-api requested by X before rename' })).toBeVisible()
})

it('keeps the CI server on a saved Run Board when CI cannot be read', async () => {
  server.use(http.get('*/api/management/workspaces/:workspaceId/ci', () =>
    HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'CI read denied' } }, { status: 403 })))
  mount()
  expect(await screen.findByRole('button', { name: /^CI server, CI unavailable/ })).toBeVisible()
})
