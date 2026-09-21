// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES, type DurableInteraction } from '@graphql/contracts'
import { ApprovalInbox } from './ApprovalInbox'
import { useApprovalInboxStore } from './approvalInboxStore'

const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), workspace: vi.fn() }))
const userApi = vi.hoisted(() => ({ detail: vi.fn(), response: vi.fn(), mutate: vi.fn() }))
vi.mock('../../shared/api/query', () => ({
  useInfiniteInteractionsQuery: api.list,
  useInteractionQuery: api.detail,
  useWorkspaceDetailsQuery: api.workspace,
}))
vi.mock('../../shared/api/userApprovals', () => ({
  useUserInteractionQuery: userApi.detail,
  useUserInteractionResponse: userApi.response,
}))
vi.mock('@tanstack/react-router', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return { Link: ({ children }: { children: import('react').ReactNode }) => React.createElement('a', { href: '/workflow' }, children) }
})

const base = NATIVE_INTERACTION_FIXTURES.codex
const humanA: DurableInteraction = { ...base, id: 'human-a', requestingAgentId: 'agent-a', approval: { handler: 'user' } }
const humanB: DurableInteraction = { ...base, id: 'human-b', requestingAgentId: 'agent-b', approval: { handler: 'user' }, request: { path: '/tmp/file', permission: 'write' } }
const orchestrator: DurableInteraction = { ...base, id: 'agent-review', requestingAgentId: 'agent-c', approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-o' } }
const queue = (items: DurableInteraction[]) => ({
  data: { pages: [{ items, nextCursor: null }] }, isPending: false, isError: false, isFetching: false,
  refetch: vi.fn(), hasNextPage: false, isFetchingNextPage: false, isFetchNextPageError: false,
})

beforeEach(() => {
  vi.clearAllMocks()
  useApprovalInboxStore.setState({ open: false, workspaceId: '', workflowId: undefined, interactionId: undefined })
  api.list.mockReturnValue(queue([humanA, humanB, orchestrator]))
  api.workspace.mockReturnValue({ data: { workspace: { id: base.workspaceId, name: 'Workspace' }, workflows: [{ id: base.workflowId, name: 'Workflow' }], agents: [
    { id: 'agent-a', name: 'Builder', role: 'Coder', harness: 'codex', model: 'gpt-5', status: 'waiting', description: 'Builds the implementation.' },
    { id: 'agent-b', name: 'Tester' }, { id: 'agent-c', name: 'Orchestrator worker' },
  ] }, isError: false })
  api.detail.mockImplementation((id: string) => ({ data: { interaction: id === humanB.id ? humanB : humanA, canRespond: true }, isPending: false, isError: false, isFetching: false, refetch: vi.fn() }))
  userApi.detail.mockReturnValue({ data: { interaction: humanA, canRespond: true }, isPending: false, isError: false, refetch: vi.fn() })
  userApi.response.mockReturnValue({ mutate: userApi.mutate, isPending: false, isError: false })
})
afterEach(cleanup)

describe('floating human approval inbox', () => {
  it('stays on the board, shows all pending human requests, and opens a minimal agent profile', async () => {
    const user = userEvent.setup()
    useApprovalInboxStore.setState({ interactionId: 'stale-request' })
    useApprovalInboxStore.getState().openInbox({ workspaceId: base.workspaceId, workflowId: base.workflowId })
    expect(useApprovalInboxStore.getState().interactionId).toBeUndefined()
    render(<ApprovalInbox />)
    const panel = screen.getByRole('dialog', { name: 'Human approval inbox' })
    expect(within(panel).getByRole('button', { name: 'View agent: Builder' })).toBeVisible()
    expect(within(panel).getByRole('button', { name: 'View agent: Tester' })).toBeVisible()
    expect(within(panel).queryByText('Orchestrator worker')).not.toBeInTheDocument()
    expect(api.list).toHaveBeenCalledWith({ workspaceId: base.workspaceId, workflowId: base.workflowId, status: 'pending', limit: 100 }, true)
    expect(within(panel).queryByRole('button', { name: /Refresh/ })).not.toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'View agent: Builder' }))
    const profile = await screen.findByRole('dialog', { name: 'Builder' })
    expect(profile).toHaveTextContent('Coder · Codex · gpt-5')
    expect(profile).toHaveTextContent('Builds the implementation.')
    expect(useApprovalInboxStore.getState().open).toBe(true)
  })

  it('offers request-scoped quick approval and the native reject choice on the left of each row', async () => {
    const user = userEvent.setup()
    useApprovalInboxStore.getState().openInbox({ workspaceId: base.workspaceId })
    render(<ApprovalInbox />)
    const row = screen.getAllByRole('button', { name: 'Run a command' })[0]!.closest('li')!
    await user.click(within(row).getByRole('button', { name: 'Accept' }))
    expect(userApi.mutate).toHaveBeenCalledWith({ interactionId: humanA.id, optionId: 'codex-approve-once', expectedRevision: humanA.revision }, expect.any(Object))
    expect(within(row).getByRole('button', { name: 'Reject' })).toHaveAttribute('title', expect.stringContaining('This request only'))
    expect(within(row).queryByText('/project')).not.toBeInTheDocument()
  })

  it('opens details in a separate centered dialog and outside-click closes only the detail', async () => {
    const user = userEvent.setup()
    useApprovalInboxStore.getState().openInbox({ workspaceId: base.workspaceId })
    render(<ApprovalInbox />)
    await user.click(screen.getAllByRole('button', { name: 'Run a command' })[0]!)
    const detail = await screen.findByRole('dialog', { name: 'Run a command' })
    expect(detail).toBeVisible()
    expect(within(detail).getByText(/Requested by/)).toHaveTextContent('Builder')
    expect(within(detail).queryByText('Technical details')).not.toBeInTheDocument()
    expect(within(detail).queryByText('Workspace ID')).not.toBeInTheDocument()
    fireEvent.pointerDown(detail)
    fireEvent.click(detail)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Run a command' })).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: 'Human approval inbox' })).toBeVisible()
    expect(useApprovalInboxStore.getState().open).toBe(true)
  })
})
