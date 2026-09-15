import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Agent } from '@graphql/contracts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { queryKeys } from '../../shared/api/query'
import { AgentsDirectory } from './AgentsDirectory'
import { useAgentDirectoryStore } from './agentDirectoryStore'

const workspaceId = 'workspace-persistence'
const agent: Agent = {
  id: 'agent-persistence', name: 'Researcher', harness: 'codex', model: 'gpt-5.6-luna',
  effort: 'low', fastMode: false, configurationVersionId: 'configuration-v1',
}
const details = {
  workspace: { id: workspaceId, name: 'Settings test', agentIds: [agent.id], workflowIds: [] },
  agents: [agent], workflows: [], runs: [], resources: [], runners: [],
}
let client: QueryClient
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
})
afterEach(() => {
  client.clear()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  useAgentDirectoryStore.getState().reset()
})

function directory() {
  render(<QueryClientProvider client={client}><AgentsDirectory workspaceId={workspaceId} /></QueryClientProvider>)
}

it('persists harness/model/effort changes and updates the server-owned cache instead of a local override', async () => {
  let submitted: Agent | undefined
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      submitted = JSON.parse(String(init.body)) as Agent
      return Response.json({ agent: { ...submitted, configurationVersionId: 'configuration-v2' } })
    }
    return Response.json(details)
  })
  vi.stubGlobal('fetch', fetch)
  directory()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Open actions for Researcher' }))
  const dialog = screen.getByRole('dialog', { name: 'Researcher actions' })
  await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Harness' }), 'opencode')
  await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Effort' }), 'max')
  await user.click(within(dialog).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(submitted).toMatchObject({ harness: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', effort: 'max', configurationVersionId: 'configuration-v1' })
  expect(client.getQueryData(queryKeys.agent(workspaceId, agent.id))).toMatchObject({ agent: { ...submitted, configurationVersionId: 'configuration-v2' } })
  expect(useAgentDirectoryStore.getState().catalogs[workspaceId]?.localAgents.some((entry) => entry.id === agent.id)).toBe(false)
})

it('keeps failed edits visible and does not claim they were saved locally', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'PUT'
    ? Response.json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Settings could not be persisted.' } }, { status: 503 })
    : Response.json(details)))
  directory()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Open actions for Researcher' }))
  const dialog = screen.getByRole('dialog', { name: 'Researcher actions' })
  await user.click(within(dialog).getByRole('checkbox', { name: 'Fast mode' }))
  await user.click(within(dialog).getByRole('button', { name: 'Save' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Settings could not be persisted.')
  expect(within(dialog).getByRole('checkbox', { name: 'Fast mode' })).toBeChecked()
  expect(useAgentDirectoryStore.getState().catalogs[workspaceId]?.localAgents.some((entry) => entry.id === agent.id)).toBe(false)
})
